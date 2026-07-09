'use strict';

const $app = document.getElementById('app');
const $toast = document.getElementById('toast');

let state = { tab: 'inbox', src: 'all', cards: [], counts: { inbox: 0, queued: 0, posted: 0 } };
let toastTimer = null;

/* ---------------- 工具 ---------------- */

function toast(msg, isErr) {
  $toast.textContent = msg;
  $toast.className = 'toast' + (isErr ? ' err' : '');
  $toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $toast.hidden = true; }, 2800);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  if (res.status === 401) { renderLogin(); throw new Error('unauthorized'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

function composeCaption(body, handle) {
  const b = (body || '').trim();
  const tag = handle ? 'X: @' + handle : '';
  return [b, tag].filter(Boolean).join('\n\n');
}

function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ---------------- 日/夜主题 ---------------- */

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('gs_theme', t); } catch (e) { /* 隐私模式忽略 */ }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = t === 'light' ? '#e3e7ec' : '#0a0e14';
  const btn = document.getElementById('themeBtn');
  if (btn) btn.textContent = t === 'light' ? '☾ NIGHT' : '☀ DAY'; // 按钮显示要切去的模式
}

function currentTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

/* 配文框高度自动跟内容，不用手动拉 */
function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 2 + 'px';
}

/* epoch ms ↔ <input type=datetime-local> 的本地时间字符串 */
function toLocalInput(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtSched(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ---------------- 剪贴板 ---------------- */

async function pngFrom(url) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error('图片加载失败');
  const blob = await res.blob();
  if (blob.type === 'image/png') return blob;
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext('2d').drawImage(bmp, 0, 0);
  return await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('转码失败'))), 'image/png'));
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

function copyImage(url) {
  const supported =
    navigator.clipboard && 'write' in navigator.clipboard && typeof ClipboardItem !== 'undefined';
  if (supported) {
    // 关键：把 Promise<Blob> 直接交给 ClipboardItem，不要先 await，否则 Safari 丢失用户手势
    navigator.clipboard
      .write([new ClipboardItem({ 'image/png': pngFrom(url) })])
      .then(() => toast('图像已复制 — 去微博 Ctrl+V 粘贴'))
      .catch(async (e) => {
        try {
          downloadBlob(await pngFrom(url), 'image.png');
          toast('无法直接复制，已改为下载');
        } catch (_) {
          toast('复制失败：' + e.message, true);
        }
      });
  } else {
    pngFrom(url)
      .then((b) => { downloadBlob(b, 'image.png'); toast('浏览器不支持复制，已下载'); })
      .catch((e) => toast('失败：' + e.message, true));
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('文案已复制');
  } catch (e) {
    toast('复制失败：' + e.message, true);
  }
}

/* ---------------- 认证 / 登录 ---------------- */

function renderLogin() {
  $app.innerHTML = `
    <div class="auth">
      <div class="auth-frame">
        <div class="auth-eyebrow">// AUTHORIZATION REQUIRED</div>
        <h1 class="auth-title">高达暂存站</h1>
        <div class="auth-sub">MS CONTROL · 出撃管制システム</div>
        <form class="auth-form" id="loginForm">
          <input type="text" name="username" value="pilot" autocomplete="username" hidden />
          <label class="field-label" for="pw">PASSCODE · 通行码</label>
          <input id="pw" type="password" placeholder="••••••••" autocomplete="current-password" autofocus />
          <button class="btn-launch" type="submit">认证进入 · AUTHORIZE</button>
        </form>
        <div class="auth-foot"><i class="dot"></i> SYS STANDBY — 等待授权</div>
      </div>
    </div>`;
  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = document.getElementById('pw').value;
    try {
      await api('/api/login', { method: 'POST', body: JSON.stringify({ password }) });
      boot();
    } catch (err) {
      toast(err.message === 'unauthorized' ? '通行码错误' : err.message, true);
    }
  });
}

/* ---------------- 主界面 ---------------- */

