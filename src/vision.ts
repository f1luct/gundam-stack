import type { Env } from './types';
import { UA } from './twitter';

// 自动找帖的看图审核：deepseek-v4-flash 看图 + 读作者简介，一次给出过滤结论和简洁文案
const MODEL = 'deepseek-v4-flash';
const API_URL = 'https://api.deepseek.com/chat/completions';
const MAX_IMGS = 4; // 多图帖只看前几张，够判断了
const MAX_IMG_BYTES = 4 * 1024 * 1024;

export interface Review {
  not_gundam: boolean; // 不是高达相关（标签搜索会混进别的）
  low_value: boolean; // 普通素组 / 制作过程 / 商品图，没搬运价值
  no_repost_watermark: boolean; // 图上有显眼的禁止转载水印 → 绝对不转
  ai_suspect: boolean; // 疑似 AI 生成
  cn_artist_suspect: boolean; // 疑似中国画师/模型师
  not_original: boolean; // 发帖人不是作者（搬运号/资讯号）
  subject: string; // 图里的机体或人物，中文圈通行叫法
  work: string; // 出处作品
  keep_text: boolean; // 原文是否有趣到值得附上
  text_zh: string; // keep_text 时的中文译文
  reason: string; // 一句话说明红牌理由，给人工审核看
}

export interface Candidate {
  author: string;
  bio?: string;
  text?: string;
}

// 看图用 medium 尺寸（约 1200px）就够，原图太大费 token
function mediumUrl(u: string): string {
  if (/[?&]name=/.test(u)) return u.replace(/([?&])name=[^&]*/, '$1name=medium');
  return u + (u.includes('?') ? '&' : '?') + 'name=medium';
}

async function toDataUrl(u: string): Promise<string | null> {
  try {
    const r = await fetch(mediumUrl(u), { headers: { 'User-Agent': UA, Referer: 'https://twitter.com/' } });
    if (!r.ok) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength > MAX_IMG_BYTES) return null;
    let bin = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    const mime = r.headers.get('content-type') || 'image/jpeg';
    return `data:${mime};base64,${btoa(bin)}`;
  } catch {
    return null;
  }
}

const SYSTEM =
  '你是高达微博搬运号的审图编辑。给你一条 X 推文的图片、正文和作者简介，判断能不能搬运并写配文。只输出 JSON，字段：\n' +
  'not_gundam: 图片内容和高达系列（机体、角色、高达模型）无关时为 true。\n' +
  'low_value: 没有搬运价值时为 true。我们只要两类：①高达插画/同人图；②有真本事的模型作品（明显的自定义涂装、改造/拼装、场景或特别出色的摄影）。以下一律算 low_value：基本照说明书拼好的普通成品（素组、只贴了水贴或简单分色）、几台普通成品的合影、制作过程/半成品/喷涂中/零件摊开、开箱和板件照、商品宣传图。正文说「作り始め」「製作中」「途中」「WIP」「塗装中」「あとは〜だけ」「進捗」之类表示还没完成的，不管图看起来如何都算 low_value。拿不准时偏向 true。\n' +
  'no_repost_watermark: 图片上有显眼的「禁止转载 / 無断転載禁止 / 転載禁止 / DO NOT REPOST」之类的水印或文字时为 true。' +
  '只看图片本身；作者签名、普通 logo、简介里写的禁转都不算。\n' +
  'ai_suspect: 画面像 AI 生成（结构错乱、细节糊成一团、典型 AI 质感），或正文/简介带 #AIart #AIイラスト 等标签时为 true。\n' +
  'cn_artist_suspect: 作者看起来是中国大陆画师或模型师（简介或正文用简体中文、写了中国城市、贴了微博/B站/小红书链接等）时为 true。\n' +
  'not_original: 发帖人明显不是作者本人（正文写 Credit / 出处 / 転載 / via 某人，或账号是搬运号、资讯号）时为 true。\n' +
  'subject: 图里的主要机体或人物。正文或标签里写了名字（常见是片假名或英文、型号、HG/MG 商品名）就以正文为准，' +
  '换成中文圈通行译名；没有把握的中文译名就直接保留原文写法（如「リ・ガズィ・カスタム」），绝不凭字面音译。' +
  '正文没写时才看图辨认，认不出就写空字符串。\n' +
  'work: 出处作品的中文通行译名，只在确定时填写，否则写空字符串。\n' +
  'keep_text: 默认 false。只有原文是一句有梗、有情绪、让人想笑的话（不是作品说明、制作过程、宣传、标签、署名、链接）时才为 true。\n' +
  'text_zh: keep_text 为 true 时给出那句话的中文译文（去掉标签和链接），否则空字符串。\n' +
  'reason: 若任一 true 标记，用一句中文说明依据；否则空字符串。';

export async function reviewTweet(env: Env, c: Candidate, imageUrls: string[]): Promise<Review> {
  if (!env.DEEPSEEK_API_KEY) throw new Error('未配置 DEEPSEEK_API_KEY，无法看图。');
  const images = (await Promise.all(imageUrls.slice(0, MAX_IMGS).map(toDataUrl))).filter(Boolean) as string[];
  if (!images.length) throw new Error('图片下载失败，无法看图');

  const info = [`[作者] @${c.author}`, c.bio ? `[简介] ${c.bio}` : '', `[正文] ${c.text || '（无）'}`]
    .filter(Boolean)
    .join('\n');

  const r = await fetch(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: [
            { type: 'text', text: info },
            ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
          ],
        },
      ],
      response_format: { type: 'json_object' },
      // 开思考：实测认机体和出处明显更准（12 条样本），每条约 8s，Worker 只算 CPU 不算等待
      thinking: { type: 'enabled' },
      max_tokens: 4000,
      stream: false,
    }),
  });
  if (!r.ok) {
    const e = await r.text().catch(() => '');
    throw new Error(`看图接口出错 (${r.status}): ${e.slice(0, 200)}`);
  }
  const j: any = await r.json();
  let out: any = {};
  try {
    out = JSON.parse(j?.choices?.[0]?.message?.content || '{}');
  } catch {
    throw new Error('看图结果不是合法 JSON');
  }
  const s = (v: any) => (typeof v === 'string' ? v.trim() : '');
  return {
    not_gundam: !!out.not_gundam,
    low_value: !!out.low_value,
    no_repost_watermark: !!out.no_repost_watermark,
    ai_suspect: !!out.ai_suspect,
    cn_artist_suspect: !!out.cn_artist_suspect,
    not_original: !!out.not_original,
    subject: s(out.subject),
    work: s(out.work),
    keep_text: !!out.keep_text,
    text_zh: out.keep_text ? s(out.text_zh) : '',
    reason: s(out.reason),
  };
}

// 简洁配文：只写机体/人物，不带作品名；原文有趣才附译文。末行署名交给 composeCaption
export function shortBody(rv: Review): string {
  return [rv.subject, rv.keep_text ? rv.text_zh : ''].filter(Boolean).join('\n\n');
}
