import { Hono } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';
import type { Env } from './types';
import { authMiddleware, makeToken, checkPassword, COOKIE_NAME } from './auth';
import { ingestTweet } from './ingest';
import { pullNews } from './news';
import { translate } from './translate';
import { attachImages, getCardWithImages, composeCaption, deleteCard } from './db';

const app = new Hono<{ Bindings: Env }>();

/* ---------- 公开路由 ---------- */

app.get('/api/health', (c) => c.json({ ok: true }));

app.post('/api/login', async (c) => {
  const { password } = await c.req.json<{ password?: string }>().catch(() => ({ password: '' }));
  if (!checkPassword(c.env, password || '')) {
    return c.json({ error: '密码错误' }, 401);
  }
  const token = await makeToken(c.env);
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
  return c.json({ ok: true });
});

app.post('/api/logout', (c) => {
  deleteCookie(c, COOKIE_NAME, { path: '/' });
  return c.json({ ok: true });
});

/* ---------- N150 定时轮询用（PUB_TOKEN 鉴权，不走登录）---------- */

function pubTokenOk(c: any): boolean {
  const got = (c.req.header('Authorization') || '').replace(/^Bearer\s+/i, '');
  const want = c.env.PUB_TOKEN || '';
  return !!got && !!want && got === want;
}

// N150 每分钟问一次：有哪些到点该发的定时卡片
app.get('/api/scheduled/due', async (c) => {
  if (!pubTokenOk(c)) return c.json({ error: '未授权' }, 401);
  const now = Date.now();
  // 一次最多 3 条：N150 是串行队列,每条发完(~40-60s)才发下一条,连发间隔天然拉开;
  // 放 3 条是为了手动连发多张时一次 kick 全部带走,不用各等一轮轮询
  const rows = await c.env.DB.prepare(
    "SELECT id FROM cards WHERE status = 'queued' AND scheduled_at IS NOT NULL AND scheduled_at <= ? ORDER BY scheduled_at ASC LIMIT 3",
  )
    .bind(now)
    .all();
  const origin = new URL(c.req.url).origin;
  const due = [];
  for (const r of rows.results || []) {
    const card = await getCardWithImages(c.env, (r as any).id);
    if (!card) continue;
    due.push({
      id: card.id,
      caption: (card.caption || '').trim(),
      images: card.images.map((im) => origin + im.url),
      token: await makeToken(c.env),
    });
  }
  return c.json({ due });
});

// N150 发布成功后回调：标记已发
app.post('/api/scheduled/:id/done', async (c) => {
  if (!pubTokenOk(c)) return c.json({ error: '未授权' }, 401);
  const now = Date.now();
  await c.env.DB.prepare(
    "UPDATE cards SET status = 'posted', posted_at = ?, scheduled_at = NULL, updated_at = ? WHERE id = ?",
  )
    .bind(now, now, c.req.param('id'))
    .run();
  return c.json({ ok: true });
});

// N150 发布失败后回调：清掉定时（停止重试），留在待发让用户处理
app.post('/api/scheduled/:id/failed', async (c) => {
  if (!pubTokenOk(c)) return c.json({ error: '未授权' }, 401);
  await c.env.DB.prepare(
    'UPDATE cards SET scheduled_at = NULL, updated_at = ? WHERE id = ?',
  )
    .bind(Date.now(), c.req.param('id'))
    .run();
  return c.json({ ok: true });
});

/* ---------- 以下全部需要登录 ---------- */

app.use('/api/*', authMiddleware());

app.get('/api/me', (c) => c.json({ ok: true }));

// 各状态数量（标签计数用，三个标签始终显示真实数字）
app.get('/api/counts', async (c) => {
  const rows = await c.env.DB.prepare('SELECT status, COUNT(*) AS n FROM cards GROUP BY status').all();
  const counts: Record<string, number> = { inbox: 0, queued: 0, posted: 0 };
  for (const r of rows.results || []) {
    const s = (r as any).status as string;
    if (s in counts) counts[s] = Number((r as any).n);
  }
  return c.json({ counts });
});

// 核心入口：贴链接入库
app.post('/api/cards/ingest', async (c) => {
  const { url } = await c.req.json<{ url?: string }>().catch(() => ({ url: '' }));
  if (!url) return c.json({ error: '缺少 url' }, 400);
  try {
    const { card, duplicate } = await ingestTweet(c.env, url);
    return c.json({ card, duplicate });
  } catch (e: any) {
    return c.json({ error: String(e?.message || e) }, 400);
  }
});

// 手动拉官方新闻（gundam-official.com/news → AI 中文快讯 → 草稿）
app.post('/api/news/pull', async (c) => {
  const body = await c.req.json<{ limit?: number }>().catch(() => ({}) as { limit?: number });
  try {
    const r = await pullNews(c.env, body.limit ?? 3);
    // 手动拉过就顺延自动检查的时钟
    await c.env.IMAGES.put(NEWS_PULL_KEY, String(Date.now()));
    return c.json(r);
  } catch (e: any) {
    return c.json({ error: String(e?.message || e) }, 400);
  }
});