const TABS = [
  { key: 'inbox', cn: '草稿', en: 'DRAFT' },
  { key: 'queued', cn: '待发', en: 'QUEUED' },
  { key: 'posted', cn: '已发', en: 'POSTED' },
];

const STATUS_TOAST = {
  queued: '已移到待发',
  posted: '已标记已发',
  inbox: '已退回草稿',
};

const EMPTY = {
  inbox: '<b>草稿箱为空</b>粘贴一条 X 链接，或点「官方新闻」抓官网资讯',
  queued: '<b>没有待发内容</b>从草稿把内容移到这里',
  posted: '<b>没有已发记录</b>',
};

function renderShell() {
  $app.innerHTML = `
    <header class="hud">
      <div class="hud-inner">
        <div class="hud-bar">
          <span class="hud-mark">G</span>
          <div class="hud-id">
            <span class="hud-name">GUNDAM<b>·</b>STACK</span>
            <span class="hud-tag">高达暂存站 / MS CONTROL</span>
          </div>
          <span class="sys"><i class="dot"></i> SYS ALL GREEN</span>
          <button class="btn-ghost" id="themeBtn" title="切换日/夜配色"></button>
          <button class="btn-ghost" id="logout">登出</button>
        </div>
        <div class="acquire">
          <span class="acquire-label">LINK ACQUISITION</span>
          <input id="url" type="url" inputmode="url" placeholder="粘贴 X / Twitter 推文链接…" />
          <button class="btn-acquire" id="addBtn">抓取</button>
          <button class="btn-news" id="newsBtn" title="抓取 gundam-official.com 最新新闻，AI 生成中文快讯">官方新闻</button>
        </div>
        <nav class="states" id="tabs"></nav>
        <div class="srcbar" id="srcbar"></div>
      </div>
    </header>
    <main class="deck"><div class="cards" id="cards"></div></main>`;

  document.getElementById('logout').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    renderLogin();
  });

  applyTheme(currentTheme()); // 初始化按钮文字
  document.getElementById('themeBtn').addEventListener('click', () =>
    applyTheme(currentTheme() === 'light' ? 'dark' : 'light'));

  const urlInput = document.getElementById('url');
  const add = async () => {
    const url = urlInput.value.trim();
    if (!url) return;
    const btn = document.getElementById('addBtn');
    btn.disabled = true;
    btn.textContent = '抓取中…';
    try {
      const { duplicate } = await api('/api/cards/ingest', {
        method: 'POST',
        body: JSON.stringify({ url }),
      });
      urlInput.value = '';
      toast(duplicate ? '该内容已在库中' : '已抓取 · 存入草稿');
      state.tab = 'inbox';
      await loadCards();
    } catch (err) {
      if (err.message !== 'unauthorized') toast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = '抓取';
    }
  };
  document.getElementById('addBtn').addEventListener('click', add);
  urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });

  // 连续拉取：服务端每轮最多 3 篇（免费版子请求预算），
  // 前端自动一轮轮拉到官网第一页全部入库为止
  const newsBtn = document.getElementById('newsBtn');
  newsBtn.addEventListener('click', async () => {
    newsBtn.disabled = true;
    newsBtn.textContent = '侦察中…';
    let total = 0;
    let failed = 0;
    try {
      for (let round = 1; round <= 6; round++) {
        const r = await api('/api/news/pull', { method: 'POST', body: JSON.stringify({ limit: 3 }) });
        total += r.addedCount;
        failed += r.failed || 0;
        if (r.addedCount > 0) {
          newsBtn.textContent = `已入库 ${total} 篇…`;
          state.tab = 'inbox';
          await loadCards(); // 边拉边上屏
        }
        if (!r.remaining) break;
        if (r.addedCount === 0 && r.failed > 0) break; // 整轮都失败就别空转了
      }
      if (total > 0) {
        toast(`官方新闻 +${total} 篇进草稿` + (failed ? `（${failed} 篇失败）` : ''));
      } else if (failed > 0) {
        toast('抓取失败了，稍后再试', true);
      } else {
        toast('官网暂无新新闻');
      }
    } catch (err) {
      if (err.message !== 'unauthorized') toast(err.message, true);
    } finally {
      newsBtn.disabled = false;
      newsBtn.textContent = '官方新闻';
    }
  });

  renderTabs();
}

