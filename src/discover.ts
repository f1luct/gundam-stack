import type { Env } from './types';
import { UA } from './twitter';
import { ingestTweet } from './ingest';
import { composeCaption } from './db';
import { reviewTweet, shortBody } from './vision';

// 自动找帖：全部在 Worker 里跑，走 fxtwitter（关注作者拉时间线，标签走搜索），不碰任何 X 账号。
// 每次 tick（N150 每几分钟来敲一下，或 Cron）只做一小步，守住免费版 50 子请求：
//   1. 轮到的一个来源拉一次（一个关注作者的时间线，或一个标签的搜索）→ 合格的进 x_queue
//      搜索接口不稳（会成片 404），时间线接口稳得多，所以关注作者逐个拉、不拼 from: 查询
//   2. 从队列取 PER_TICK 条看图 + 入草稿
const STATE_KEY = 'sys:discover_state';
const PER_TICK = 2; // 每条 ≈ 看图 4 + 模型 1 + fx 1 + 存图 4
const KEEP_PER_SOURCE = 8; // 每次搜索最多留几条进队列
const TAG_MIN_LIKES = 100; // 标签噪音大，卡赞数；关注作者不卡
const MAX_AGE_MS = 7 * 24 * 3600 * 1000; // 画师一周才发一两张，48 小时太短
const MAX_ATTEMPTS = 3;
const REPOST_MIN_LIKES = 50; // 关注作者转发的别人的图：算发散来源，稍微卡一下赞数
const BACKOFF_KEY = 'sys:discover_backoff_until';
const BACKOFF_MS = 30 * 60 * 1000; // fxtwitter 回 429 就整体歇 30 分钟，不硬碰

interface Source {
  via: string; // 'list' 或标签本身
  url: string;
  minLikes: number;
}

const splitList = (s?: string) =>
  (s || '')
    .split(/[,\s]+/)
    .map((x) => x.trim().replace(/^@/, ''))
    .filter(Boolean);

function sources(env: Env): Source[] {
  const out: Source[] = [];
  const accounts = splitList(env.DISCOVER_ACCOUNTS);
  for (const a of accounts) {
    out.push({ via: 'list', url: `https://api.fxtwitter.com/2/profile/${encodeURIComponent(a)}/statuses`, minLikes: 0 });
  }
  for (const tag of splitList(env.DISCOVER_TAGS)) {
    const t = tag.startsWith('#') ? tag : '#' + tag;
    const q = `${t} filter:images -filter:retweets -filter:replies`;
    out.push({ via: t, url: `https://api.fxtwitter.com/2/search?q=${encodeURIComponent(q)}&feed=top`, minLikes: TAG_MIN_LIKES });
  }
  return out;
}

class RateLimited extends Error {}

async function gather(env: Env, src: Source, accounts: Set<string>): Promise<number> {
  const r = await fetch(src.url, { headers: { 'User-Agent': UA } });
  if (r.status === 429) throw new RateLimited(`被限流 (429): ${src.via}`);
  if (!r.ok) throw new Error(`拉取失败 (${r.status}): ${src.via}`);
  const j: any = await r.json();
  if (j.code === 429) throw new RateLimited(`被限流 (429): ${src.via}`);
  if (j.code && j.code !== 200) throw new Error(`拉取失败 (${j.code}): ${src.via}`);
  const cutoff = Date.now() - MAX_AGE_MS;
  const picks = (j.results || [])
    .filter((s: any) => !s.replying_to)
    // 转发：作者不在名单里的才要（名单里的人自己会轮到），这是发现新作者的入口
    .filter((s: any) => !s.reposted_by || (src.via === 'list' && !accounts.has(String(s.author?.screen_name || '').toLowerCase())))
    .filter((s: any) => (s.media?.photos || []).length)
    .filter((s: any) => Number(s.likes || 0) >= (s.reposted_by ? REPOST_MIN_LIKES : src.minLikes))
    .filter((s: any) => (s.created_timestamp ? s.created_timestamp * 1000 : Date.parse(s.created_at)) >= cutoff)
    .sort((a: any, b: any) => Number(b.likes || 0) - Number(a.likes || 0))
    .slice(0, KEEP_PER_SOURCE);

  return enqueueCandidates(
    env,
    picks.map((s: any) => ({
      id: String(s.id),
      url: s.url,
      author: s.author?.screen_name || '',
      bio: s.author?.description || '',
      text: s.text || '',
      likes: Number(s.likes || 0),
      media_urls: (s.media.photos as any[]).map((p) => p.url),
      via: s.reposted_by ? `rt:${s.reposted_by.screen_name}` : src.via,
    })),
  );
}

export interface Candidate {
  id: string;
  url: string;
  author: string;
  bio: string;
  text: string;
  likes: number;
  media_urls: string[];
  via: string;
}

