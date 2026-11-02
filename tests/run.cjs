const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../src/auto-core.js');
const {chromium} = require('C:/Users/simoh/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = path.resolve(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'dist/ccb-auto.user.js'), 'utf8');
const fixture = fs.readFileSync(path.join(__dirname, 'fixture.html'), 'utf8');
const pool = C.nodes(JSON.parse(fs.readFileSync(path.join(root, 'upstream/data/cdn.json'), 'utf8')));
const BV = 'BV175ph6CERk', CID = 42604365439;
const currentHost = 'upos-sz-mirrorcosov.bilivideo.com';
const asset = '/upgcxcode/39/54/' + CID + '/video.m4s';
const audioAsset = '/upgcxcode/39/54/' + CID + '/audio.m4s';
const log = [];
function pass(name) { log.push(name); console.log('PASS ' + name); }
assert.equal(C.identity('https://www.bilibili.com/video/' + BV + '/?trackid=a&vd_source=b').bvid, BV);
assert.equal(C.identity('https://www.bilibili.com/video/' + BV + '/?p=2').page, 2);
assert.equal(C.identity('https://example.com/video/' + BV), null);
assert.equal(C.host('https://cn-hk-eq-01-01.bilivideo.com.evil.test'), '');
assert.equal(C.host('https://u:p@cn-hk-eq-01-01.bilivideo.com'), '');
assert.equal(C.nodes({'上海': ['cn-sh-ct-01-01.bilivideo.com'], '香港': ['cn-hk-eq-01-01.bilivideo.com', 'https://evil.test']}).length, 1);
assert.equal(pool.length, 16);
pass('URL identity, exact repository regions, hostname validation');
const valid = {status: 206, range: 'bytes 0-1023/10000', size: 1024, expected: 1024,
    type: 'application/octet-stream', sample: '', finalUrl: 'https://' + currentHost + '/a', expectedHost: currentHost};
C.validateRange(valid);
for (const change of [{status: 200}, {size: 100}, {type: 'text/html'}, {range: null}, {finalUrl: 'https://other.bilivideo.com/a'}]) assert.throws(() => C.validateRange({...valid, ...change}));
assert.equal(C.healthy({pingMs: 90, mbps: 40}, C.defaults, 35), true);
assert.equal(C.healthy({pingMs: 500, mbps: 100}, C.defaults, 35), false);
assert.equal(C.healthy({pingMs: 90, mbps: Infinity}, C.defaults, 35), false);
assert.equal(C.threshold({dash: {video: [{id: 120, bandwidth: 40000000}], audio: [{bandwidth: 320000}]}}, 35), 52.416);
pass('Range integrity, finite throughput, latency/4K thresholds');
assert.equal(C.due({views: 3, lastCheckViews: 0, lastCheckAt: 1000000}, C.defaults, 2000000), true);
assert.equal(C.due({views: 2, lastCheckViews: 0, lastCheckAt: 1000000}, C.defaults, 2000000), false);
assert.equal(C.due({views: 9, lastCheckViews: 0, lastCheckAt: 1999000}, C.defaults, 2000000), false);
assert.equal(C.due({views: 1, lastCheckViews: 0, lastCheckAt: 0}, C.defaults, 2000000), false);
pass('Video-count trigger and cooldown');

async function setup(browser, mode = 'poor', extra = {}) {
    const context = await browser.newContext({viewport: {width: 1600, height: 1000}, colorScheme: 'dark', timezoneId: 'Asia/Tokyo'});
    const page = await context.newPage(); const errors = [], requests = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(({script, extra, host}) => {
        window.unsafeWindow = window;
        window.__gm = {CCB_main: host, ...extra.gm};
        window.GM_getValue = (k, d) => Object.hasOwn(window.__gm, k) ? window.__gm[k] : d;
        window.GM_setValue = (k, v) => { window.__gm[k] = v; };
        window.GM_registerMenuCommand = () => {};
        window.GM_xmlhttpRequest = options => {
            const controller = new AbortController();
            fetch(options.url, {signal: controller.signal}).then(async r => options.onload({status: r.status, responseText: await r.text()})).catch(() => options.onerror?.());
            return {abort: () => controller.abort()};
        };
        if (extra.session && !sessionStorage.getItem('fixture-initialized')) {
            sessionStorage.setItem('CCB_AUTO_session_v1', JSON.stringify(extra.session));
            sessionStorage.setItem('fixture-initialized', 'yes');
        }
        eval(script);
        document.addEventListener('DOMContentLoaded', () => {
            const video = document.querySelector('video');
            if (!video) return;
            Object.defineProperties(video, {readyState: {get: () => window.__readyState ?? 4}, paused: {get: () => !!window.__paused},
                seeking: {get: () => !!window.__seeking},
                duration: {get: () => 3600}, buffered: {get: () => ({length: 1, start: () => 0, end: () => window.__bufferEnd ?? 500})}});
            video.currentTime = 123;
            video.play = async () => {window.__paused = false;}; video.pause = () => {window.__paused = true;};
        });
    }, {script, extra, host: currentHost});
    await context.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url());
        const headers = {'access-control-allow-origin': 'https://www.bilibili.com', 'access-control-allow-credentials': 'true',
            'access-control-allow-headers': 'range,pragma', 'access-control-expose-headers': 'Content-Range,Content-Length', 'access-control-max-age': '600'};
        if (req.method() === 'OPTIONS') return route.fulfill({status: 204, headers});
        if (url.hostname === 'www.bilibili.com' && url.pathname.startsWith('/video/')) return route.fulfill({contentType: 'text/html', body: fixture});
        if (url.hostname === 'raw.githubusercontent.com') return route.fulfill({headers, contentType: 'application/json', body: fs.readFileSync(path.join(root, 'upstream/data/' + (url.pathname.endsWith('region.json') ? 'region.json' : 'cdn.json')), 'utf8')});
        if (url.pathname === '/x/player/pagelist') return route.fulfill({headers, contentType: 'application/json', body: JSON.stringify({code: 0, data: [{page: 1, cid: CID}, {page: 2, cid: CID + 1}]})});
        if (url.pathname === '/x/player/playurl') {
            const cid = Number(url.searchParams.get('cid')) || CID;
            const video = 'https://' + currentHost + asset.replace(String(CID), String(cid));
            return route.fulfill({headers, contentType: 'application/json', body: JSON.stringify({code: 0, data: {timelength: 1200000, dash: {
                video: [{id: 32, codecid: 7, bandwidth: 3000000, base_url: video}],
                audio: [{id: 30280, bandwidth: 320000, base_url: 'https://' + currentHost + audioAsset.replace(String(CID), String(cid))}],
            }}})});
        }
        if (C.host(url.origin)) {
            const range = req.headers().range;
            const end = range ? Number(range.match(/-(\d+)$/)[1]) : 1023;
            requests.push({host: url.hostname, range, path: url.pathname});
            if (extra.usableHosts && !extra.usableHosts.includes(url.hostname)) return route.fulfill({status: 403, headers, body: 'unavailable'});
            const slow = mode === 'poor' && url.hostname === currentHost && end > 1024;
            await new Promise(r => setTimeout(r, slow ? 650 : 8));
            if (extra.invalid && end > 1) return route.fulfill({status: 200, headers, contentType: 'text/html', body: '<html>bad</html>'});
            return route.fulfill({status: 206, headers: {...headers, 'content-range': `bytes 0-${end}/100000000`, 'content-length': String(end + 1)},
                contentType: 'application/octet-stream', body: Buffer.alloc(end + 1, 0x42)});
        }
        return route.abort();
    });
    await page.goto('https://www.bilibili.com/video/' + BV);
    await page.waitForSelector('#ccb-auto-widget', {state: 'attached'});
    await page.waitForTimeout(1400);
    return {context, page, errors, requests};
}