function renderTabs() {
  const el = document.getElementById('tabs');
  el.innerHTML = TABS.map((t) => {
    const active = t.key === state.tab;
    const cnt = state.counts[t.key] ?? 0;
    return `<button class="state ${active ? 'active' : ''}" data-tab="${t.key}">
        <span class="state-cn">${t.cn}</span>
        <span class="state-en">${t.en}</span>
        <span class="state-count">${cnt}</span>
      </button>`;
  }).join('');
  el.querySelectorAll('.state').forEach((b) =>
    b.addEventListener('click', () => { state.tab = b.dataset.tab; loadCards(); }));
}

async function loadCards() {
  try {
    const [list, count] = await Promise.all([
      api('/api/cards?status=' + encodeURIComponent(state.tab)),
      api('/api/counts'),
    ]);
    state.cards = list.cards;
    state.counts = count.counts;
    renderTabs();
    renderSrcBar();
    renderCards();
  } catch (err) {
    if (err.message !== 'unauthorized') toast(err.message, true);
  }
}

// 来源筛选条:全部 / X / 新闻;当前标签下按来源过滤,新闻筛选时提供一键清空草稿
function renderSrcBar() {
  const el = document.getElementById('srcbar');
  const news = state.cards.filter((c) => c.source_type === 'news').length;
  const chips = [
    { key: 'all', label: '全部', n: state.cards.length },
    { key: 'x', label: 'X', n: state.cards.length - news },
    { key: 'news', label: '新闻', n: news },
  ]
    .map(
      (f) =>
        `<button class="chip ${state.src === f.key ? 'active' : ''}" data-src="${f.key}">${f.label}<b>${f.n}</b></button>`,
    )
    .join('');
  const clearBtn =
    state.tab === 'inbox' && state.src === 'news' && news
      ? '<button class="chip chip-danger" id="clearNews">✕ 清空新闻草稿</button>'
      : '';
  el.innerHTML = chips + clearBtn;
  el.querySelectorAll('[data-src]').forEach((b) =>
    b.addEventListener('click', () => {
      state.src = b.dataset.src;
      renderSrcBar();
      renderCards();
    }),
  );
  const clr = document.getElementById('clearNews');
  if (clr)
    clr.addEventListener('click', async () => {
      if (!confirm(`清空全部 ${news} 条新闻草稿？\n清掉的新闻不会被重新拉取。`)) return;
      clr.disabled = true;
      clr.textContent = '清空中…';
      try {
        // 服务端每轮最多删 5 张（子请求预算），循环到删完
        let removed = 0;
        for (let i = 0; i < 12; i++) {
          const r = await api('/api/news/clear', { method: 'POST' });
          removed += r.removed;
          if (!r.remaining) break;
        }
        toast(`已清空 ${removed} 条新闻草稿`);
      } catch (err) {
        if (err.message !== 'unauthorized') toast(err.message, true);
      }
      await loadCards();
    });
}

// 发布跟踪:点发布后每 6s 查一次该卡,发出/失败自动提示并刷新(最多跟 3 分钟)。
// 刷新页面后对仍在"发布中"的卡会自动续上(cardEl 里重新挂)。
const watching = new Set();
function watchPosted(id) {
  if (watching.has(id)) return;
  watching.add(id);
  let tries = 0;
  const timer = setInterval(async () => {
    if (++tries > 30) { watching.delete(id); clearInterval(timer); return; }
    let card;
    try {
      card = (await api('/api/cards/' + id)).card;
    } catch (err) {
      if (err.message === 'unauthorized') { watching.delete(id); clearInterval(timer); }
      return; // 网络抖动，下一轮再查
    }
    if (card.status === 'posted') {
      watching.delete(id);
      clearInterval(timer);
      toast('已发布到微博 ✓');
      await loadCards();
    } else if (card.status === 'queued' && !card.scheduled_at) {
      watching.delete(id);
      clearInterval(timer);
      toast('发布失败，已退回待发', true);
      await loadCards();
    }
  }, 6000);
}

