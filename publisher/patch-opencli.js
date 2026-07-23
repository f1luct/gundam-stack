// opencli weibo publish 补丁(v6)。两处修改:
//
// ① 文案定位(v4 起):微博发布页有两个编辑器(顶栏内联条 + 弹层),原版把图片喂给第一个
//    _file_ 输入(顶栏条),文案却写进"最后一个可见 textarea"(弹层)→ 发出去变"分享图片"。
//    修法:文案写进「图片所在的编辑器」,execCommand 触发真实输入让 Vue 感知。
//
// ② 发送与结果判定(v6 起,整段替换原版 Step 7/8):原版上传完成检测是全局数图片
//    (信息流里全是图,恒真),大图还在上传就点了发送,点击无效且无报错 → "result unclear"。
//    新逻辑见 patch-step78.snippet.js:发送按钮限定编辑器内、「输入框清空」为提交信号、
//    落空自动重点、90s 窗口。
//
// publisher.js 启动会自动 applyPatch() 自愈;npm 更新 opencli 后重启服务即恢复。
'use strict';
const fs = require('node:fs');
const path = require('node:path');

function applyPatch(dir) {
  const file = path.join(dir, 'clis', 'weibo', 'publish.js');
  const bak = file + '.bak';
  const MARK = 'gundam-patch v6';

  const current = fs.readFileSync(file, 'utf8');
  if (current.includes(MARK)) return 'skip';

  // 总是从原始备份开始打,保证幂等、也自动丢弃历史上打歪的补丁
  if (fs.existsSync(bak)) {
    fs.copyFileSync(bak, file);
  } else {
    fs.copyFileSync(file, bak);
  }
  let src = fs.readFileSync(file, 'utf8');

  /* ---------- ① 文案写进图片所在编辑器 ---------- */

  const OLD_INSERT =
    "                if (!ta) return { ok: false, message: 'textarea not visible' };\n" +
    "                ta.focus();\n" +
    "                const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;\n" +
    "                if (nativeSetter) {\n" +
    "                    nativeSetter.call(ta, textContent);\n" +
    "                } else {\n" +
    "                    ta.value = textContent;\n" +
    "                }\n" +
    "                ta.dispatchEvent(new Event('input', { bubbles: true }));\n" +
    "                ta.dispatchEvent(new Event('change', { bubbles: true }));\n" +
    "                return { ok: true, valueLength: ta.value.length };";

  const NEW_INSERT =
    "                /* gundam-patch v6: 文案写进「图片所在的编辑器」，并用真实输入触发 Vue */\n" +
    "                const fileInput = document.querySelector('input[type=\"file\"][class*=\"_file_\"]');\n" +
    "                let target = null;\n" +
    "                if (fileInput) {\n" +
    "                    let root = fileInput.parentElement;\n" +
    "                    while (root && root !== document.body) {\n" +
    "                        const cand = root.querySelector('textarea');\n" +
    "                        if (cand && cand.offsetParent !== null) { target = cand; break; }\n" +
    "                        root = root.parentElement;\n" +
    "                    }\n" +
    "                }\n" +
    "                if (!target) target = ta; // 兜底:原版选的最后一个可见 textarea\n" +
    "                if (!target) return { ok: false, message: 'textarea not visible' };\n" +
    "                target.focus();\n" +
    "                target.value = '';\n" +
    "                target.setSelectionRange(0, 0);\n" +
    "                let inserted = false;\n" +
    "                try { inserted = document.execCommand('insertText', false, textContent); } catch (e) {}\n" +
    "                if (!inserted || target.value !== textContent) {\n" +
    "                    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;\n" +
    "                    if (setter) setter.call(target, textContent); else target.value = textContent;\n" +
    "                    target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: textContent }));\n" +
    "                    target.dispatchEvent(new Event('change', { bubbles: true }));\n" +
    "                }\n" +
    "                return { ok: true, valueLength: target.value.length };";

  if (!src.includes(OLD_INSERT)) {
    throw new Error('文案插入锚点没找到 —— opencli 版本变了,补丁需重新适配');
  }
  src = src.replace(OLD_INSERT, NEW_INSERT);

  /* ---------- ② 整段替换 Step 7/8(点发送 + 判结果) ---------- */

  const STEP7_START = '        // Step 7: Click the send button inside the compose editor';
  const STEP8_END = '        if (!finalResult) {';
  const i7 = src.indexOf(STEP7_START);
  const i8 = src.indexOf(STEP8_END);
  if (i7 < 0 || i8 <= i7) {
    throw new Error('Step7/8 锚点没找到 —— opencli 版本变了,补丁需重新适配');
  }
  const snippet = fs.readFileSync(path.join(__dirname, 'patch-step78.snippet.js'), 'utf8');
  src = src.slice(0, i7) + snippet + src.slice(i8);

  fs.writeFileSync(file, src);
  return 'patched';
}

module.exports = { applyPatch };

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) throw new Error('用法: node patch-opencli.js <opencli目录>');
  const r = applyPatch(dir);
  console.log(r === 'skip' ? '已含补丁,跳过' : '补丁 v6 完成,备份 publish.js.bak');
}
