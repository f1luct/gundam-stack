import type { Env } from './types';
import { flightText, jsonAfterKey, resolveRef } from './flight';
import { summarizeNews } from './translate';

// 高达官网新闻适配器：列表 → 详情 → AI 中文快讯 → 草稿卡片
const SITE = 'https://gundam-official.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) gundam-stack/0.1 personal-staging';
const MAX_IMG_BYTES = 12 * 1024 * 1024;
// 免费版 Worker 单请求 50 个子请求上限，每篇文章图片和单次处理篇数都要克制
const MAX_IMGS_PER_ARTICLE = 4;
const MAX_ARTICLES_PER_PULL = 3;

export interface NewsItem {
  documentId: string;
  title: string;
  displayDatetime?: string;
  thumbnail?: { url?: string };
  url?: string;
  seriesTags?: { name: string }[];
  categories?: { name: string }[];
  isLegacy?: boolean;
}

async function fetchPage(url: string): Promise<string> {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
  if (!r.ok) throw new Error(`官网页面获取失败 (${r.status})`);
  return r.text();
}

// 列表页第一页（18 条，每天看一眼足够）
export async function fetchNewsList(): Promise<NewsItem[]> {
  const html = await fetchPage(`${SITE}/news`);
  const resp = jsonAfterKey(flightText(html), 'newsResponse');
  const data = resp?.data;
  if (!Array.isArray(data)) throw new Error('解析官网新闻列表失败（页面结构可能变了）');
  return data.filter((d: any) => d?.documentId && d?.title);
}

interface NewsDetail {
  title: string;
  summary: string;
  body: string; // markdown
  imageUrls: string[];
}

// 详情页：newsResponse 就是文章对象，正文 markdown 在 contents[].content 的 $ref 里
export async function fetchNewsDetail(item: NewsItem): Promise<NewsDetail> {
  const html = await fetchPage(item.url || `${SITE}/news/${item.documentId}`);
  const t = flightText(html);
  const resp = jsonAfterKey(t, 'newsResponse') || {};
  const parts: string[] = [];
  for (const c of resp.contents || []) {
    if (typeof c?.content === 'string') {
      const s = resolveRef(t, c.content);
      if (s) parts.push(s);
    }
  }
  const body = parts.join('\n\n');

  const imageUrls: string[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      imageUrls.push(m[1]);
    }
  }
  const thumb = resp.thumbnail?.url || item.thumbnail?.url;
  if (!imageUrls.length && thumb) imageUrls.push(thumb);

  return {
    title: resp.title || item.title,
    summary: resp.summary || '',
    body,
    imageUrls: imageUrls.slice(0, MAX_IMGS_PER_ARTICLE),
  };
}

// markdown → 纯文本（喂给 AI，也作为 text_original 存档）
export function mdToPlain(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接留文字
    .replace(/^:::.*$/gm, '') // :::modal-image 等指令
    .replace(/\{\{[^}]*\}\}/g, '') // {{grid}} {{color:...}} 等
    .replace(/[*_#>`]+/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface PullResult {
  addedCount: number; // 本次成功入库数
  newTotal: number; // 本次发现的未入库新文章总数
  remaining: number; // 还没处理的（可再点一次继续）
  failed: number; // 本批处理失败数
}

// 拉取入口：找新文章 → 逐篇抓详情+AI 快讯+存图 → 草稿
export async function pullNews(env: Env, limit = MAX_ARTICLES_PER_PULL): Promise<PullResult> {
  const list = await fetchNewsList();
  const fresh = list.filter((x) => !x.isLegacy);
  const ids = fresh.map((x) => x.documentId);
  if (!ids.length) return { addedCount: 0, newTotal: 0, remaining: 0, failed: 0 };

  // 一次查询找出处理过的（查"见过表"而非卡片表：删过的卡不会被重新拉进来）
  const placeholders = ids.map(() => '?').join(',');
  const existing = await env.DB.prepare(
    `SELECT source_id FROM news_seen WHERE source_id IN (${placeholders})`,
  )
    .bind(...ids)
    .all();
  const have = new Set((existing.results || []).map((r: any) => r.source_id));
  const todo = fresh.filter((x) => !have.has(x.documentId));
  const batch = todo.slice(0, Math.max(1, Math.min(limit, MAX_ARTICLES_PER_PULL)));

  // 并行处理，单篇失败不影响其他
  const results = await Promise.all(
    batch.map((item) =>
      ingestNewsItem(env, item)
        .then(() => true)
        .catch((e) => {
          console.error(`[news] 入库失败 ${item.documentId}: ${String(e?.message || e)}`);
          return false;
        }),
    ),
  );
  const addedCount = results.filter(Boolean).length;
  return {
    addedCount,
    newTotal: todo.length,
    remaining: todo.length - batch.length,
    failed: batch.length - addedCount,
  };
}

async function ingestNewsItem(env: Env, item: NewsItem): Promise<void> {
  const detail = await fetchNewsDetail(item);
  const plain = mdToPlain(detail.body);
  const seriesNames = (item.seriesTags || []).map((s) => s.name).filter(Boolean);

  // AI 中文快讯；挂了就先用日文标题入库，不阻塞流程（卡片里还能手动点翻译）
  let zh = '';
  try {
    zh = await summarizeNews(env, {
      title: detail.title,
      summary: detail.summary,
      body: plain,
      series: seriesNames,
    });
  } catch {
    zh = '';
  }

  const now = Date.now();
  const cardId = crypto.randomUUID();
  const caption = (zh || detail.title).trim() + '\n\n来源: gundam-official.com';

  const images: { id: string; key: string; src: string; mime: string; ord: number }[] = [];
  let ord = 0;
  for (const imgUrl of detail.imageUrls) {
    try {
      const resp = await fetch(imgUrl, { headers: { 'User-Agent': UA, Referer: SITE + '/' } });
      if (!resp.ok) continue;
      const buf = await resp.arrayBuffer();
      if (buf.byteLength > MAX_IMG_BYTES) continue;
      const mime = resp.headers.get('content-type') || 'image/jpeg';
      const imgId = crypto.randomUUID();
      const key = `${cardId}/${imgId}`;
      await env.BUCKET.put(key, buf, { httpMetadata: { contentType: mime } });
      images.push({ id: imgId, key, src: imgUrl, mime, ord: ord++ });
    } catch {
      // 单张失败跳过
    }
  }

  const meta = JSON.stringify({
    title: detail.title,
    summary: detail.summary,
    displayDatetime: item.displayDatetime || null,
    seriesTags: seriesNames,
    categories: (item.categories || []).map((c) => c.name).filter(Boolean),
  });

  // 卡片、图片、见过表一个 batch 写入，算一次 D1 操作
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO news_seen (source_id, seen_at) VALUES (?, ?)').bind(
      item.documentId,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO cards
        (id, source_type, source_url, source_id, author_handle, author_name,
         text_original, text_final, caption, lang, status, meta_json, created_at, updated_at)
       VALUES (?, 'news', ?, ?, NULL, 'GUNDAM OFFICIAL', ?, ?, ?, 'ja', 'inbox', ?, ?, ?)`,
    ).bind(
      cardId,
      item.url || `${SITE}/news/${item.documentId}`,
      item.documentId,
      `${detail.title}\n\n${plain}`,
      zh || '',
      caption,
      meta,
      now,
      now,
    ),
    ...images.map((im) =>
      env.DB.prepare(
        `INSERT INTO card_images (id, card_id, r2_key, source_img_url, mime, ord)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(im.id, cardId, im.key, im.src, im.mime, im.ord),
    ),
  ]);
}
