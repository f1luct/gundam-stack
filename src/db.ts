import type { Env } from './types';

export interface CardImage {
  id: string;
  ord: number;
  url: string;
}

export interface CardOut {
  id: string;
  source_type: string;
  source_url: string | null;
  source_id: string | null;
  author_handle: string | null;
  author_name: string | null;
  text_original: string | null;
  text_final: string | null;
  caption: string | null;
  lang: string | null;
  status: string;
  scheduled_at: number | null;
  posted_at: number | null;
  created_at: number;
  updated_at: number;
  images: CardImage[];
}

export async function attachImages(env: Env, card: any): Promise<CardOut> {
  const imgs = await env.DB.prepare(
    'SELECT id, ord FROM card_images WHERE card_id = ? ORDER BY ord',
  )
    .bind(card.id)
    .all();
  const images = (imgs.results || []).map((i: any) => ({
    id: i.id as string,
    ord: i.ord as number,
    url: `/api/cards/${card.id}/image/${i.id}`,
  }));
  return { ...card, images };
}

export async function getCardWithImages(env: Env, id: string): Promise<CardOut | null> {
  const card = await env.DB.prepare('SELECT * FROM cards WHERE id = ?').bind(id).first();
  if (!card) return null;
  return attachImages(env, card);
}

// 删除一张卡片（连带其 R2 图片）
export async function deleteCard(env: Env, id: string): Promise<void> {
  const imgs = await env.DB.prepare('SELECT r2_key FROM card_images WHERE card_id = ?')
    .bind(id)
    .all();
  for (const im of imgs.results || []) {
    try {
      await env.BUCKET.delete((im as any).r2_key);
    } catch {
      /* 忽略单张失败 */
    }
  }
  await env.DB.prepare('DELETE FROM card_images WHERE card_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM cards WHERE id = ?').bind(id).run();
}

// 配文：{正文}\n\nX: @{handle}
export function composeCaption(text: string, handle: string): string {
  const body = (text || '').trim();
  const tag = handle ? `X: @${handle}` : '';
  return [body, tag].filter(Boolean).join('\n\n');
}