// 自动检查：前端每次打开时调一下，服务端按 KV 时间戳节流（替代 Cron）
app.post('/api/news/auto', async (c) => {
  const last = Number((await c.env.IMAGES.get(NEWS_PULL_KEY)) || '0');
  if (Date.now() - last < NEWS_PULL_INTERVAL_MS) {
    return c.json({ ran: false, addedCount: 0 });
  }
  // 先占坑再干活，避免并发打开时重复拉（去重兜底，重复也无害）
  await c.env.IMAGES.put(NEWS_PULL_KEY, String(Date.now()));
  try {
    const r = await pullNews(c.env, 3);
    return c.json({ ran: true, ...r });
  } catch (e: any) {
    return c.json({ ran: true, addedCount: 0, error: String(e?.message || e) });
  }
});

// 一键清空新闻草稿：每次最多删 5 张（免费版子请求预算），前端循环调到 remaining=0。
// 只删卡片，news_seen 见过表保留 → 清掉的新闻永远不会被重新拉进来
app.post('/api/news/clear', async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT id FROM cards WHERE source_type = 'news' AND status = 'inbox' ORDER BY created_at ASC LIMIT 5",
  ).all();
  const ids = (rows.results || []).map((r: any) => r.id as string);
  for (const id of ids) await deleteCard(c.env, id);
  const left = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM cards WHERE source_type = 'news' AND status = 'inbox'",
  ).first<{ n: number }>();
  return c.json({ removed: ids.length, remaining: Number(left?.n ?? 0) });
});

// 手动创建卡片（非 Twitter 内容的兜底）
app.post('/api/cards', async (c) => {
  const body = await c.req.json<any>().catch(() => ({}));
  const now = Date.now();
  const cardId = crypto.randomUUID();
  const text = body.text || '';
  const caption = body.caption ?? composeCaption(text, body.author_handle || '');
  await c.env.DB.prepare(
    `INSERT INTO cards
      (id, source_type, author_handle, text_original, text_final, caption, status, created_at, updated_at)
     VALUES (?, 'manual', ?, ?, ?, ?, 'inbox', ?, ?)`,
  )
    .bind(cardId, body.author_handle || null, text, text, caption, now, now)
    .run();
  return c.json({ card: await getCardWithImages(c.env, cardId) });
});

// 列表（按状态）—— 顺手在后台清理「已发」超过 7 天的卡片（惰性清理，替代 Cron）
app.get('/api/cards', async (c) => {
  c.executionCtx.waitUntil(purgePosted(c.env));
  const status = c.req.query('status');
  const stmt = status
    ? c.env.DB.prepare('SELECT * FROM cards WHERE status = ? ORDER BY created_at DESC').bind(status)
    : c.env.DB.prepare('SELECT * FROM cards ORDER BY created_at DESC');
  const rows = await stmt.all();
  const cards = await Promise.all((rows.results || []).map((r: any) => attachImages(c.env, r)));
  return c.json({ cards });
});

// 单卡
app.get('/api/cards/:id', async (c) => {
  const card = await getCardWithImages(c.env, c.req.param('id'));
  if (!card) return c.json({ error: '卡片不存在' }, 404);
  return c.json({ card });
});

// 同源图片二进制（前端复制到剪贴板就靠它 —— 同源才不会污染 canvas）
app.get('/api/cards/:id/image/:imgId', async (c) => {
  const img = await c.env.DB.prepare(
    'SELECT r2_key, mime FROM card_images WHERE id = ? AND card_id = ?',
  )
    .bind(c.req.param('imgId'), c.req.param('id'))
    .first<{ r2_key: string; mime: string }>();
  if (!img) return c.json({ error: '图片不存在' }, 404);
  const obj = await c.env.BUCKET.get(img.r2_key);
  if (!obj) return c.json({ error: '图片不存在' }, 404);
  return new Response(obj.body, {
    headers: {
      'Content-Type': img.mime || obj.httpMetadata?.contentType || 'image/jpeg',
      'Cache-Control': 'private, max-age=86400',
    },
  });
});

