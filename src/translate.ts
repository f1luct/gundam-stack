import type { Env } from './types';

// DeepSeek V4（OpenAI 兼容接口）：推文翻译用 Flash（快且便宜），
// 新闻快讯用 Pro（写作质量更好，量小成本可忽略）
const MODEL_FLASH = 'deepseek-v4-flash';
const MODEL_PRO = 'deepseek-v4-pro';
const API_URL = 'https://api.deepseek.com/chat/completions';

const STYLE_HINT: Record<string, string> = {
  直译: '尽量逐字直译，忠实原文，不增不减。',
  意译: '通顺自然的意译，保留原意、语气和情绪。',
  微博口语风: '转成适合微博发布的中文口语风格，可以更生动接地气，但绝不能编造原文没有的信息。',
};

// 把日文/英文推文翻成简体中文，返回建议文本（不写库，仅供前端预填）
export async function translate(env: Env, text: string, style?: string): Promise<string> {
  if (!env.DEEPSEEK_API_KEY) {
    throw new Error('未配置 DEEPSEEK_API_KEY，无法翻译。');
  }
  const src = (text || '').trim();
  if (!src) return '';

  const hint = STYLE_HINT[style || '意译'] || STYLE_HINT['意译'];
  const system =
    `你是把日文/英文推文翻译成简体中文的助手。要求：${hint}` +
    '保留原文中的 emoji 和换行。只输出翻译后的中文正文，不要加任何解释、引号、前后缀或“翻译：”之类的字样。';

  const r = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL_FLASH,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: src },
      ],
      thinking: { type: 'disabled' }, // 翻译不需要思考链，关掉更快更省
      max_tokens: 1024,
      stream: false,
    }),
  });

  if (!r.ok) {
    const e = await r.text().catch(() => '');
    throw new Error(`翻译接口出错 (${r.status}): ${e.slice(0, 200)}`);
  }
  const j: any = await r.json();
  return (j?.choices?.[0]?.message?.content || '').trim();
}

// 把官网日文新闻整理成适合直接发微博的中文快讯
export async function summarizeNews(
  env: Env,
  input: { title: string; summary?: string; body: string; series?: string[] },
): Promise<string> {
  if (!env.DEEPSEEK_API_KEY) {
    throw new Error('未配置 DEEPSEEK_API_KEY，无法生成摘要。');
  }
  const system =
    '你是高达资讯微博博主的编辑。把万代官方的日文新闻整理成适合直接发微博的简体中文快讯。要求：' +
    '第一行是一句抓眼球的中文标题（可用【】括起）；随后用 2-4 句话讲清楚关键信息；' +
    '发售日期、预约/活动时间、价格、地点、商品名等硬信息必须保留且准确；' +
    '高达作品名用中文圈通行译名（如 機動戦士ガンダム→机动战士高达、ガンプラ→高达模型/钢普拉）；' +
    '绝不编造原文没有的信息；不要用 markdown 记号；只输出快讯正文，不要任何解释或前后缀。';
  const user = [
    input.series?.length ? `[系列] ${input.series.join(' / ')}` : '',
    `[标题] ${input.title}`,
    input.summary ? `[导语] ${input.summary}` : '',
    `[正文]\n${(input.body || '').slice(0, 6000)}`,
  ]
    .filter(Boolean)
    .join('\n');

  const r = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL_PRO,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      thinking: { type: 'disabled' },
      max_tokens: 700,
      stream: false,
    }),
  });

  if (!r.ok) {
    const e = await r.text().catch(() => '');
    throw new Error(`摘要接口出错 (${r.status}): ${e.slice(0, 200)}`);
  }
  const j: any = await r.json();
  return (j?.choices?.[0]?.message?.content || '').trim();
}