// 候选进队列：见过的、已有卡片的不进；已在队列里的只刷新赞数。
// N150 用 opencli 搜标签的结果也走这里（/api/discover/enqueue）
export async function enqueueCandidates(env: Env, items: Candidate[]): Promise<number> {
  let added = 0;
  for (const payload of items) {
    const res = await env.DB.prepare(
      `INSERT INTO x_queue (source_id, payload, likes, via, queued_at)
       SELECT ?1, ?2, ?3, ?4, ?5
       WHERE NOT EXISTS (SELECT 1 FROM x_seen WHERE source_id = ?1)
         AND NOT EXISTS (SELECT 1 FROM cards WHERE source_type = 'twitter' AND source_id = ?1)
       ON CONFLICT(source_id) DO UPDATE SET likes = excluded.likes, payload = excluded.payload`,
    )
      .bind(payload.id, JSON.stringify(payload), payload.likes, payload.via, Date.now())
      .run();
    added += res.meta.changes || 0;
  }
  return added;
}

function markSeen(env: Env, id: string, verdict: string) {
  return env.DB.prepare('INSERT OR REPLACE INTO x_seen (source_id, verdict, seen_at) VALUES (?, ?, ?)')
    .bind(id, verdict, Date.now())
    .run();
}

// 看图 → 丢弃 or 入草稿。抛错表示可重试
async function processOne(env: Env, b: any): Promise<string> {
  const imageUrls: string[] = (b.media_urls || []).filter((u: string) => /pbs\.twimg\.com\/media\//.test(u));
  if (!imageUrls.length) {
    await markSeen(env, b.id, 'no_image');
    return 'no_image';
  }
  const rv = await reviewTweet(env, { author: b.author, bio: b.bio, text: b.text }, imageUrls);
  if (rv.no_repost_watermark || rv.not_gundam || rv.low_value) {
    const verdict = rv.no_repost_watermark ? 'watermark' : rv.not_gundam ? 'not_gundam' : 'low_value';
    await markSeen(env, b.id, verdict);
    return verdict;
  }
  const { card } = await ingestTweet(env, b.url || `https://x.com/${b.author || 'i'}/status/${b.id}`);
  const meta = {
    auto: true,
    via: b.via,
    likes: b.likes,
    ai_suspect: rv.ai_suspect,
    cn_artist_suspect: rv.cn_artist_suspect,
    not_original: rv.not_original,
    subject: rv.subject,
    work: rv.work,
    text_zh: rv.text_zh,
    reason: rv.reason,
  };
  const caption = composeCaption(shortBody(rv), card.author_handle || '');
  await env.DB.prepare('UPDATE cards SET caption = ?, meta_json = ?, updated_at = ? WHERE id = ?')
    .bind(caption, JSON.stringify(meta), Date.now(), card.id)
    .run();
  await markSeen(env, b.id, 'carded');
  return 'carded';
}

export async function discoverTick(env: Env): Promise<Record<string, any>> {
  const srcs = sources(env);
  if (!srcs.length) return { disabled: true };
  const log: Record<string, any> = {};

  // 1. 轮转来源，每次一个
  const state = JSON.parse((await env.IMAGES.get(STATE_KEY)) || '{"cursor":0}');
  const src = srcs[state.cursor % srcs.length];
  const backoffUntil = Number((await env.IMAGES.get(BACKOFF_KEY)) || '0');
  if (Date.now() < backoffUntil) {
    log.gathered = { skipped: 'backoff', until: new Date(backoffUntil).toISOString() };
  } else {
    await env.IMAGES.put(STATE_KEY, JSON.stringify({ cursor: (state.cursor + 1) % srcs.length }));
    const accounts = new Set(splitList(env.DISCOVER_ACCOUNTS).map((a) => a.toLowerCase()));
    try {
      log.gathered = { via: src.via, added: await gather(env, src, accounts) };
    } catch (e: any) {
      log.gathered = { via: src.via, error: String(e?.message || e) };
      if (e instanceof RateLimited) await env.IMAGES.put(BACKOFF_KEY, String(Date.now() + BACKOFF_MS));
    }
  }

  // 2. 清掉过期的，再按赞数从高到低取几条处理（标签搜来的热门图和关注作者一起排）
  await env.DB.prepare('DELETE FROM x_queue WHERE queued_at < ?').bind(Date.now() - MAX_AGE_MS).run();
  const rows = await env.DB.prepare(
    'SELECT source_id, payload, attempts FROM x_queue ORDER BY likes DESC LIMIT ?',
  )
    .bind(PER_TICK)
    .all();
  log.processed = [];
  for (const r of (rows.results || []) as any[]) {
    const b = JSON.parse(r.payload);
    try {
      const verdict = await processOne(env, b);
      await env.DB.prepare('DELETE FROM x_queue WHERE source_id = ?').bind(r.source_id).run();
      log.processed.push({ url: b.url, verdict });
    } catch (e: any) {
      const attempts = Number(r.attempts || 0) + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await env.DB.prepare('DELETE FROM x_queue WHERE source_id = ?').bind(r.source_id).run();
        await markSeen(env, r.source_id, 'error');
      } else {
        await env.DB.prepare('UPDATE x_queue SET attempts = ? WHERE source_id = ?').bind(attempts, r.source_id).run();
      }
      log.processed.push({ url: b.url, error: String(e?.message || e) });
    }
  }
  const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM x_queue').first<{ n: number }>();
  log.queue = Number(left?.n ?? 0);
  return log;
}