(async () => {
    const browser = await chromium.launch({executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true});
    try {
        const healthy = await setup(browser, 'healthy');
        await healthy.page.evaluate(async ({host, asset}) => {
            const r = await fetch('https://' + host + asset, {headers: {Range: 'bytes=0-262143'}}); await r.arrayBuffer();
        }, {host: currentHost, asset});
        await healthy.page.waitForTimeout(1100);
        const badge = healthy.page.getByRole('button', {name: 'CCB 视频网络状态与设置'});
        assert.match(await badge.innerText(), /↓/);
        await healthy.page.screenshot({path: path.join(root, 'dist/preview-compact.png'), clip: {x: 72, y: 12, width: 780, height: 115}});
        const beforeWorker = healthy.requests.length;
        const workerReply = await healthy.page.evaluate(async ({host, asset}) => {
            const code = `onmessage=async event=>{if(event.data!=='go')return;const r=await fetch('https://${host}${asset}',{headers:{Range:'bytes=0-131071'}});const b=await r.arrayBuffer();postMessage({done:true,bytes:b.byteLength})}`;
            const blob = new Blob([code], {type: 'application/javascript'});
            const url = URL.createObjectURL(blob), worker = new Worker(url);
            try {
                return await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error('worker timeout')), 10000);
                    worker.onerror = event => {clearTimeout(timer); reject(new Error(event.message));};
                    worker.onmessage = event => {clearTimeout(timer); resolve(event.data);};
                    worker.postMessage('go');
                });
            } finally { worker.terminate(); URL.revokeObjectURL(url); }
        }, {host: currentHost, asset});
        assert.deepEqual(workerReply, {done: true, bytes: 131072});
        assert.equal(healthy.requests.length - beforeWorker, 1);
        await healthy.page.waitForTimeout(1100);
        assert.match(await badge.innerText(), /↓/);
        pass('Real Blob Worker fetch, private metrics channel and unchanged player message protocol');
        await badge.click();
        await healthy.page.getByRole('button', {name: '立即测速', exact: true}).click();
        await healthy.page.getByRole('button', {name: '切换并刷新'}).waitFor({timeout: 45000});
        assert.equal(await healthy.page.getByRole('radio').count(), 3);
        assert.equal(await healthy.page.evaluate(() => sessionStorage.getItem('CCB_AUTO_active_v1')), null);
        assert.deepEqual(healthy.errors, []);
        pass('Manual check also offers three verified alternatives for a healthy current node; no automatic replacement');
        await healthy.context.close();

        const poor = await setup(browser);
        await poor.page.getByRole('button', {name: 'CCB 视频网络状态与设置'}).click();
        await poor.page.getByRole('button', {name: '立即测速', exact: true}).click();
        await poor.page.getByRole('button', {name: '切换并刷新'}).waitFor({timeout: 45000});
        const tested = new Set(poor.requests.filter(r => r.range === 'bytes=0-262143').map(r => r.host));
        assert.equal(tested.size, pool.length - 1);
        assert.ok([...tested].every(host => pool.some(n => n.host === host)));
        assert.equal(await poor.page.evaluate(() => sessionStorage.getItem('CCB_AUTO_active_v1')), null);
        const choices = poor.page.getByRole('radio');
        assert.equal(await choices.count(), 3);
        const selectedHost = await choices.nth(2).inputValue();
        await choices.nth(2).check();
        await poor.page.getByRole('button', {name: '稍后', exact: true}).click();
        await poor.page.getByRole('button', {name: 'CCB 视频网络状态与设置'}).click();
        assert.equal(await poor.page.getByRole('radio').nth(2).isChecked(), true);
        await poor.page.screenshot({path: path.join(root, 'dist/preview-dark.png')});
        pass('Poor node confirms, scans all 16 repository candidates without rewrite collapse, and waits for consent');
        await poor.page.getByRole('button', {name: '切换并刷新'}).click();
        await poor.page.waitForLoadState('load');
        await poor.page.waitForTimeout(1600);
        const saved = await poor.page.evaluate(() => ({active: JSON.parse(sessionStorage.getItem('CCB_AUTO_active_v1')), time: document.querySelector('video').currentTime}));
        assert.equal(saved.active.host, selectedHost); assert.equal(saved.time, 123);
        await poor.page.evaluate(async ({host, asset}) => {
            const r = await fetch('https://' + host + asset, {headers: {Range: 'bytes=0-1023'}}); await r.arrayBuffer();
        }, {host: currentHost, asset});
        assert.equal(poor.requests.at(-1).host, saved.active.host);
        assert.deepEqual(poor.errors, []);
        pass('Only explicit approval persists the node, reloads, restores position and redirects actual media requests');
        await poor.context.close();

        const stale = await setup(browser);
        await stale.page.getByRole('button', {name: 'CCB 视频网络状态与设置'}).click();
        await stale.page.getByRole('button', {name: '立即测速', exact: true}).click();
        await stale.page.waitForTimeout(250);
        await stale.page.evaluate(() => history.pushState({}, '', '?p=2'));
        await stale.page.waitForTimeout(1800);
        assert.equal(await stale.page.evaluate(() => sessionStorage.getItem('CCB_AUTO_active_v1')), null);
        await stale.page.getByRole('button', {name: 'CCB 视频网络状态与设置'}).click();
        assert.equal(await stale.page.getByRole('button', {name: '切换并刷新'}).count(), 0);
        assert.deepEqual(stale.errors, []);
        pass('SPA/P switch cancels old measurements and drops old proposals');
        await stale.context.close();

        const counting = await setup(browser, 'healthy', {gm: {CCB_AUTO_settings_v1: {watchedSeconds: 5, everyVideos: 3}},
            session: {views: 2, lastCheckViews: 0, lastCheckAt: Date.now() - 20 * 60000, lastCountedBvid: 'BV13aH46QEZ6'}});
        await counting.page.getByRole('button', {name: 'CCB 视频网络状态与设置'}).click();
        await counting.page.getByText('节点正常', {exact: true}).waitFor({timeout: 20000});
        const counters = await counting.page.evaluate(() => JSON.parse(sessionStorage.getItem('CCB_AUTO_session_v1')));
        assert.equal(counters.views, 3); assert.equal(counters.lastCheckViews, 3);
        const checks = counting.requests.filter(r => r.range === 'bytes=0-524287').length;
        assert.equal(checks, 1);
        assert.equal(await counting.page.getByRole('radio').count(), 0);
        await counting.page.getByText('设置', {exact: true}).click();
        await counting.page.getByLabel('每几个视频检查', {exact: true}).fill('4');
        await counting.page.getByLabel('4K 目标 Mbps', {exact: true}).fill('45');
        await counting.page.getByRole('button', {name: '保存设置'}).click();
        assert.equal(await counting.page.evaluate(() => window.__gm.CCB_AUTO_settings_v1.everyVideos), 4);
        assert.equal(await counting.page.evaluate(() => window.__gm.CCB_AUTO_settings_v1.minMbps), 45);
        assert.equal(await counting.page.locator('.footnote').count(), 0);
        assert.deepEqual(counting.errors, []);
        pass('Third qualified video triggers one automatic small check; settings are editable and persisted');
        await counting.context.close();

        const invalid = await setup(browser, 'healthy', {invalid: true});
        await invalid.page.getByRole('button', {name: 'CCB 视频网络状态与设置'}).click();
        await invalid.page.getByRole('button', {name: '立即测速', exact: true}).click();
        await invalid.page.getByText('暂未找到达到阈值的香港／海外节点', {exact: true}).waitFor({timeout: 45000});
        assert.equal(await invalid.page.getByRole('button', {name: '切换并刷新'}).count(), 0);
        assert.equal(await invalid.page.evaluate(() => sessionStorage.getItem('CCB_AUTO_active_v1')), null);
        assert.deepEqual(invalid.errors, []);
        pass('HTTP 200 error pages across all nodes cannot produce a winning replacement');
        await invalid.context.close();

        const twoHosts = pool.filter(node => node.host !== currentHost).slice(0, 2).map(node => node.host);
        const limited = await setup(browser, 'poor', {usableHosts: twoHosts});
        await limited.page.getByRole('button', {name: 'CCB 视频网络状态与设置'}).click();
        await limited.page.getByRole('button', {name: '立即测速', exact: true}).click();
        await limited.page.getByRole('button', {name: '切换并刷新'}).waitFor({timeout: 45000});
        assert.equal(await limited.page.getByRole('radio').count(), 2);
        const offered = await limited.page.getByRole('radio').evaluateAll(nodes => nodes.map(node => node.value));
        assert.deepEqual(offered.slice().sort(), twoHosts.slice().sort());
        assert.deepEqual(limited.errors, []);
        pass('When only two alternatives are usable, exactly those two are selectable; failed nodes are excluded');
        await limited.context.close();

        const stalled = await setup(browser, 'poor', {gm: {CCB_AUTO_settings_v1: {everyVideos: 30, cooldownMinutes: 120}},
            session: {views: 0, lastCheckViews: 0, lastCheckAt: Date.now()}});
        const setBuffering = async (options = {}) => stalled.page.evaluate(options => {
            const video = document.querySelector('video');
            window.__paused = !!options.paused; window.__seeking = !!options.seeking;
            window.__readyState = 2; window.__bufferEnd = video.currentTime + 0.05;
            if (options.seeking) video.dispatchEvent(new Event('seeking'));
            video.dispatchEvent(new Event('waiting'));
        }, options);
        const recover = async () => stalled.page.evaluate(() => {
            window.__paused = false; window.__seeking = false; window.__readyState = 4; window.__bufferEnd = 500;
            document.querySelector('video').dispatchEvent(new Event('playing'));
        });
        await setBuffering(); await stalled.page.waitForTimeout(1000); await recover();
        await stalled.page.waitForTimeout(1800); assert.equal(stalled.requests.length, 0);
        await setBuffering({paused: true}); await stalled.page.waitForTimeout(2900); assert.equal(stalled.requests.length, 0);
        await setBuffering({seeking: true}); await stalled.page.waitForTimeout(2900); assert.equal(stalled.requests.length, 0);
        await recover();
        await stalled.page.evaluate(() => document.querySelector('video').dispatchEvent(new Event('stalled')));
        await stalled.page.waitForTimeout(2900); assert.equal(stalled.requests.length, 0);
        await stalled.page.evaluate(() => {
            Object.defineProperty(document, 'hidden', {configurable: true, get: () => !!window.__fixtureHidden});
            window.__fixtureHidden = true; document.dispatchEvent(new Event('visibilitychange'));
        });
        await setBuffering(); await stalled.page.waitForTimeout(2900); assert.equal(stalled.requests.length, 0);
        await recover(); await stalled.page.evaluate(() => {window.__fixtureHidden = false; document.dispatchEvent(new Event('visibilitychange'));});
        pass('Transient waits, pause, seeking, buffered stalled events and hidden pages do not trigger probes');
        const firstProbe = stalled.page.waitForRequest(request => request.headers().range === 'bytes=0-0', {timeout: 7000});
        const began = Date.now(); await setBuffering(); await firstProbe;
        assert.ok(Date.now() - began >= 2300 && Date.now() - began < 6000);
        assert.equal(await stalled.page.evaluate(() => sessionStorage.getItem('CCB_AUTO_active_v1')), null);
        await stalled.page.getByRole('button', {name: '切换并刷新'}).waitFor({timeout: 45000});
        assert.equal(await stalled.page.getByRole('radio').count(), 3);
        assert.equal(await stalled.page.locator('.footnote').count(), 0);
        assert.equal(await stalled.page.getByText('已观看', {exact: false}).count(), 0);
        await stalled.page.screenshot({path: path.join(root, 'dist/preview-stall.png')});
        pass('A sustained 2.5-second stall bypasses view-count and periodic cooldown, offering three nodes without auto-refresh');
        await stalled.page.getByRole('button', {name: '保持当前'}).click();
        const previousRequests = stalled.requests.length;
        await stalled.page.waitForTimeout(2800);
        await recover(); await setBuffering(); await stalled.page.waitForTimeout(2800);
        assert.equal(stalled.requests.length, previousRequests);
        assert.deepEqual(stalled.errors, []);
        pass('One stall episode does not loop; repeat episodes respect the emergency cooldown');
        await stalled.context.close();

        const disabled = await setup(browser, 'poor', {gm: {CCB_AUTO_settings_v1: {stallDetection: false, everyVideos: 30}}});
        await disabled.page.evaluate(() => {
            const video = document.querySelector('video'); window.__readyState = 2; window.__bufferEnd = video.currentTime + 0.05;
            video.dispatchEvent(new Event('waiting'));
        });
        await disabled.page.waitForTimeout(3500);
        assert.equal(disabled.requests.length, 0); assert.deepEqual(disabled.errors, []);
        pass('Disabling stall detection prevents emergency probes');
        await disabled.context.close();
    } finally { await browser.close(); }
    fs.writeFileSync(path.join(root, 'dist/test-results.json'), JSON.stringify({passed: log, note: 'Deterministic Chrome fixture, not a signed-in Bilibili/Tampermonkey session'}, null, 2));
})().catch(e => {console.error(e); process.exitCode = 1;});
