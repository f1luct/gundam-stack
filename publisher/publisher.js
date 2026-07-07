// gundam-publisher — 跑在 N150 上的微博发布服务
// 网页点「发布到微博」→ Worker 转发到这里 → 下载卡片图片 → opencli 驱动本地 Chrome 发布
//
// 依赖:Node 22+(自带 fetch),全局安装的 opencli,Chrome + Browser Bridge 扩展 + 已登录微博
// 配置:同目录 config.json  { "port": 8790, "pubToken": "...", "opencliDir": 可选覆盖 }
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execSync } = require('node:child_process');

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const PORT = CFG.port || 8790;
// 临时图片放本目录下(不用系统 %TEMP%):服务以 SYSTEM 跑,Chrome 在用户会话,
// SYSTEM 的临时目录 Chrome 读不到 → CDP 塞文件静默失败,只发出文字
const TMP_ROOT = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const MAX_IMG = 9; // 微博上限
const MAX_IMG_BYTES = 20 * 1024 * 1024;
const OPENCLI_TIMEOUT_MS = 180 * 1000;

/* ---------- 启动时解析 opencli 的 JS 入口(spawn .cmd 有坑,直接 node 调入口最稳) ---------- */

function resolveOpencli() {
  const candidates = [];
  if (CFG.opencliDir) candidates.push(CFG.opencliDir);
  try {
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
    candidates.push(path.join(root, '@jackwener', 'opencli'));
    candidates.push(path.join(root, 'opencli'));
  } catch {
    /* npm 不在 PATH 时靠 config.opencliDir */
  }
  for (const dir of candidates) {
    const pkgPath = path.join(dir, 'package.json');
    if (!fs.existsSync(pkgPath)) continue;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    let bin = pkg.bin;
    if (typeof bin === 'object') bin = bin.opencli || Object.values(bin)[0];
    if (!bin) continue;
    const entry = path.join(dir, bin);
    if (fs.existsSync(entry)) return entry;
  }
  return null;
}

const OPENCLI_JS = resolveOpencli();
console.log('[publisher] opencli entry:', OPENCLI_JS || '未找到(装好后重启本服务)');

// 每次启动确保带图发布补丁在位(opencli 更新会覆盖,这里自愈)。
// OPENCLI_JS = <dir>/dist/src/main.js → opencli 根目录要往上退两级
if (OPENCLI_JS) {
  try {
    const openDir = path.resolve(path.dirname(OPENCLI_JS), '..', '..');
    const { applyPatch } = require('./patch-opencli.js');
    console.log('[publisher] 补丁:', applyPatch(openDir));
  } catch (e) {
    console.error('[publisher] 补丁失败(带图发布可能异常):', e.message);
  }
}

/* ---------- 工具 ---------- */