function renderCards() {
  const box = document.getElementById('cards');
  box.innerHTML = '';
  const shown =
    state.src === 'all'
      ? state.cards
      : state.cards.filter((c) => (state.src === 'news') === (c.source_type === 'news'));
  if (!shown.length) {
    box.innerHTML = `<div class="empty">${
      state.cards.length ? '<b>该来源下无内容</b>切换上面的筛选看看' : EMPTY[state.tab] || '<b>无内容</b>'
    }</div>`;
    return;
  }
  for (const card of shown) box.appendChild(cardEl(card));
  // 入 DOM 后才有 scrollHeight，统一把配文框撑到和内容等高
  box.querySelectorAll('textarea').forEach(autosize);
}

function cardEl(card) {
  const root = document.createElement('article');
  root.className = 'unit';
  root.dataset.status = card.status;
  root.dataset.src = card.source_type;

  const srcBadge = { twitter: 'X', news: 'NEWS', manual: 'MANUAL' }[card.source_type] || 'SRC';
  const code = '#' + String(card.id).replace(/-/g, '').slice(0, 4).toUpperCase();
  let handle;
  if (card.author_handle) {
    handle = `<a class="unit-handle" href="${esc(card.source_url || '#')}" target="_blank" rel="noopener">@${esc(card.author_handle)}</a>`;
  } else if (card.source_type === 'news' && card.source_url) {
    handle = `<a class="unit-handle" href="${esc(card.source_url)}" target="_blank" rel="noopener">官网原文 ↗</a>`;
  } else {
    handle = '<span class="unit-code">—</span>';
  }

  // 新闻卡片显示日文原标题，方便对照识别
  let meta = {};
  try { meta = JSON.parse(card.meta_json || '{}'); } catch { /* 忽略坏数据 */ }
  const newsTitle = card.source_type === 'news' && meta.title
    ? `<div class="unit-title">${esc(meta.title)}</div>`
    : '';

  const shots = (card.images || [])
    .map(
      (im) => `
      <figure class="shot">
        <div class="frame"><img src="${esc(im.url)}" loading="lazy" alt="" /></div>
        <div class="shot-ctrl">
          <button data-copyimg="${esc(im.url)}">复制图像</button>
          <button class="btn-ghost" data-dlimg="${esc(im.url)}">存档</button>
        </div>
      </figure>`,
    )
    .join('');

  // 定时时间已到=正在被 N150 处理，显示发布中并挂上跟踪
  const publishing = card.status === 'queued' && card.scheduled_at && card.scheduled_at <= Date.now() + 65000;
  const schedBadge = publishing
    ? '<span class="sched-badge">⏳ 发布中…</span>'
    : card.status === 'queued' && card.scheduled_at
      ? `<span class="sched-badge">⏰ ${fmtSched(card.scheduled_at)} 定时</span>`
      : '';
  if (publishing) watchPosted(card.id);

  root.dataset.scheduled = card.status === 'queued' && card.scheduled_at ? '1' : '';
  root.innerHTML = `
    <span class="unit-spine"></span>
    <header class="unit-head">
      <span class="tag">${esc(srcBadge)}</span>
      ${handle}
      <span class="flex"></span>
      ${schedBadge}
      <span class="unit-code">${esc(code)}</span>
      <span class="unit-time">${fmtTime(card.created_at)}</span>
    </header>
    ${newsTitle}
    ${shots ? `<div class="visual"><div class="shots">${shots}</div></div>` : ''}
    <div class="body">
      <div class="body-label">CAPTION · 配文</div>
      <textarea spellcheck="false"></textarea>
      <div class="tools">
        <button class="btn-copy" data-act="copytext">复制文案</button>
        <button class="btn-ghost" data-act="translate">翻译</button>
        <select data-style>
          <option value="意译">意译 PARAPHRASE</option>
          <option value="直译">直译 LITERAL</option>
          <option value="微博口语风">微博风 CASUAL</option>
        </select>
        <span class="flex"></span>
        <span class="saved" data-saved>SAVED ✓</span>
      </div>
    </div>
    <footer class="unit-foot"></footer>`;

  const ta = root.querySelector('textarea');
  ta.value = card.caption || '';
  let dirty = false;
  ta.addEventListener('input', () => { dirty = true; autosize(ta); });

  const savedTag = root.querySelector('[data-saved]');
  const save = async () => {
    if (!dirty) return;
    try {
      await api('/api/cards/' + card.id, {
        method: 'PATCH',
        body: JSON.stringify({ caption: ta.value }),
      });
      card.caption = ta.value;
      dirty = false;
      savedTag.classList.add('show');
      setTimeout(() => savedTag.classList.remove('show'), 1400);
    } catch (err) {
      if (err.message !== 'unauthorized') toast(err.message, true);
    }
  };
  ta.addEventListener('blur', save);

  root.querySelectorAll('[data-copyimg]').forEach((b) =>
    b.addEventListener('click', () => copyImage(b.dataset.copyimg)));
  root.querySelectorAll('[data-dlimg]').forEach((b) =>
    b.addEventListener('click', async () => {
      try { downloadBlob(await pngFrom(b.dataset.dlimg), 'image.png'); }
      catch (e) { toast('失败：' + e.message, true); }
    }));

  root.querySelector('[data-act="copytext"]').addEventListener('click', () => copyText(ta.value));
  root.querySelector('[data-act="translate"]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const style = root.querySelector('[data-style]').value;
    btn.disabled = true;
    btn.textContent = '翻译中…';
    try {
      const { text } = await api('/api/cards/' + card.id + '/translate', {
        method: 'POST',
        body: JSON.stringify({ style }),
      });
      ta.value = composeCaption(text, card.author_handle);
      autosize(ta);
      dirty = true;
      toast('已填入译文，可继续编辑');
    } catch (err) {
      if (err.message !== 'unauthorized') toast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = '翻译';
    }
  });

  const foot = root.querySelector('.unit-foot');
  const mkBtn = (label, cls, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (cls) b.className = cls;
    b.addEventListener('click', fn);
    return b;
  };
  const setStatus = async (status) => {
    await save();
    try {
      await api('/api/cards/' + card.id, { method: 'PATCH', body: JSON.stringify({ status }) });
      toast(STATUS_TOAST[status] || '已更新');
      await loadCards();
    } catch (err) {
      if (err.message !== 'unauthorized') toast(err.message, true);
    }
  };
  const del = async () => {
    if (!confirm('删除这条？图片也会一起清除。')) return;
    try {
      await api('/api/cards/' + card.id, { method: 'DELETE' });
      await loadCards();
    } catch (err) {
      if (err.message !== 'unauthorized') toast(err.message, true);
    }
  };

  if (card.status === 'inbox') {
    foot.appendChild(mkBtn('→ 待发', 'btn-advance', () => setStatus('queued')));
  } else if (card.status === 'queued') {
    // 异步发布：只是把卡排进队列（定时=现在），N150 每分钟轮询后台发。
    // 不再同步等整条链路跑完——发布要 1-2 分钟，手机浏览器早就掐断请求了（load failed）。
    const pubBtn = mkBtn('发布到微博 ▶', 'btn-launch', async () => {
      if (!confirm('发布到微博？确认后约 1 分钟内自动发出，发完自动标已发。')) return;
      pubBtn.disabled = true;
      pubBtn.textContent = '排队中…';
      try {
        await save(); // 先把没保存的文案编辑存了
        await api('/api/cards/' + card.id, {
          method: 'PATCH',
          body: JSON.stringify({ scheduled_at: Date.now() }),
        });
        toast('发布中…发出后会自动提示 ✓（关页面也照发）');
        watchPosted(card.id);
        await loadCards();
      } catch (err) {
        if (err.message !== 'unauthorized') toast(err.message, true);
        pubBtn.disabled = false;
        pubBtn.textContent = '发布到微博 ▶';
      }
    });
    foot.appendChild(pubBtn);

    // 定时发送：设/改/取消。时间存 D1，N150 到点自动发（关页面也照发）
    const sched = document.createElement('div');
    sched.className = 'sched';
    const input = document.createElement('input');
    input.type = 'datetime-local';
    input.className = 'sched-input';
    const now = new Date();
    input.min = toLocalInput(now.getTime());
    input.value = toLocalInput(card.scheduled_at || now.getTime() + 3600000);
    const setSched = async () => {
      const val = input.value;
      if (!val) return;
      const ms = new Date(val).getTime();
      if (!ms || ms < Date.now()) { toast('请选择一个未来的时间', true); return; }
      try {
        await save();
        await api('/api/cards/' + card.id, {
          method: 'PATCH',
          body: JSON.stringify({ scheduled_at: ms }),
        });
        toast('已定时：' + fmtSched(ms) + ' 自动发送');
        await loadCards();
      } catch (err) {
        if (err.message !== 'unauthorized') toast(err.message, true);
      }
    };
    const clearSched = async () => {
      try {
        await api('/api/cards/' + card.id, {
          method: 'PATCH',
          body: JSON.stringify({ scheduled_at: null }),
        });
        toast('已取消定时');
        await loadCards();
      } catch (err) {
        if (err.message !== 'unauthorized') toast(err.message, true);
      }
    };
    sched.appendChild(input);
    sched.appendChild(mkBtn(card.scheduled_at ? '改定时' : '定时', 'btn-ghost', setSched));
    if (card.scheduled_at) sched.appendChild(mkBtn('取消定时', 'btn-ghost', clearSched));
    foot.appendChild(sched);

    foot.appendChild(mkBtn('标记已发 ✓', 'btn-advance', () => setStatus('posted')));
    foot.appendChild(mkBtn('退回草稿', 'btn-ghost', () => setStatus('inbox')));
  } else if (card.status === 'posted') {
    foot.appendChild(mkBtn('退回待发', 'btn-ghost', () => setStatus('queued')));
    const left = card.posted_at
      ? Math.max(0, 7 - Math.floor((Date.now() - card.posted_at) / 86400000))
      : 7;
    const note = document.createElement('span');
    note.className = 'purge';
    note.textContent = left > 0 ? `${left} 天后自动清除` : '今日自动清除';
    foot.appendChild(note);
  }
  const spacer = document.createElement('span');
  spacer.className = 'flex';
  foot.appendChild(spacer);
  foot.appendChild(mkBtn('删除', 'btn-scrap', del));

  return root;
}

/* ---------------- 启动 ---------------- */

// 打开页面时顺手让服务端检查一次官网新闻（服务端 6 小时节流，不用担心刷太勤）
async function autoNews() {
  try {
    const r = await api('/api/news/auto', { method: 'POST' });
    if (r.ran && r.addedCount > 0) {
      toast(`自动抓到 ${r.addedCount} 条官方新闻`);
      await loadCards();
    }
  } catch {
    /* 自动检查失败保持安静，手动按钮还在 */
  }
}

async function boot() {
  try {
    await api('/api/me');
  } catch (err) {
    if (err.message === 'unauthorized') return;
    toast(err.message, true);
    return;
  }
  renderShell();
  await loadCards();
  autoNews();
}

boot();
