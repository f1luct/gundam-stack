import type { Env } from './types';
import { parseTweetId, parseHandle, extractTweet, UA } from './twitter';
import { composeCaption, getCardWithImages, type CardOut } from './db';

const MAX_IMG_BYTES = 12 * 1024 * 1024; // 单图上限 12MB，防滥用

// 抓取一条推文 -> 转存图片到 R2 -> 写入卡片(status=inbox)
export async function ingestTweet(env: Env, url: string): Promise<{ card: CardOut; duplicate: boolean }> {
  const id = parseTweetId(url);
  if (!id) {
    throw new Error('识别不了链接，请粘贴形如 https://x.com/用户名/status/数字 的推文链接。');
  }

  // 去重
  const existing = await env.DB.prepare(
    'SELECT id FROM cards WHERE source_type = ? AND source_id = ?',
  )
    .bind('twitter', id)
    .first<{ id: string }>();
  if (existing) {
    const card = await getCardWithImages(env, existing.id);
    return { card: card!, duplicate: true };
  }

  const ex = await extractTweet(id);
  const now = Date.now();
  const cardId = crypto.randomUUID();
  // handle 兜底：接口没给就用链接里的用户名
  const handle = ex.author_handle || parseHandle(url) || '';
  const caption = composeCaption(ex.text, handle);

  // 下载图片并存 R2（保留原始字节，前端复制时再转 PNG，避免服务端引图像库）
  const images: { id: string; key: string; src: string; mime: string; ord: number }[] = [];
  let ord = 0;
  for (const imgUrl of ex.image_urls) {
    try {
      const resp = await fetch(imgUrl, { headers: { 'User-Agent': UA, Referer: 'https://twitter.com/' } });
      if (!resp.ok) continue;
      const len = Number(resp.headers.get('content-length') || '0');
      if (len && len > MAX_IMG_BYTES) continue;
      const buf = await resp.arrayBuffer();
      if (buf.byteLength > MAX_IMG_BYTES) continue;
      const mime = resp.headers.get('content-type') || 'image/jpeg';
      const imgId = crypto.randomUUID();
      const key = `${cardId}/${imgId}`;
      await env.BUCKET.put(key, buf, { httpMetadata: { contentType: mime } });
      images.push({ id: imgId, key, src: imgUrl, mime, ord: ord++ });
    } catch {
      // 单张失败跳过，不影响整条卡片
    }
  }

  await env.DB.prepare(
    `INSERT INTO cards
      (id, source_type, source_url, source_id, author_handle, author_name,
       text_original, text_final, caption, lang, status, created_at, updated_at)
     VALUES (?, 'twitter', ?, ?, ?, ?, ?, ?, ?, ?, 'inbox', ?, ?)`,
  )
    .bind(
      cardId,
      url,
      id,
      handle || null,
      ex.author_name || null,
      ex.text || '',
      ex.text || '',
      caption,
      ex.lang || null,
      now,
      now,
    )
    .run();

  for (const im of images) {
    await env.DB.prepare(
      `INSERT INTO card_images (id, card_id, r2_key, source_img_url, mime, ord)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(im.id, cardId, im.key, im.src, im.mime, im.ord)
      .run();
  }

  const card = await getCardWithImages(env, cardId);
  return { card: card!, duplicate: false };
}
