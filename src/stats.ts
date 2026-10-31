import type { Env } from './types';

// 微博数据：N150 每几小时用 opencli 拉一次 @高达Bit 最近的微博（赞/转/评），推到这里。
// 每条尽量对上站里发出去的卡片，把卡片信息（X 作者、机体、来源）快照下来——卡片 7 天后会被清掉，
// 快照留着才能长期看"什么内容人气高"。每天再让 DeepSeek 读近 30 天的数据写几条挑帖建议。

const INSIGHT_KEY = 'stats:insight';
const MODEL = 'deepseek-v4-flash';
const DAY = 24 * 3600 * 1000;
const BJ = 8 * 3600 * 1000; // 按北京时间切"昨天"

export interface WeiboPost {
  id: string;
  mblogid?: string;
  text?: string;
  time?: string;
  reposts?: number;
  comments?: number;
  likes?: number;
  pic_count?: number;
  url?: string;
}

const norm = (s: string) => (s || '').replace(/[\s​‌﻿]/g, '');

// 北京时间某天 0 点的时间戳（offset=0 今天，-1 昨天）
export function bjDayStart(offset = 0, now = Date.now()): number {
  return Math.floor((now + BJ) / DAY) * DAY - BJ + offset * DAY;
}

function bjDate(ms: number): string {
  return new Date(ms + BJ).toISOString().slice(0, 10);
}

export async function ingestWeiboPosts(env: Env, posts: WeiboPost[]): Promise<{ saved: number; matched: number }> {
  const rows = posts
    .map((p) => ({ ...p, t: Date.parse(p.time || '') }))
    .filter((p) => /^\d+$/.test(String(p.id)) && Number.isFinite(p.t));
  if (!rows.length) return { saved: 0, matched: 0 };

  // 已经对上过的不再对；没对上的，一次查出时间窗里所有已发卡片，在内存里按配文开头比对
  const ids = rows.map((r) => String(r.id));
  const known = await env.DB.prepare(
    `SELECT id FROM weibo_posts WHERE kind IS NOT NULL AND id IN (${ids.map(() => '?').join(',')})`,
  )
    .bind(...ids)
    .all();
  const done = new Set((known.results || []).map((r: any) => String(r.id)));
  const minT = Math.min(...rows.map((r) => r.t));
  const maxT = Math.max(...rows.map((r) => r.t));
  const cards = (
    await env.DB.prepare(
      "SELECT id, source_type, author_handle, caption, meta_json, posted_at FROM cards WHERE status = 'posted' AND posted_at BETWEEN ? AND ?",
    )
      .bind(minT - 6 * 3600 * 1000, maxT + 3600 * 1000)
      .all()
  ).results as any[];

  let matched = 0;
  const now = Date.now();
  const stmts = rows.map((p) => {
    let kind: string | null = null;
    let snap: string | null = null;
    if (!done.has(String(p.id))) {
      const text = norm(p.text || '');
      const card = cards.find((c) => {
        const want = norm(c.caption || '').slice(0, 12);
        return want.length >= 4 && text.startsWith(want) && Math.abs(Number(c.posted_at) - p.t) < 6 * 3600 * 1000;
      });
      if (card) {
        let meta: any = {};
        try {
          meta = JSON.parse(card.meta_json || '{}');
        } catch {}
        kind = card.source_type === 'news' ? 'news' : meta.auto ? 'auto' : 'manual';
        snap = JSON.stringify({
          card_id: card.id,
          author: card.author_handle || '',
          subject: meta.subject || '',
          via: meta.via || '',
          x_likes: meta.likes ?? null,
        });
        matched++;
      } else if (now - p.t > 6 * 3600 * 1000) {
        kind = 'other'; // 6 小时还没对上 = 不是站里发的（Haven 自己写的、手机上发的）
      }
    }
    return env.DB.prepare(
      `INSERT INTO weibo_posts (id, mblogid, text, posted_at, likes, reposts, comments, pic_count, url, kind, card_meta, fetched_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
       ON CONFLICT(id) DO UPDATE SET likes = excluded.likes, reposts = excluded.reposts, comments = excluded.comments,
         text = excluded.text, fetched_at = excluded.fetched_at,
         kind = COALESCE(weibo_posts.kind, excluded.kind), card_meta = COALESCE(weibo_posts.card_meta, excluded.card_meta)`,
    ).bind(
      String(p.id),
      p.mblogid || '',
      p.text || '',
      p.t,
      Number(p.likes || 0),
      Number(p.reposts || 0),
      Number(p.comments || 0),
      Number(p.pic_count || 0),
      p.url || '',
      kind,
      snap,
      now,
    );
  });
  await env.DB.batch(stmts);
  return { saved: rows.length, matched };
}