function tokenOk(header) {
  const got = (header || '').replace(/^Bearer\s+/i, '');
  const want = CFG.pubToken || '';
  if (!got || !want || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

function extFromMime(m) {
  if (/png/i.test(m)) return '.png';
  if (/gif/i.test(m)) return '.gif';
  if (/webp/i.test(m)) return '.webp';
  return '.jpg';
}

async function downloadImages(urls, bearer, dir) {
  const files = [];
  let i = 0;
  for (const u of urls.slice(0, MAX_IMG)) {
    const r = await fetch(u, { headers: { Authorization: `Bearer ${bearer}` } });
    if (!r.ok) throw new Error(`下载图片失败 (${r.status}): ${u}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_IMG_BYTES) throw new Error(`图片过大: ${u}`);
    const f = path.join(dir, `img-${i++}${extFromMime(r.headers.get('content-type') || '')}`);
    fs.writeFileSync(f, buf);
    files.push(f);
  }
  return files;
}

function runOpencli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [OPENCLI_JS, ...args], {
      windowsHide: true,
      timeout: OPENCLI_TIMEOUT_MS,
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => resolve({ code: -1, out: String(e) }));
    child.on('close', (code) => resolve({ code, out }));
  });
}

/* ---------- 发布队列:一次只跑一个,避免两次自动化在 Chrome 里打架 ---------- */

let chain = Promise.resolve();
function enqueue(job) {
  const p = chain.then(job, job);
  chain = p.catch(() => {});
  return p;
}

// 最近几条里有没有这次要发的(按前若干字比对，忽略空白/零宽字符；查多条防并发错位)
async function checkPostedOnce(caption) {
  if (!CFG.weiboUid) return false;
  const { code, out } = await runOpencli([
    'weibo', 'user-posts', String(CFG.weiboUid), '--limit', '5', '-f', 'json',
  ]);
  if (code !== 0) return false;
  try {
    const arr = JSON.parse(out.slice(out.indexOf('['), out.lastIndexOf(']') + 1));
    const norm = (s) => (s || '').replace(/[\s​‌﻿]/g, '');
    const want = norm(caption).slice(0, 12);
    if (want.length < 4) return false;
    return (arr || []).some((p) => norm(p.text).startsWith(want));
  } catch {
    return false;
  }
}

// 「结果不明」时轮询核实是否其实发出去了(提交/服务端处理有延迟；也防误报失败→重发)
async function verifyPosted(caption) {
  for (let i = 0; i < 4; i++) {
    if (await checkPostedOnce(caption)) return true;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return false;
}

async function doPublish({ caption, images, token }) {
  if (!OPENCLI_JS) throw new Error('N150 上还没装好 opencli(或没重启发布服务)');
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'pub-'));
  try {
    // 预检防重复:同一张卡被排队两次(用户连点/重试)时,第二次发现时间线上
    // 已有该条就直接算成功,绝不重复发出去
    if (await checkPostedOnce(caption)) {
      console.log('[publisher] 预检:时间线已有该条,跳过重复发布');
      return '时间线已存在,跳过';
    }
    const files = images && images.length ? await downloadImages(images, token, dir) : [];
    // ephemeral:每次开全新标签页,避免复用标签页的残留状态
    const args = ['weibo', 'publish', caption || '', '--site-session', 'ephemeral'];
    if (files.length) args.push('--images', files.join(','));
    console.log(`[publisher] 发布中: ${files.length} 图, 文案 ${caption.length} 字`);
    const { code, out } = await runOpencli(args);

    // opencli 靠页面抓字判断成功/失败,既会漏判("结果不明")也会误判(把"创作者中心"
    // 侧栏的"发送失败"标签当成结果)。改用地面真相:发完查时间线,出现了就是成功。
    if (await verifyPosted(caption)) {
      console.log('[publisher] 时间线已确认发出' + (code !== 0 ? '(opencli 自判失败,已忽略)' : ''));
      return out;
    }
    // 时间线里没有 —— 真没发出去
    const tail = out.replace(/\s+/g, ' ').slice(-300);
    throw new Error(
      code !== 0
        ? `发布未成功(opencli 退出码 ${code}): ${tail}`
        : `opencli 报成功但时间线未出现该条,请稍后手动确认`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ---------- HTTP ---------- */

const server = http.createServer((req, res) => {
  const send = (status, obj) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'GET' && req.url === '/health') {
    return send(200, { ok: true, opencli: !!OPENCLI_JS });
  }
  if (req.method !== 'POST' || req.url !== '/publish') return send(404, { error: 'not found' });
  if (!tokenOk(req.headers.authorization)) return send(401, { error: 'bad token' });

  // 按 Buffer 收集再整体解码——逐块 += 会把跨块的多字节 UTF-8 字符切成乱码
  const chunks = [];
  let received = 0;
  req.on('data', (d) => {
    received += d.length;
    if (received > 1024 * 1024) return req.destroy();
    chunks.push(d);
  });
  req.on('end', () => {
    let payload;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return send(400, { error: 'bad json' });
    }
    enqueue(() => doPublish(payload))
      .then((out) => send(200, { ok: true, output: out.slice(-500) }))
      .catch((e) => {
        console.error('[publisher] 失败:', e.message);
        send(500, { error: e.message });
      });
  });
});

// 只听本机,由 cloudflared 隧道对外
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[publisher] listening on 127.0.0.1:${PORT}`);
});

/* ---------- 定时轮询:每分钟问 Worker 有没有到点的定时卡片 ---------- */

const SCHED_POLL_MS = 60 * 1000;
const inFlight = new Set(); // 正在发布的卡片 id,防同一张被两轮抓两次

async function pollScheduled() {
  const base = (CFG.workerUrl || '').replace(/\/+$/, '');
  if (!base || !CFG.pubToken) return;
  const auth = { Authorization: `Bearer ${CFG.pubToken}` };
  let due = [];
  try {
    const r = await fetch(base + '/api/scheduled/due', { headers: auth });
    if (!r.ok) return;
    due = (await r.json()).due || [];
  } catch {
    return; // Worker 够不到就下一轮再说
  }
  for (const card of due) {
    if (inFlight.has(card.id)) continue;
    inFlight.add(card.id);
    enqueue(() => doPublish(card))
      .then(async () => {
        console.log(`[scheduler] 定时发布成功: ${card.id}`);
        await fetch(`${base}/api/scheduled/${card.id}/done`, { method: 'POST', headers: auth }).catch(() => {});
      })
      .catch(async (e) => {
        console.error(`[scheduler] 定时发布失败 ${card.id}:`, e.message);
        // 清掉定时,停止重试,留在待发让用户手动处理
        await fetch(`${base}/api/scheduled/${card.id}/failed`, { method: 'POST', headers: auth }).catch(() => {});
      })
      .finally(() => inFlight.delete(card.id));
  }
}

if (CFG.workerUrl) {
  setInterval(() => pollScheduled().catch(() => {}), SCHED_POLL_MS);
  console.log('[publisher] 定时轮询已启动，每 60s 检查一次');
} else {
  console.log('[publisher] 未配 workerUrl，定时轮询关闭');
}
