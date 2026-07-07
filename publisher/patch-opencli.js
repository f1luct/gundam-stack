// opencli weibo publish 最小补丁(v4)。
// 病根(用诊断确认):微博发布页有两个编辑器——顶栏内联条 和 弹层。原版把图片喂给
// 第一个 _file_ 输入(在顶栏条),却把文案用 nativeSetter 写进弹层 textarea。微博从
// "有图的顶栏条"提交 → 文案丢失,发出去变"分享图片"。
// 修法:只改文案定位——把文案写进「图片所在的那个编辑器」(第一个 _file_ 输入向上找到
// 的容器里的 textarea),并用 execCommand 触发真实输入让 Vue 感知。图片上传、发送按钮、
// 成功检测全部保持原版不动。
// publisher.js 启动会自动 applyPatch() 自愈;npm 更新 opencli 后重启服务即恢复。
'use strict';
const fs = require('node:fs');
const path = require('node:path');

function applyPatch(dir) {
  const file = path.join(dir, 'clis', 'weibo', 'publish.js');
  const bak = file + '.bak';
  const MARK = 'gundam-patch v5';

  const current = fs.readFileSync(file, 'utf8');
  if (current.includes(MARK)) return 'skip';

  // 总是从原始备份开始打,保证幂等、也自动丢弃历史上打歪的补丁
  if (fs.existsSync(bak)) {
    fs.copyFileSync(bak, file);
  } else {
    fs.copyFileSync(file, bak);
  }
  let src = fs.readFileSync(file, 'utf8');

  // 原版文案插入 IIFE 主体(nativeSetter 写进"最后一个可见 textarea"=弹层)
  const OLD =
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

  const NEW =
    "                /* gundam-patch v5: 文案写进「图片所在的编辑器」，并用真实输入触发 Vue */\n" +
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

  if (!src.includes(OLD)) {
    throw new Error('文案插入锚点没找到 —— opencli 版本变了，补丁需重新适配');
  }
  src = src.replace(OLD, NEW);

  // 发送前多等几秒:图片上传 + 微博"辅助创作"AI 推荐面板出现会改布局，
  // 原版只等 0.5s 就点发送，面板一插进来点击就落空 → "result unclear"。
  const OLD_WAIT = '        await page.wait({ time: 0.5 });\n        const publishResult = await page.evaluate(';
  const NEW_WAIT = '        await page.wait({ time: 3 }); /* gundam-patch v5: 等上传+AI面板稳定 */\n        const publishResult = await page.evaluate(';
  if (src.includes(OLD_WAIT)) src = src.replace(OLD_WAIT, NEW_WAIT);

  // 成功检测窗口放宽(带图提交+服务端处理有时超过 20s)
  if (src.includes('const SUBMIT_TIMEOUT_MS = 20_000;')) {
    src = src.replace('const SUBMIT_TIMEOUT_MS = 20_000;', 'const SUBMIT_TIMEOUT_MS = 35_000;');
  }

  fs.writeFileSync(file, src);
  return 'patched';
}

module.exports = { applyPatch };

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) throw new Error('用法: node patch-opencli.js <opencli目录>');
  const r = applyPatch(dir);
  console.log(r === 'skip' ? '已含补丁,跳过' : '补丁 v4 完成(文案定位到图片编辑器),备份 publish.js.bak');
}