function totals(posts: any[]) {
  const n = posts.length;
  const sum = (k: string) => posts.reduce((a, p) => a + Number(p[k] || 0), 0);
  const likes = posts.map((p) => Number(p.likes || 0)).sort((a, b) => a - b);
  return {
    posts: n,
    likes: sum('likes'),
    reposts: sum('reposts'),
    comments: sum('comments'),
    median_likes: n ? likes[Math.floor((n - 1) / 2)] : 0,
  };
}

function withMeta(p: any) {
  let m: any = {};
  try {
    m = JSON.parse(p.card_meta || '{}');
  } catch {}
  return { ...p, card_meta: undefined, author: m.author || '', subject: m.subject || '', via: m.via || '' };
}

export async function statsSummary(env: Env) {
  const y0 = bjDayStart(-1);
  const since = bjDayStart(-30);
  const all = ((await env.DB.prepare('SELECT * FROM weibo_posts WHERE posted_at >= ? ORDER BY posted_at DESC').bind(since).all())
    .results || []) as any[];
  const yesterday = all.filter((p) => p.posted_at >= y0 && p.posted_at < y0 + DAY).map(withMeta);
  const dayBefore = all.filter((p) => p.posted_at >= y0 - DAY && p.posted_at < y0);
  const byKind: Record<string, any> = {};
  for (const k of ['auto', 'manual', 'news', 'other']) {
    const ps = all.filter((p) => (p.kind || 'other') === k);
    if (ps.length) byKind[k] = totals(ps);
  }
  const top = [...all].sort((a, b) => b.likes - a.likes).slice(0, 10).map(withMeta);
  const last = await env.DB.prepare('SELECT MAX(fetched_at) AS t FROM weibo_posts').first<{ t: number }>();
  const insight = JSON.parse((await env.IMAGES.get(INSIGHT_KEY)) || 'null');
  return {
    date: bjDate(y0),
    fetched_at: last?.t ?? null,
    yesterday: { totals: totals(yesterday), posts: yesterday },
    day_before: totals(dayBefore),
    last30: { totals: totals(all), by_kind: byKind, top },
    insight,
  };
}

// 每天最多一次：近 30 天的数据丢给 DeepSeek，让它总结什么内容人气高、下次多挑什么
export async function refreshInsight(env: Env, force = false): Promise<any> {
  const today = bjDate(Date.now());
  const old = JSON.parse((await env.IMAGES.get(INSIGHT_KEY)) || 'null');
  if (!force && old?.date === today) return old;
  if (!env.DEEPSEEK_API_KEY) return old;
  const since = bjDayStart(-30);
  const posts = ((await env.DB.prepare('SELECT * FROM weibo_posts WHERE posted_at >= ? ORDER BY posted_at').bind(since).all())
    .results || []) as any[];
  if (posts.length < 5) return old;

  const now = Date.now();
  const lines = posts.map((raw) => {
    const p = withMeta(raw);
    const age = Math.round((now - p.posted_at) / 3600000);
    const hour = new Date(p.posted_at + BJ).getUTCHours();
    return [
      `${p.likes}赞 ${p.reposts}转 ${p.comments}评`,
      `发出${age}小时 北京${hour}点`,
      `类型:${p.kind || 'other'}`,
      p.author ? `X作者:@${p.author}` : '',
      p.subject ? `题材:${p.subject}` : '',
      p.via ? `来源:${p.via}` : '',
      `正文:${String(p.text || '').replace(/\s+/g, ' ').slice(0, 80)}`,
    ]
      .filter(Boolean)
      .join(' | ');
  });

  const sys =
    '你是高达微博搬运号 @高达Bit 的运营分析。号主每天从 X 上挑高达插画和模型作品搬运到微博，配文很短（机体或人物名 + X: @作者）。' +
    '类型说明：auto=自动找帖后号主挑中的，manual=号主手动贴链接的，news=官网新闻快讯，other=号主自己写的或站外发的。' +
    '发出不到 48 小时的帖子数据还在涨，比较时要考虑。根据下面近 30 天的数据，找出什么内容人气高、什么低，给号主下次挑帖的具体建议。' +
    '只输出 JSON：{"headline": 一句话结论, "findings": [3-5 条具体发现，引用数字和例子], "pick_more": [2-4 条下次多挑什么], "avoid": [1-3 条少发什么]}。' +
    '说人话，别空泛（不要"保持高质量内容"这类话），样本太少的结论要说明。';
  const r = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: lines.join('\n') },
      ],
      response_format: { type: 'json_object' },
      thinking: { type: 'enabled' },
      max_tokens: 4000,
      stream: false,
    }),
  });
  if (!r.ok) return old;
  const j: any = await r.json();
  let out: any;
  try {
    out = JSON.parse(j?.choices?.[0]?.message?.content || '{}');
  } catch {
    return old;
  }
  const arr = (v: any) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
  const insight = {
    date: today,
    sample: posts.length,
    headline: String(out.headline || ''),
    findings: arr(out.findings),
    pick_more: arr(out.pick_more),
    avoid: arr(out.avoid),
  };
  await env.IMAGES.put(INSIGHT_KEY, JSON.stringify(insight));
  return insight;
}