// 编辑正文/配文、切状态
app.patch('/api/cards/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<any>().catch(() => ({}));
  const fields: string[] = [];
  const vals: any[] = [];
  for (const k of ['text_final', 'caption', 'author_handle', 'status', 'scheduled_at'] as const) {
    if (k in body) {
      fields.push(`${k} = ?`);
      vals.push(body[k]);
    }
  }
  if (body.status === 'posted') {
    fields.push('posted_at = ?', 'scheduled_at = ?');
    vals.push(Date.now(), null); // 发出去了就清掉定时
  } else if (body.status && body.status !== 'posted') {
    fields.push('posted_at = ?');
    vals.push(null);
  }
  if (!fields.length) return c.json({ error: '没有可更新的字段' }, 400);
  fields.push('updated_at = ?');
  vals.push(Date.now());
  vals.push(id);
  await c.env.DB.prepare(`UPDATE cards SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...vals)
    .run();
  // 设了"立即发"(手动发布按钮)就踢一脚 N150 马上来取,不等它 60s 轮询
  if (
    typeof body.scheduled_at === 'number' &&
    body.scheduled_at <= Date.now() + 5000 &&
    c.env.PUB_URL &&
    c.env.PUB_TOKEN
  ) {
    c.executionCtx.waitUntil(
      fetch(c.env.PUB_URL.replace(/\/+$/, '') + '/kick', {
        method: 'POST',
        headers: { Authorization: `Bearer ${c.env.PUB_TOKEN}` },
      }).then(() => {}).catch(() => {}), // 踢不动也无妨,轮询兜底
    );
  }
  const card = await getCardWithImages(c.env, id);
  if (!card) return c.json({ error: '卡片不存在' }, 404);
  return c.json({ card });
});

// 直发微博：转发给 N150 上的发布服务（opencli 驱动本地 Chrome）
app.post('/api/cards/:id/publish', async (c) => {
  const id = c.req.param('id');
  if (!c.env.PUB_URL || !c.env.PUB_TOKEN) {
    return c.json({ error: '发布服务未配置（等 N150 那边就绪）' }, 501);
  }
  const card = await getCardWithImages(c.env, id);
  if (!card) return c.json({ error: '卡片不存在' }, 404);
  const caption = (card.caption || '').trim();
  if (!caption && !card.images.length) return c.json({ error: '没有可发布的内容' }, 400);

  // 给 N150 一个新 token 用来回来下载图片
  const token = await makeToken(c.env);
  const origin = new URL(c.req.url).origin;
  const images = card.images.map((im) => origin + im.url);

  let r: Response;
  try {
    r = await fetch(c.env.PUB_URL.replace(/\/+$/, '') + '/publish', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${c.env.PUB_TOKEN}`,
      },
      body: JSON.stringify({ caption, images, token }),
    });
  } catch (e: any) {
    return c.json({ error: '够不到发布服务，N150 或隧道可能没在线：' + String(e?.message || e) }, 502);
  }
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) {
    return c.json({ error: j.error || `发布服务出错 (HTTP ${r.status})` }, 502);
  }

  const now = Date.now();
  await c.env.DB.prepare(
    "UPDATE cards SET status = 'posted', posted_at = ?, updated_at = ? WHERE id = ?",
  )
    .bind(now, now, id)
    .run();
  return c.json({ card: await getCardWithImages(c.env, id) });
});

// 删除（连带删图片）
app.delete('/api/cards/:id', async (c) => {
  await deleteCard(c.env, c.req.param('id'));
  return c.json({ ok: true });
});

// 翻译建议（不写库，前端自行决定是否填入）
app.post('/api/cards/:id/translate', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ style?: string }>().catch(() => ({}));
  const card = await c.env.DB.prepare('SELECT text_original, text_final FROM cards WHERE id = ?')
    .bind(id)
    .first<{ text_original: string; text_final: string }>();
  if (!card) return c.json({ error: '卡片不存在' }, 404);
  try {
    const text = await translate(c.env, card.text_original || card.text_final || '', body.style);
    return c.json({ text });
  } catch (e: any) {
    return c.json({ error: String(e?.message || e) }, 400);
  }
});

/* ---------- 其余请求交给静态资源（前端页面） ---------- */
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

/* ---------- 定时清理：已发超过 N 天的卡片连图删除 ---------- */
const PURGE_DAYS = 7;

// 官网新闻自动检查节流（KV 里记上次拉取时间）
const NEWS_PULL_KEY = 'sys:news_last_pull';
const NEWS_PULL_INTERVAL_MS = 6 * 60 * 60 * 1000;

async function purgePosted(env: Env): Promise<number> {
  const cutoff = Date.now() - PURGE_DAYS * 24 * 60 * 60 * 1000;
  const rows = await env.DB.prepare(
    "SELECT id FROM cards WHERE status = 'posted' AND posted_at IS NOT NULL AND posted_at < ?",
  )
    .bind(cutoff)
    .all();
  const ids = (rows.results || []).map((r: any) => r.id as string);
  for (const id of ids) await deleteCard(env, id);
  return ids.length;
}

export default {
  fetch: app.fetch,
  // Cron 触发（wrangler.toml 里配每天跑一次）
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(purgePosted(env));
    ctx.waitUntil(pullNews(env, 3).catch(() => {}));
  },
};
