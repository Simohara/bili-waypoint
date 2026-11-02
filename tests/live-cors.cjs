// Anonymous browser smoke test: no user profile, cookies, or installation.
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('C:/Users/simoh/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async () => {
    const browser = await chromium.launch({executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true});
    try {
        const page = await browser.newPage();
        const networkErrors = [];
        page.on('requestfailed', request => networkErrors.push({host: new URL(request.url()).hostname, method: request.method(), error: request.failure()?.errorText}));
        // A text document supplies the real origin without running the official
        // diagnostic page's own multi-track downloads in addition to this test.
        await page.goto('https://www.bilibili.com/robots.txt', {waitUntil: 'domcontentloaded', timeout: 20000});
        const result = await page.evaluate(async () => {
            const response = await fetch('https://api.bilibili.com/x/player/playurl?bvid=BV13aH46QEZ6&cid=42485222337&fnver=0&fnval=1616&fourk=1&otype=json', {credentials: 'include'});
            const data = await response.json();
            if (data.code !== 0 || !data.data?.dash?.video?.length) return {apiCode: data.code, error: 'No DASH sample'};
            const source = data.data.dash.video[0].base_url, samples = [];
            for (const host of ['upos-sz-mirrorcosov.bilivideo.com', 'cn-hk-eq-01-01.bilivideo.com']) {
                const url = new URL(source); url.hostname = host;
                for (const bytes of [1, 524288]) {
                    const start = performance.now(), controller = new AbortController();
                    const timer = setTimeout(() => controller.abort(), 6000);
                    try {
                        const r = await fetch(url.href, {headers: {Range: 'bytes=0-' + (bytes - 1)}, cache: 'no-store', credentials: 'omit', signal: controller.signal});
                        if (r.status !== 206) throw new Error('HTTP ' + r.status);
                        const reader = r.body.getReader(); let total = 0;
                        for (;;) { const part = await reader.read(); if (part.done) break; total += part.value.byteLength; if (total > bytes) throw new Error('range ignored'); }
                        samples.push({host, requested: bytes, status: r.status, received: total, range: r.headers.get('Content-Range'), ms: Math.round(performance.now() - start)});
                    } catch (error) { samples.push({host, requested: bytes, error: error.message}); }
                    finally {clearTimeout(timer); controller.abort();}
                }
            }
            return {apiCode: data.code, samples};
        });
        result.note = 'Fresh anonymous Chrome context at real Bilibili origin. Single samples; no ranking claim.';
        result.networkErrors = networkErrors;
        fs.writeFileSync(path.join(__dirname, '../dist/live-cors-results.json'), JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result, null, 2));
    } finally { await browser.close(); }
})().catch(error => {console.error(error.message); process.exitCode = 1;});
