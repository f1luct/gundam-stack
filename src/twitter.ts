import type { Extracted } from './types';

const UA = 'gundam-stack/0.1 (personal weibo staging app)';

// 从各种形式的链接里抠出推文数字 id
export function parseTweetId(input: string): string | null {
  if (!input) return null;
  const s = input.trim();
  const m =
    s.match(/(?:twitter\.com|x\.com)\/[^/]+\/status(?:es)?\/(\d+)/i) ||
    s.match(/\/status(?:es)?\/(\d+)/i) ||
    s.match(/^(\d{6,25})$/);
  return m ? m[1] : null;
}

// 从链接里抠出作者用户名（handle 兜底用）
export function parseHandle(input: string): string | null {
  if (!input) return null;
  const m = input.match(/(?:twitter\.com|x\.com)\/(@?[A-Za-z0-9_]{1,15})\/status/i);
  if (!m) return null;
  const u = m[1].replace(/^@/, '');
  // 排除非用户名的路径段
  if (/^(i|home|search|hashtag|messages|notifications|explore|settings)$/i.test(u)) return null;
  return u;
}

// 给 pbs.twimg.com 的图片补上 ?name=orig 拿原图
function withOrig(u: string): string {
  if (!u) return u;
  if (/[?&]name=/.test(u)) return u;
  return u + (u.includes('?') ? '&' : '?') + 'name=orig';
}

function genToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

// 主：fxtwitter
async function viaFx(id: string): Promise<Extracted | null> {
  try {
    const r = await fetch(`https://api.fxtwitter.com/i/status/${id}`, { headers: { 'User-Agent': UA } });
    if (!r.ok) return null;
    const j: any = await r.json();
    const t = j?.tweet;
    if (!t) return null;
    const photos = t.media?.photos || [];
    return {
      source_id: id,
      author_handle: t.author?.screen_name || '',
      author_name: t.author?.name || '',
      text: t.text || '',
      lang: t.lang,
      image_urls: photos.map((p: any) => withOrig(p.url)).filter(Boolean),
    };
  } catch {
    return null;
  }
}

// 备用 1：vxtwitter
async function viaVx(id: string): Promise<Extracted | null> {
  try {
    const r = await fetch(`https://api.vxtwitter.com/i/status/${id}`, { headers: { 'User-Agent': UA } });
    if (!r.ok) return null;
    const j: any = await r.json();
    if (!j || j.error) return null;
    const media = (j.media_extended || []).filter((m: any) => m.type === 'image');
    return {
      source_id: id,
      author_handle: j.user_screen_name || '',
      author_name: j.user_name || '',
      text: j.text || '',
      image_urls: media.map((m: any) => withOrig(m.url)).filter(Boolean),
    };
  } catch {
    return null;
  }
}

// 备用 2：Twitter 官方 syndication（只能服务端调，浏览器跨域被挡）
async function viaSyndication(id: string): Promise<Extracted | null> {
  for (const token of ['a', genToken(id)]) {
    try {
      const r = await fetch(
        `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${token}&lang=en`,
        { headers: { 'User-Agent': UA } },
      );
      if (!r.ok) continue;
      const body = await r.text();
      if (!body) continue;
      let j: any;
      try {
        j = JSON.parse(body);
      } catch {
        continue;
      }
      const md = j.mediaDetails || [];
      return {
        source_id: id,
        author_handle: j.user?.screen_name || '',
        author_name: j.user?.name || '',
        text: j.text || '',
        lang: j.lang,
        image_urls: md
          .filter((m: any) => m.type === 'photo')
          .map((m: any) => withOrig(m.media_url_https))
          .filter(Boolean),
      };
    } catch {
      continue;
    }
  }
  return null;
}

// 依次尝试三个来源；优先返回「带 handle」的结果，避免某个源 200 但缺 author 时拿到空 handle
export async function extractTweet(id: string): Promise<Extracted> {
  const sources = [viaFx, viaVx, viaSyndication];
  let fallback: Extracted | null = null;
  for (const fn of sources) {
    const r = await fn(id);
    if (!r) continue;
    if (r.author_handle) return r; // 有作者，直接用
    if (!fallback) fallback = r; // 记下第一个有内容但缺 handle 的，兜底
  }
  if (fallback) return fallback;
  throw new Error('无法获取该推文：可能是私密/已删除/年龄限制，或抓取接口暂时不可用。');
}

export { UA };
