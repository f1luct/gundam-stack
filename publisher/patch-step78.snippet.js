        // gundam-patch v6: 重写发送与结果判定。
        // 病根:原版上传完成检测是全局数图片(信息流里全是图,恒真),大图还在上传就点了发送,
        // 点击无效且微博不报错 → 35s 后 "result unclear"。
        // 修法:发送按钮限定在「图片所在编辑器」内;点击后以「输入框被清空」为提交成功的硬信号;
        // 文案还在且按钮可点(=上次点击落空)就隔 8s 重点,总窗口 90s。toast 出现成功/失败字样立即定论。
        let finalResult = null;
        {
            const deadline = Date.now() + 90_000;
            let lastClick = 0;
            let clicked = 0;
            const stateJs = `
                (() => {
                    const vis = el => !!el && el.offsetParent !== null;
                    const fi = document.querySelector('input[type="file"][class*="_file_"]');
                    let comp = null;
                    if (fi) {
                        let root = fi.parentElement;
                        while (root && root !== document.body) {
                            if (root.querySelector('textarea')) { comp = root; break; }
                            root = root.parentElement;
                        }
                    }
                    const ta = comp ? comp.querySelector('textarea') : null;
                    let sendEnabled = false;
                    if (comp) {
                        for (const b of comp.querySelectorAll('button')) {
                            const t = (b.innerText || '').trim();
                            if ((t === '发送' || t === '发布') && vis(b) && !b.disabled) { sendEnabled = true; break; }
                        }
                    }
                    const toasts = [];
                    for (const el of document.querySelectorAll('[class*="toast"], [class*="Toast"], [class*="tip"], [class*="alert"]')) {
                        if (el.offsetParent === null) continue;
                        const t = (el.innerText || '').trim();
                        if (t && t.length < 100) toasts.push(t);
                    }
                    return { taLen: ta ? ta.value.length : -1, sendEnabled, toasts: toasts.join(' | ') };
                })()
            `;
            const clickJs = `
                (() => {
                    const vis = el => !!el && el.offsetParent !== null;
                    const fi = document.querySelector('input[type="file"][class*="_file_"]');
                    let comp = null;
                    if (fi) {
                        let root = fi.parentElement;
                        while (root && root !== document.body) {
                            if (root.querySelector('textarea')) { comp = root; break; }
                            root = root.parentElement;
                        }
                    }
                    if (!comp) return false;
                    for (const b of comp.querySelectorAll('button')) {
                        const t = (b.innerText || '').trim();
                        if ((t === '发送' || t === '发布') && vis(b) && !b.disabled) { b.click(); return true; }
                    }
                    return false;
                })()
            `;
            await page.wait({ time: 1 });
            while (Date.now() < deadline) {
                const st = await page.evaluate(stateJs);
                const toastText = st?.toasts || '';
                if (/发布成功|发送成功|已发布/.test(toastText)) { finalResult = { ok: true, message: toastText }; break; }
                if (/发布失败|发送失败|内容违规|上传失败|请稍后再试|频繁/.test(toastText)) { finalResult = { ok: false, message: toastText }; break; }
                if (clicked > 0 && st?.taLen === 0) { finalResult = { ok: true, message: 'composer cleared (submitted)' }; break; }
                if (st && st.taLen > 0 && st.sendEnabled && Date.now() - lastClick > 8_000) {
                    await page.evaluate(clickJs);
                    lastClick = Date.now();
                    clicked++;
                }
                await page.wait({ time: 1 });
            }
            if (!finalResult && clicked === 0) {
                throw new CommandExecutionError('Could not click publish (send button never became clickable).');
            }
        }

