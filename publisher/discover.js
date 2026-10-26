// 自动找帖:定时用 opencli 读 X(关注列表 + 标签搜索),挑互动高的图片帖,逐条送 Worker 看图入草稿
// 走同一个 Chrome、同一条串行队列,不会和微博发布抢浏览器
'use strict';

const DEFAULTS = {
  listId: '', // x.com/i/lists/<数字>
  tags: ['#ガンプラ', '#gunpla', '#ガンプラ製作', '#ガンダムイラスト', '#MSイラスト', '#ガンダム'],
  intervalHours: 4,
  listMinLikes: 0, // 关注列表本来就是挑过的人,不卡赞数
  tagMinLikes: 100, // 标签搜索噪音大,卡个门槛
  maxAgeHours: 48,
  maxPerRound: 12, // 每轮最多送 Worker 多少条(每条一次看图调用)
};

function parseJsonArray(out) {
  const a = out.indexOf('[');
  const b = out.lastIndexOf(']');
  if (a < 0 || b < a) return [];
  try {
    return JSON.parse(out.slice(a, b + 1)) || [];
  } catch {
    return [];
  }
}

const isPhoto = (u) => /pbs\.twimg\.com\/media\//.test(u || '');

function startDiscover({ CFG, runOpencliRetry, enqueue }) {
  const opt = { ...DEFAULTS, ...(CFG.discover || {}) };
  const base = (CFG.workerUrl || '').replace(/\/+$/, '');
  if (!CFG.discover || !base || !CFG.pubToken) {
    console.log('[discover] 未配 discover / workerUrl,自动找帖关闭');
    return { runOnce: async () => 'disabled' };
  }
  const sent = new Set(); // 本进程送过的,省得每轮都问 Worker
  let running = false;

  async function read(args, via, minLikes) {
    const { code, out } = await runOpencliRetry(['twitter', ...args, '-f', 'json']);
    if (code !== 0) {
      console.error(`[discover] ${via} 读取失败:`, out.replace(/\s+/g, ' ').slice(-200));
      return [];
    }
    const cutoff = Date.now() - opt.maxAgeHours * 3600 * 1000;
    return parseJsonArray(out)
      .filter((t) => (t.media_urls || []).some(isPhoto))
      .filter((t) => Number(t.likes || 0) >= minLikes)
      .filter((t) => !t.created_at || Date.parse(t.created_at) >= cutoff)
      .map((t) => ({ ...t, via }));
  }

  async function collect() {
    const all = [];
    if (opt.listId) {
      all.push(...(await read(['list-tweets', String(opt.listId), '--limit', '80'], 'list', opt.listMinLikes)));
    }
    for (const tag of opt.tags) {
      // 原创帖 + 带图;搜索返回已按互动排序后取前 15
      const q = `${tag} -filter:retweets -filter:replies`;
      all.push(
        ...(await read(['search', q, '--product', 'photos', '--limit', '40', '--top-by-engagement', '15'], tag, opt.tagMinLikes)),
      );
    }
    // 同一条可能多个来源都命中,留第一个;关注列表优先,再按赞数
    const byId = new Map();
    for (const t of all) if (!byId.has(t.id)) byId.set(t.id, t);
    return [...byId.values()]
      .filter((t) => !sent.has(t.id))
      .sort((a, b) => (b.via === 'list') - (a.via === 'list') || Number(b.likes || 0) - Number(a.likes || 0))
      .slice(0, opt.maxPerRound);
  }

  async function runOnce() {
    if (running) return 'busy';
    running = true;
    try {
      // 读 X 占用 Chrome,排进发布队列里串行跑
      const picks = await enqueue(collect);
      const tally = {};
      for (const t of picks) {
        try {
          const r = await fetch(base + '/api/discover/candidate', {
            method: 'POST',
            headers: { 'content-type': 'application/json', Authorization: `Bearer ${CFG.pubToken}` },
            body: JSON.stringify({
              id: t.id,
              url: t.url,
              author: t.author,
              bio: t.bio,
              text: t.text,
              likes: t.likes,
              media_urls: t.media_urls,
              via: t.via,
            }),
          });
          const j = await r.json().catch(() => ({}));
          const k = j.result || 'error';
          tally[k] = (tally[k] || 0) + 1;
          if (j.result) sent.add(t.id); // 出错的不记,下轮重试
          if (j.error) console.error(`[discover] ${t.url}:`, j.error);
        } catch (e) {
          tally.error = (tally.error || 0) + 1;
          console.error('[discover] 够不到 Worker:', e.message);
        }
      }
      const summary = `候选 ${picks.length} 条 → ` + JSON.stringify(tally);
      console.log('[discover]', summary);
      return summary;
    } finally {
      running = false;
    }
  }

  const ms = opt.intervalHours * 3600 * 1000;
  // 启动 2 分钟后先跑一轮(等 Chrome 起来),之后按间隔跑
  setTimeout(() => runOnce().catch((e) => console.error('[discover]', e.message)), 2 * 60 * 1000);
  setInterval(() => runOnce().catch((e) => console.error('[discover]', e.message)), ms);
  console.log(`[discover] 自动找帖已启动,每 ${opt.intervalHours} 小时一轮`);
  return { runOnce };
}

module.exports = { startDiscover };
