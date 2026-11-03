const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../src/auto-core.js');
const {chromium} = require('C:/Users/simoh/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = path.resolve(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'dist/yicheng.user.js'), 'utf8');
const fixture = fs.readFileSync(path.join(__dirname, 'fixture.html'), 'utf8');
const pool = C.nodes(JSON.parse(fs.readFileSync(path.join(root, 'data/cdn.json'), 'utf8')));
const BV = 'BV175ph6CERk', CID = 42604365439;
const currentHost = 'upos-sz-mirrorcosov.bilivideo.com';
const mcdnHost = 'xy60x29x235x164xy.mcdn.bilivideo.cn';
const asset = '/upgcxcode/39/54/' + CID + '/video.m4s';
const audioAsset = '/upgcxcode/39/54/' + CID + '/audio.m4s';
const log = [];
function pass(name) { log.push(name); console.log('PASS ' + name); }
assert.equal(C.identity('https://www.bilibili.com/video/' + BV + '/?trackid=a&vd_source=b').bvid, BV);
assert.equal(C.identity('https://www.bilibili.com/video/' + BV + '/?p=2').page, 2);
assert.equal(C.identity('https://example.com/video/' + BV), null);
assert.equal(C.identity('https://www.bilibili.com/zh-Hans/video/' + BV + '/?p=2').page, 2);
assert.equal(C.identity('https://www.bilibili.com/en/video/' + BV).bvid, BV);
assert.equal(C.identity('https://www.bilibili.com/list/zh-Hans/video/' + BV), null);
assert.ok(script.includes('// @match        https://www.bilibili.com/*/video/*\n'));
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
assert.equal(C.due({views: 3, lastCheckViews: 0, lastCheckAt: 3000000}, C.defaults, 2000000), true);
assert.equal(C.due({views: 3, lastCheckViews: 0, lastCheckAt: 0, missAt: 2000000 - 20 * 60000}, C.defaults, 2000000), false);
assert.equal(C.due({views: 3, lastCheckViews: 0, lastCheckAt: 0, missAt: 2000000 - 31 * 60000}, C.defaults, 2000000), true);
pass('M6/L21: a miss postpones periodic checks to three cooldowns; future timestamps count as never');
assert.ok(Math.abs(C.threshold({dash: {video: [{id: 80, bandwidth: 6000000}], audio: [{bandwidth: 320000}]}}, 35) - 8.216) < 1e-9);
assert.equal(C.threshold({dash: {video: [{id: 120, bandwidth: 3000000}]}}, 35), 35);
assert.equal(C.threshold({durl: [{url: 'https://' + currentHost + '/a.flv'}]}, 35), 35);
pass('M6: without a 4K track the target follows the best returned track');

async function setup(browser, mode = 'poor', extra = {}) {
    const context = await browser.newContext({viewport: {width: 1600, height: 1000}, colorScheme: 'dark', timezoneId: 'Asia/Tokyo'});
    const page = await context.newPage(); const errors = [], requests = []; let playurlCalls = 0;
    if (extra.clock) await page.clock.install();
    page.on('pageerror', e => errors.push(e.message));
    const pace = {...(extra.slowAll ? {'*': 60} : {}), ...(mode === 'poor' ? {[currentHost]: 60} : {}), ...extra.pace};
    await page.addInitScript(({script, extra, host, pace}) => {
        window.unsafeWindow = window;
        window.__gm = {CCB_main: host, ...extra.gm};
        window.GM_getValue = (k, d) => Object.hasOwn(window.__gm, k) ? window.__gm[k] : d;
        window.GM_setValue = (k, v) => { window.__gm[k] = v; };
        window.GM_registerMenuCommand = (name, action) => (window.__menus ||= []).push([name, action]);
        window.GM_xmlhttpRequest = options => {
            const controller = new AbortController();
            fetch(options.url, {signal: controller.signal}).then(async r => options.onload({status: r.status, responseText: await r.text()})).catch(() => options.onerror?.());
            return {abort: () => controller.abort()};
        };
        if (extra.session && !sessionStorage.getItem('fixture-initialized')) {
            sessionStorage.setItem('CCB_AUTO_session_v1', JSON.stringify(extra.session));
            sessionStorage.setItem('fixture-initialized', 'yes');
        }
        // Media bodies arrive in 64 KiB chunks every few ms, like a real link; route.fulfill alone delivers them at once.
        const baseFetch = window.fetch;
        window.fetch = async function (input, init) {
            if (!arguments.length) return baseFetch.call(this); // like the native fetch, so U5 sees the real rejection
            const response = await baseFetch.call(this, input, init);
            let step = 0;
            try { const name = new URL(response.url).hostname; step = pace[name] ?? (name.endsWith('.bilivideo.com') || name.endsWith('.bilivideo.cn') || name.endsWith('.akamaized.net') ? pace['*'] ?? 4 : 0); } catch (_) {}
            if (!step || response.status !== 206 || !response.body) return response;
            const data = new Uint8Array(await response.arrayBuffer());
            let offset = 0, started = 0;
            const paced = new Response(new ReadableStream({async pull(controller) {
                if (offset >= data.length) { controller.close(); return; }
                // Deadlines, not chained delays, so a busy test machine does not slow the simulated link.
                started ||= performance.now();
                const due = started + (offset / 65536 + 1) * step;
                await new Promise(resolve => setTimeout(resolve, Math.max(0, due - performance.now())));
                controller.enqueue(data.slice(offset, offset += 65536));
            }}), {status: response.status, statusText: response.statusText, headers: response.headers});
            Object.defineProperty(paced, 'url', {value: response.url});
            return paced;
        };
        // Counts every revoke, CCB's own included: it keeps the natives it finds when it loads, which are this wrapper.
        const countedRevoke = URL.revokeObjectURL; window.__revoked = [];
        URL.revokeObjectURL = function revokeObjectURL(url) { window.__revoked.push(String(url)); return countedRevoke.apply(URL, arguments); };
        eval(script);
        document.addEventListener('DOMContentLoaded', () => {
            const video = document.querySelector('video');
            if (!video) return;
            Object.defineProperties(video, {readyState: {get: () => window.__readyState ?? 4}, paused: {get: () => !!window.__paused},
                seeking: {get: () => !!window.__seeking},
                duration: {get: () => 3600}, buffered: {get: () => {
                    const ranges = window.__ranges || [[0, window.__bufferEnd ?? 500]];
                    return {length: ranges.length, start: i => ranges[i][0], end: i => ranges[i][1]};
                }}});
            video.currentTime = 123;
            video.play = async () => {window.__paused = false;}; video.pause = () => {window.__paused = true;};
        });
    }, {script, extra, host: currentHost, pace});
    await context.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url());
        const headers = {'access-control-allow-origin': 'https://www.bilibili.com', 'access-control-allow-credentials': 'true',
            'access-control-allow-headers': 'range,pragma', 'access-control-expose-headers': 'Content-Range,Content-Length', 'access-control-max-age': '600'};
        if (req.method() === 'OPTIONS') return route.fulfill({status: 204, headers});
        if (url.hostname === 'www.bilibili.com' && C.identity(url.href)) return route.fulfill({contentType: 'text/html', body: fixture});
        if (url.hostname === 'www.bilibili.com' && url.pathname === '/static/w.js') return route.fulfill({contentType: 'application/javascript', body: 'onmessage=e=>postMessage("rel-ok")'});
        if (url.hostname === 'www.bilibili.com' && url.pathname === '/static/a.js') return route.fulfill({contentType: 'application/javascript', body: 'importScripts("b.js");onmessage=e=>postMessage(self.__b)'});
        if (url.hostname === 'www.bilibili.com' && url.pathname === '/static/b.js') return route.fulfill({contentType: 'application/javascript', body: 'self.__b="nested-ok"'});
        // Relative fetch, sync XHR, Request and new URL(…, location) must all resolve against /static/, as without a wrapper.
        if (url.hostname === 'www.bilibili.com' && url.pathname === '/static/c.js') return route.fulfill({contentType: 'application/javascript',
            body: 'onmessage=async e=>{const t=await (await fetch("d.txt")).text();const x=new XMLHttpRequest();x.open("GET","d.txt",false);x.send();'
                + 'postMessage([self.location.href,String(location),location instanceof WorkerLocation,t,x.responseText,new URL("d.txt",location).href,new Request("d.txt").url,JSON.stringify(location),new Request(null).url].join("|"))}'});
        if (url.hostname === 'www.bilibili.com' && url.pathname === '/static/sh.js') return route.fulfill({contentType: 'application/javascript',
            body: 'const URL=1;onmessage=async e=>postMessage(await (await fetch("d.txt")).text())'});
        if (url.hostname === 'www.bilibili.com' && url.pathname === '/static/mc.js') return route.fulfill({contentType: 'application/javascript', body: 'onmessage=async e=>postMessage(await (await fetch("d.txt")).text())'});
        // A two-argument open() must stay async; module top-level code must already see the script's own base.
        if (url.hostname === 'www.bilibili.com' && url.pathname === '/static/x2.js') return route.fulfill({contentType: 'application/javascript',
            body: 'onmessage=e=>{const x=new XMLHttpRequest();x.open("GET","d.txt");let sync=null;x.onloadend=()=>postMessage(x.responseText+"|"+sync);x.send();sync=x.readyState===4}'});
        if (url.hostname === 'www.bilibili.com' && url.pathname === '/static/mt.js') return route.fulfill({contentType: 'application/javascript',
            body: 'const at=self.location.href,p=fetch("d.txt").then(r=>r.text(),e=>"ERR "+e.name);self.onmessage=async e=>postMessage(at+"|"+await p)'});
        if (url.hostname === 'www.bilibili.com' && url.pathname === '/static/d.txt') return route.fulfill({contentType: 'text/plain', body: 'D'});
        if (url.hostname === 'www.bilibili.com' && url.pathname === '/static/m.js') return route.fulfill({contentType: 'application/javascript', body: 'let first;self.addEventListener("message",e=>{first??=e.data;postMessage(first)})'});
        if (url.hostname === 'raw.githubusercontent.com' && extra.repoDown) return route.abort();
        if (url.hostname === 'raw.githubusercontent.com') return route.fulfill({headers, contentType: 'application/json', body: fs.readFileSync(path.join(root, 'data/' + (url.pathname.endsWith('region.json') ? 'region.json' : 'cdn.json')), 'utf8')});
        if (url.pathname === '/x/player/pagelist' && extra.failPagelist) return route.fulfill({headers, contentType: 'application/json', body: JSON.stringify({code: -352, data: null})});
        if (url.pathname === '/x/player/pagelist') return route.fulfill({headers, contentType: 'application/json', body: JSON.stringify({code: 0, data: [{page: 1, cid: CID}, {page: 2, cid: CID + 1}]})});
        if (url.pathname === '/x/player/playurl') {
            const cid = Number(url.searchParams.get('cid')) || CID, deadline = '?deadline=' + (playurlCalls += 1);
            const video = 'https://' + currentHost + asset.replace(String(CID), String(cid)) + deadline;
            const audio = 'https://' + currentHost + audioAsset.replace(String(CID), String(cid)) + deadline;
            // mcdn addresses carry :4483 and a /v1/resource/ path; the upos copy is only in backup_url.
            const track = (url, name) => extra.mcdn ? {base_url: 'https://' + mcdnHost + ':4483/v1/resource/' + cid + '-' + name, backup_url: [url]} : {base_url: url};
            // mcdn2: a second track is served only from an mcdn node, so the player's host is absent from the first track.
            const tracks = extra.mcdn2 ? [{base_url: video}, {base_url: 'https://' + mcdnHost + ':4483/v1/resource/' + cid + '-hd.m4s', backup_url: [video]}] : [track(video, 'video.m4s')];
            return route.fulfill({headers, contentType: 'application/json', body: JSON.stringify({code: 0, data: {timelength: 1200000, dash: {
                video: tracks.map((t, i) => ({id: extra.hd || i ? 80 : 120, codecid: 7, bandwidth: 3000000, ...t})),
                audio: [{id: 30280, bandwidth: 320000, ...track(audio, 'audio.m4s')}],
            }}})});
        }
        if (C.host(url.origin) || (url.hostname === mcdnHost && url.port === '4483')) {
            const range = req.headers().range;
            const total = extra.size || 100000000, end = Math.min(range ? Number(range.match(/-(\d+)$/)[1]) : 1023, total - 1);
            requests.push({host: url.hostname, range, path: url.pathname, port: url.port});
            if (extra.usableHosts && !extra.usableHosts.includes(url.hostname)) return route.fulfill({status: 403, headers, body: 'unavailable'});
            if (extra.expired && extra.expired.includes(url.searchParams.get('deadline'))) return route.fulfill({status: 403, headers, body: 'expired'});
            const slow = (mode === 'poor' || extra.slowMs) && url.hostname === currentHost && end > 1024;
            await new Promise(r => setTimeout(r, slow ? extra.slowMs || 650 : (url.hostname === currentHost && extra.ttfb) || 8));
            if (extra.invalid && end > 1) return route.fulfill({status: 200, headers, contentType: 'text/html', body: '<html>bad</html>'});
            return route.fulfill({status: 206, headers: {...headers, 'content-range': `bytes 0-${end}/${total}`, 'content-length': String(end + 1)},
                contentType: 'application/octet-stream', body: Buffer.alloc(end + 1, 0x42)});
        }
        return route.abort();
    });
    await page.goto(extra.url || 'https://www.bilibili.com/video/' + BV);
    await page.waitForSelector('#ccb-auto-widget', {state: 'attached'});
    await page.waitForTimeout(1400);
    return {context, page, errors, requests};
}

(async () => {
    const browser = await chromium.launch({executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
        ignoreDefaultArgs: ['--disable-back-forward-cache']});
    try {
        const healthy = await setup(browser, 'healthy');
        await healthy.page.evaluate(async ({host, asset}) => {
            const r = await fetch('https://' + host + asset, {headers: {Range: 'bytes=0-262143'}}); await r.arrayBuffer();
        }, {host: currentHost, asset});
        await healthy.page.waitForTimeout(1100);
        const badge = healthy.page.getByRole('button', {name: '驿程：视频网络状态与设置'});
        assert.match(await badge.getAttribute('title'), /分段加载/);
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
        assert.match(await badge.getAttribute('title'), /分段加载/);
        pass('Real Blob Worker fetch, private metrics channel and unchanged player message protocol');
        await badge.click();
        await healthy.page.getByRole('button', {name: '重新巡站', exact: true}).click();
        await healthy.page.getByRole('button', {name: /^改走 .+ 并刷新$/}).waitFor({timeout: 45000});
        assert.equal(await healthy.page.getByRole('radio').count(), 3);
        assert.equal(await healthy.page.evaluate(() => sessionStorage.getItem('CCB_AUTO_active_v1')), null);
        assert.deepEqual(healthy.errors, []);
        pass('Manual check also offers three verified alternatives for a healthy current node; no automatic replacement');
        await healthy.context.close();

        const poor = await setup(browser);
        await poor.page.getByRole('button', {name: '驿程：视频网络状态与设置'}).click();
        await poor.page.getByRole('button', {name: '重新巡站', exact: true}).click();
        await poor.page.getByRole('button', {name: /^改走 .+ 并刷新$/}).waitFor({timeout: 45000});
        const tested = new Set(poor.requests.filter(r => r.range === 'bytes=0-262143').map(r => r.host));
        assert.equal(tested.size, pool.length - 1);
        assert.ok([...tested].every(host => pool.some(n => n.host === host)));
        assert.equal(await poor.page.evaluate(() => sessionStorage.getItem('CCB_AUTO_active_v1')), null);
        const choices = poor.page.getByRole('radio');
        assert.equal(await choices.count(), 3);
        const selectedHost = await choices.nth(2).inputValue();
        await choices.nth(2).check();
        await poor.page.getByRole('button', {name: '收起', exact: true}).click();
        await poor.page.getByRole('button', {name: '驿程：视频网络状态与设置'}).click();
        assert.equal(await poor.page.getByRole('radio').nth(2).isChecked(), true);
        await poor.page.screenshot({path: path.join(root, 'dist/preview-dark.png')});
        pass('Poor node confirms, scans all 16 repository candidates without rewrite collapse, and waits for consent');
        await poor.page.getByRole('button', {name: /^改走 .+ 并刷新$/}).click();
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
        await stale.page.getByRole('button', {name: '驿程：视频网络状态与设置'}).click();
        await stale.page.getByRole('button', {name: '重新巡站', exact: true}).click();
        await stale.page.waitForTimeout(250);
        await stale.page.evaluate(() => history.pushState({}, '', '?p=2'));
        await stale.page.waitForTimeout(1800);
        assert.equal(await stale.page.evaluate(() => sessionStorage.getItem('CCB_AUTO_active_v1')), null);
        await stale.page.getByRole('button', {name: '驿程：视频网络状态与设置'}).click();
        assert.equal(await stale.page.getByRole('button', {name: /^改走 .+ 并刷新$/}).count(), 0);
        assert.deepEqual(stale.errors, []);
        pass('SPA/P switch cancels old measurements and drops old proposals');
        await stale.context.close();

        const counting = await setup(browser, 'healthy', {gm: {CCB_AUTO_settings_v1: {watchedSeconds: 5, everyVideos: 3}},
            session: {views: 2, lastCheckViews: 0, lastCheckAt: Date.now() - 20 * 60000, lastCountedBvid: 'BV13aH46QEZ6'}});
        await counting.page.getByRole('button', {name: '驿程：视频网络状态与设置'}).click();
        await counting.page.getByText('节点正常', {exact: true}).waitFor({timeout: 20000});
        const counters = await counting.page.evaluate(() => JSON.parse(sessionStorage.getItem('CCB_AUTO_session_v1')));
        assert.equal(counters.views, 3); assert.equal(counters.lastCheckViews, 3);
        const checks = counting.requests.filter(r => r.range === 'bytes=0-1048575').length;
        assert.equal(checks, 1);
        assert.equal(await counting.page.getByRole('radio').count(), 0);
        await counting.page.getByText('设置', {exact: true}).click();
        await counting.page.getByLabel('每几个视频检查', {exact: true}).fill('4');
        await counting.page.getByLabel('目标 Mbps', {exact: true}).fill('45');
        await counting.page.getByRole('button', {name: '保存设置'}).click();
        assert.equal(await counting.page.evaluate(() => window.__gm.CCB_AUTO_settings_v1.everyVideos), 4);
        assert.equal(await counting.page.evaluate(() => window.__gm.CCB_AUTO_settings_v1.minMbps), 45);
        assert.equal(await counting.page.locator('.footnote').count(), 0);
        assert.deepEqual(counting.errors, []);
        pass('Third qualified video triggers one automatic small check; settings are editable and persisted');
        await counting.context.close();

        const invalid = await setup(browser, 'healthy', {invalid: true});
        await invalid.page.getByRole('button', {name: '驿程：视频网络状态与设置'}).click();
        await invalid.page.getByRole('button', {name: '重新巡站', exact: true}).click();
        await invalid.page.getByText('暂未找到可用的香港／海外节点：HTTP 200 ×15', {exact: true}).waitFor({timeout: 45000});
        assert.equal(await invalid.page.getByRole('button', {name: /^改走 .+ 并刷新$/}).count(), 0);
        assert.equal(await invalid.page.evaluate(() => sessionStorage.getItem('CCB_AUTO_active_v1')), null);
        assert.deepEqual(invalid.errors, []);
        pass('HTTP 200 error pages across all nodes cannot produce a winning replacement');
        await invalid.context.close();

        const twoHosts = pool.filter(node => node.host !== currentHost).slice(0, 2).map(node => node.host);
        const limited = await setup(browser, 'poor', {usableHosts: twoHosts});
        await limited.page.getByRole('button', {name: '驿程：视频网络状态与设置'}).click();
        await limited.page.getByRole('button', {name: '重新巡站', exact: true}).click();
        await limited.page.getByRole('button', {name: /^改走 .+ 并刷新$/}).waitFor({timeout: 45000});
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
        await stalled.page.getByRole('button', {name: /^改走 .+ 并刷新$/}).waitFor({timeout: 45000});
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

        const localized = await setup(browser, 'healthy', {url: 'https://www.bilibili.com/zh-Hans/video/' + BV + '/'});
        await localized.page.getByRole('button', {name: '驿程：视频网络状态与设置'}).click();
        await localized.page.getByRole('button', {name: '重新巡站', exact: true}).click();
        await localized.page.getByRole('button', {name: /^改走 .+ 并刷新$/}).waitFor({timeout: 45000});
        assert.deepEqual(localized.errors, []);
        pass('H6: /zh-Hans/video/ locale path mounts the widget and runs a scan');
        await localized.context.close();

        const mcdn = await setup(browser, 'healthy', {mcdn: true, gm: {CCB_main: '使用默认源'}});
        await mcdn.page.evaluate(async host => {
            const r = await fetch('https://' + host + ':4483/v1/resource/42604365439-video.m4s', {headers: {Range: 'bytes=0-262143'}}); await r.arrayBuffer();
        }, mcdnHost);
        await mcdn.page.waitForTimeout(1100);
        assert.match(await mcdn.page.getByRole('button', {name: '驿程：视频网络状态与设置'}).getAttribute('title'), /分段加载/);
        await mcdn.page.getByRole('button', {name: '驿程：视频网络状态与设置'}).click();
        await mcdn.page.getByRole('button', {name: '重新巡站', exact: true}).click();
        await mcdn.page.getByRole('button', {name: /^改走 .+ 并刷新$/}).waitFor({timeout: 45000});
        const swapped = mcdn.requests.filter(r => r.host !== mcdnHost);
        assert.ok(swapped.length > 0 && swapped.every(r => r.port === '' && (r.path === asset || r.path === audioAsset)));
        assert.ok(mcdn.requests.some(r => r.host === mcdnHost && r.range === 'bytes=0-0'));
        assert.deepEqual(mcdn.errors, []);
        pass('H2: mcdn :4483 sources probe pool nodes on the default port via the upos backup path; ported telemetry counts');
        await mcdn.context.close();

        const dueSoon = {gm: {CCB_AUTO_settings_v1: {watchedSeconds: 5, everyVideos: 3}},
            session: {views: 2, lastCheckViews: 0, lastCheckAt: Date.now() - 20 * 60000, lastCountedBvid: 'BV13aH46QEZ6'}};
        const distant = await setup(browser, 'healthy', {...dueSoon, ttfb: 200});
        await distant.page.waitForRequest(r => r.headers().range === 'bytes=0-1048575', {timeout: 20000});
        await distant.page.waitForTimeout(1500);
        assert.equal(distant.requests.filter(r => r.range === 'bytes=0-2097151').length, 0);
        assert.ok(distant.requests.every(r => r.host === currentHost));
        pass('H1: a 200 ms TTFB node with ample bandwidth passes the 1 MiB light check without a recheck or scan');
        await distant.page.getByRole('button', {name: '驿程：视频网络状态与设置'}).click();
        await distant.page.getByRole('button', {name: '重新巡站', exact: true}).click();
        await distant.page.getByRole('button', {name: /^改走 .+ 并刷新$/}).waitFor({timeout: 45000});
        assert.equal(new Set(distant.requests.filter(r => r.range === 'bytes=0-2097151').map(r => r.host)).size, 5);
        assert.equal(await distant.page.getByRole('radio').count(), 3);
        assert.deepEqual(distant.errors, []);
        pass('L1: verification samples five shortlisted nodes before offering the best three');
        await distant.context.close();

        const short = await setup(browser, 'healthy', {size: 1500000});
        await short.page.getByRole('button', {name: '驿程：视频网络状态与设置'}).click();
        await short.page.getByRole('button', {name: '重新巡站', exact: true}).click();
        await short.page.getByRole('button', {name: /^改走 .+ 并刷新$/}).waitFor({timeout: 45000});
        assert.ok(short.requests.some(r => r.range === 'bytes=0-1499999'));
        assert.deepEqual(short.errors, []);
        pass('L2: a media file shorter than the 2 MiB sample is measured at its full length');
        await short.context.close();

        const busy = await setup(browser, 'healthy', dueSoon);
        await busy.page.evaluate(({host, asset}) => {
            window.__player = setInterval(() => fetch('https://' + host + asset, {headers: {Range: 'bytes=0-262143'}}).then(r => r.arrayBuffer()), 600);
        }, {host: currentHost, asset});
        await busy.page.waitForTimeout(9000);
        assert.equal(busy.requests.filter(r => r.range === 'bytes=0-0').length, 0);
        await busy.page.evaluate(() => clearInterval(window.__player));
        await busy.page.waitForRequest(r => r.headers().range === 'bytes=0-0', {timeout: 8000});
        assert.deepEqual(busy.errors, []);
        pass('L5: the periodic check waits until the player has paused downloading for 2 s');
        await busy.context.close();

        const workerChecks = page => page.evaluate(async ({host, asset}) => {
            const talk = (w, msg = 'ping') => new Promise(resolve => {
                const t = setTimeout(() => resolve('TIMEOUT'), 5000);
                w.onerror = e => { clearTimeout(t); resolve('ERROR ' + e.message); };
                w.onmessage = e => { clearTimeout(t); resolve(e.data); };
                w.postMessage(msg);
            });
            const blobWorker = (code, type, options) => {
                const u = URL.createObjectURL(new Blob([code], type ? {type} : undefined));
                const w = new Worker(u, options); URL.revokeObjectURL(u); return w;
            };
            const r = {}, echo = 'onmessage=e=>postMessage("ok:"+JSON.stringify(e.data))';
            r.revoked = await talk(blobWorker(echo, 'application/javascript'));
            r.revokedModule = await talk(blobWorker(echo, 'text/javascript', {type: 'module'}));
            r.untyped = await talk(blobWorker(echo, ''));
            const revokedBefore = window.__revoked.length;
            r.relative = await talk(new Worker('/static/w.js'));
            const revoked = window.__revoked.slice(revokedBefore);
            r.wrapperRevoked = revoked.length === 1 && revoked[0].startsWith('blob:');
            r.nested = await talk(new Worker('/static/a.js'));
            r.urls = await talk(new Worker('/static/c.js'));
            r.moduleFetch = await talk(new Worker('/static/mc.js', {type: 'module'}));
            const own = URL.createObjectURL(new Blob(['onmessage=e=>postMessage(self.location.href)'], {type: 'application/javascript'}));
            r.blobLocation = await talk(new Worker(own)) === own; URL.revokeObjectURL(own);
            r.instances = new Blob([]) instanceof Blob && new Worker('/static/w.js') instanceof Worker;
            r.text = await new Blob(['bili importScripts WorkerGlobalScope']).text() === 'bili importScripts WorkerGlobalScope';
            class Sub extends Worker { hi() { return 1; } }
            const sub = new Sub('/static/w.js');
            r.subclass = sub instanceof Sub && sub.hi() === 1 && Worker.name + '/' + Worker.length === 'Worker/1' && new Worker('/static/w.js').constructor === Worker;
            sub.terminate();
            try { new Worker('https://s1.hdslb.com/static/w.js'); r.crossOrigin = 'no throw'; } catch (e) { r.crossOrigin = e.name; }
            r.xhrAsync = await talk(new Worker('/static/x2.js'));
            r.moduleTop = await talk(new Worker('/static/mt.js', {type: 'module'}));
            const hashed = URL.createObjectURL(new Blob(['onmessage=e=>postMessage(self.location.href+"|"+!!self.__CCB_WORKER_PRELUDE__)'], {type: 'application/javascript'}));
            r.blobHash = await talk(new Worker(hashed + '#h')) === hashed + '#h|true'; URL.revokeObjectURL(hashed);
            const early = URL.createObjectURL(new Blob([echo], {type: 'application/javascript'})); URL.revokeObjectURL(early);
            r.revokedFirst = await talk(new Worker(early));
            // The page's Blob runs as its own script: a leading "use strict" or #! still applies, even untyped.
            r.strict = await talk(blobWorker('"use strict";onmessage=e=>postMessage(String((function(){return this})()===undefined))', ''));
            r.hashbang = await talk(blobWorker('#!/usr/bin/env worker\nonmessage=e=>postMessage("hb-ok")', 'application/javascript'));
            r.dataOrigin = await talk(new Worker('data:application/javascript,onmessage=e=>postMessage(self.origin)'));
            const seenBefore = window.__revoked.length;
            const rebuilt = blobWorker(echo, 'application/javascript');
            r.blobRevokes = window.__revoked.length - seenBefore; rebuilt.terminate();
            // A page script that declares its own global URL must not break CCB's cleanup or relative URLs.
            r.shadowed = await talk(blobWorker('const URL="https://api.example.com/";onmessage=e=>postMessage("shadow-ok")', ''));
            r.shadowedUrl = await talk(new Worker('/static/sh.js'));
            // sourceURL keeps the page's own blob URL as the error's file name.
            const thrower = URL.createObjectURL(new Blob(['onmessage=e=>{throw new Error("boom")}'], {type: 'application/javascript'}));
            const failing = new Worker(thrower);
            r.errorFile = await new Promise(resolve => { failing.onerror = e => { e.preventDefault(); resolve(e.filename === thrower && e.lineno === 1); }; failing.postMessage(1); });
            URL.revokeObjectURL(thrower); failing.terminate();
            r.fetchNoArgs = await fetch().then(() => 'resolved', e => e.message);
            r.fetchNoArgsWorker = await talk(blobWorker('onmessage=async e=>postMessage(await fetch().then(()=>"resolved",e=>e.message))', 'application/javascript'));
            // Upstream rewrote the danmaku mask to the chosen node, where it fails.
            await fetch('https://upos-sz-staticcos-cmask.bilivideo.com/cmaskboss/1_15_2.webmask', {headers: {Range: 'bytes=0-16'}}).then(r => r.arrayBuffer());
            const audio = new OfflineAudioContext(1, 128, 44100);
            const module = URL.createObjectURL(new Blob(["registerProcessor('ccb-test',class extends AudioWorkletProcessor{process(){return false}})"], {type: 'application/javascript; charset=utf-8'}));
            try { await audio.audioWorklet.addModule(module); new AudioWorkletNode(audio, 'ccb-test'); r.worklet = 'ok'; } catch (e) { r.worklet = e.name + ' ' + e.message; }
            const text = JSON.stringify({site: 'bilibili'});
            r.json = await new Blob([text], {type: 'application/json'}).text() === text;
            // Read in paced chunks so the transfer time after headers is measurable.
            const fetcher = `onmessage=async e=>{const r=await fetch('https://${host}${asset}',{headers:{Range:'bytes=0-262143'}});const reader=r.body.getReader();let n=0;for(;;){const p=await reader.read();if(p.done)break;n+=p.value.byteLength;await new Promise(t=>setTimeout(t,4))}postMessage(n)}`;
            r.fetched = await talk(blobWorker(fetcher, 'application/javascript'), 'go');
            return r;
        }, {host: currentHost, asset});
        // 使用默认源 guards against regressions; the upstream U1/U2 bugs themselves only show with a replacement node.
        for (const node of ['使用默认源', currentHost]) {
            const workers = await setup(browser, 'healthy', {gm: {CCB_main: node}});
            const r = await workerChecks(workers.page);
            assert.equal(r.revoked, 'ok:"ping"'); assert.equal(r.revokedModule, 'ok:"ping"'); assert.equal(r.untyped, 'ok:"ping"');
            assert.equal(r.relative, 'rel-ok'); assert.equal(r.wrapperRevoked, node !== '使用默认源'); assert.equal(r.fetched, 262144);
            assert.equal(r.worklet, 'ok');
            assert.equal(r.json, true); assert.equal(r.text, true); assert.equal(r.instances, true); assert.equal(r.nested, 'nested-ok');
            assert.equal(r.urls, 'https://www.bilibili.com/static/c.js|https://www.bilibili.com/static/c.js|true|D|D|https://www.bilibili.com/static/d.txt|https://www.bilibili.com/static/d.txt|{}|https://www.bilibili.com/static/null');
            // blobLocation guards the rebuilt-blob path; the pre-fix build passed blob Workers through, so it passed there too.
            assert.equal(r.moduleFetch, 'D'); assert.equal(r.blobLocation, true);
            assert.equal(r.subclass, true); assert.equal(r.crossOrigin, 'SecurityError');
            assert.equal(r.xhrAsync, 'D|false'); assert.equal(r.moduleTop, 'https://www.bilibili.com/static/mt.js|D');
            assert.equal(r.blobHash, true); assert.match(r.revokedFirst, /^ERROR/); assert.equal(r.strict, 'true'); assert.equal(r.hashbang, 'hb-ok');
            assert.equal(r.dataOrigin, 'null'); assert.equal(r.blobRevokes, 2);
            assert.equal(r.shadowed, 'shadow-ok'); assert.equal(r.shadowedUrl, 'D'); assert.equal(r.errorFile, true);
            assert.match(r.fetchNoArgs, /argument/); assert.match(r.fetchNoArgsWorker, /argument/);
            assert.ok(workers.requests.some(q => q.host === 'upos-sz-staticcos-cmask.bilivideo.com' && q.path.startsWith('/cmaskboss/')));
            await workers.page.waitForTimeout(1100);
            assert.match(await workers.page.getByRole('button', {name: '驿程：视频网络状态与设置'}).getAttribute('title'), /分段加载/);
            assert.deepEqual(workers.errors, []);
            await workers.context.close();
        }
        pass('H3/M4/U1-4: revoked Blob Workers load; wrapped Workers keep relative URLs, self.location, strict mode and native constructors; Blobs stay intact; the danmaku mask keeps its host');

        const buffering = page => page.evaluate(() => {
            const video = document.querySelector('video'); window.__paused = false; window.__readyState = 2;
            window.__bufferEnd = video.currentTime + 0.05; video.dispatchEvent(new Event('waiting'));
        });
        const playing = page => page.evaluate(() => {
            window.__readyState = 4; window.__bufferEnd = 500; document.querySelector('video').dispatchEvent(new Event('playing'));
        });
        const stored = page => page.evaluate(() => JSON.parse(sessionStorage.getItem('CCB_AUTO_session_v1') || '{}'));
        const firstPing = page => page.waitForRequest(request => request.headers().range === 'bytes=0-0', {timeout: 8000});
        const quietStall = {gm: {CCB_AUTO_settings_v1: {everyVideos: 30, cooldownMinutes: 120}}, session: {views: 0, lastCheckViews: 0, lastCheckAt: Date.now()}};
        const periodic = settings => ({gm: {CCB_AUTO_settings_v1: {watchedSeconds: 5, everyVideos: 3, stallDetection: false, ...settings}},
            session: {views: 2, lastCheckViews: 0, lastCheckAt: Date.now() - 20 * 60000, lastCountedBvid: 'BV13aH46QEZ6'}});

        const expiring = await setup(browser, 'poor', {...quietStall, clock: true});
        await buffering(expiring.page);
        await expiring.page.getByRole('button', {name: /^改走 .+ 并刷新$/}).waitFor({timeout: 45000});
        await expiring.page.getByRole('button', {name: '收起', exact: true}).click();
        await playing(expiring.page); await expiring.page.clock.fastForward(121000); await expiring.page.waitForTimeout(1200);
        await buffering(expiring.page); await firstPing(expiring.page);
        assert.deepEqual(expiring.errors, []);
        pass('M1: an unanswered proposal expires after two minutes and stops blocking stall checks');
        await expiring.context.close();

        const cancelling = await setup(browser, 'poor', periodic());
        await firstPing(cancelling.page);
        await cancelling.page.getByRole('button', {name: '驿程：视频网络状态与设置'}).click();
        await cancelling.page.getByRole('button', {name: '取消', exact: true}).click();
        await cancelling.page.waitForTimeout(300);
        const cancelledAt = cancelling.requests.length;
        await cancelling.page.waitForTimeout(3000);
        assert.equal(cancelling.requests.length, cancelledAt);
        assert.deepEqual(cancelling.errors, []);
        pass('M2: cancelling a periodic check holds off the next automatic check');
        await cancelling.context.close();

        const missing = {...quietStall, clock: true, usableHosts: [currentHost]};
        const backoff = await setup(browser, 'poor', missing);
        await buffering(backoff.page);
        await backoff.page.waitForFunction(() => JSON.parse(sessionStorage.getItem('CCB_AUTO_session_v1')).missAt > 0, null, {timeout: 45000});
        await playing(backoff.page); await backoff.page.clock.fastForward(100000); await backoff.page.waitForTimeout(1200);
        let quietFrom = backoff.requests.length;
        await buffering(backoff.page); await backoff.page.waitForTimeout(4000);
        assert.equal(backoff.requests.length, quietFrom);
        missing.usableHosts = null;
        await playing(backoff.page); await backoff.page.clock.fastForward(10 * 60000); await backoff.page.waitForTimeout(1200);
        await buffering(backoff.page);
        await backoff.page.waitForRequest(request => request.headers().range === 'bytes=0-262143', {timeout: 10000});
        await backoff.page.clock.fastForward(95000);
        await backoff.page.getByRole('button', {name: /^改走 .+ 并刷新$/}).waitFor({timeout: 45000});
        await backoff.page.getByRole('button', {name: '保持当前'}).click();
        await playing(backoff.page); await backoff.page.clock.fastForward(30000); await backoff.page.waitForTimeout(1200);
        quietFrom = backoff.requests.length;
        await buffering(backoff.page); await backoff.page.waitForTimeout(4000);
        assert.equal(backoff.requests.length, quietFrom);
        assert.deepEqual(backoff.errors, []);
        pass('M5: a miss backs stall scans off for 10 minutes; the 90 s cooldown counts from the end of a long scan');
        await backoff.context.close();

        const slowAll = await setup(browser, 'poor', {...periodic(), slowAll: true});
        await slowAll.page.waitForFunction(() => JSON.parse(sessionStorage.getItem('CCB_AUTO_session_v1')).lastCheckViews === 3, null, {timeout: 40000});
        assert.equal(slowAll.requests.filter(r => r.range === 'bytes=0-2097151').length, 6);
        assert.equal(await slowAll.page.getByRole('button', {name: '驿程：视频网络状态与设置'}).getAttribute('aria-expanded'), 'false');
        assert.ok((await stored(slowAll.page)).missAt > 0);
        assert.deepEqual(slowAll.errors, []);
        pass('M6: below half the target only the coarse top five are re-tested with 2 MiB; a periodic miss stays closed and is recorded');
        await slowAll.context.close();

        const refreshing = {...periodic(), clock: true};
        const refresh = await setup(browser, 'healthy', refreshing);
        refreshing.failPagelist = true;
        await refresh.page.clock.fastForward(21 * 60000);
        await refresh.page.waitForFunction(() => JSON.parse(sessionStorage.getItem('CCB_AUTO_session_v1')).views === 3, null, {timeout: 15000});
        await refresh.page.waitForTimeout(3000);
        assert.equal((await stored(refresh.page)).lastCheckViews, 0);
        assert.equal(refresh.requests.length, 0);
        assert.deepEqual(refresh.errors, []);
        pass('L6: a check that never probed (metadata refresh failed) does not use up the periodic quota');
        await refresh.context.close();

        const failing = {gm: {CCB_AUTO_settings_v1: {everyVideos: 30}}, failPagelist: true};
        const retrying = await setup(browser, 'healthy', failing);
        failing.failPagelist = false;
        await retrying.page.getByRole('button', {name: '驿程：视频网络状态与设置'}).click();
        await retrying.page.getByRole('button', {name: '重新巡站', exact: true}).click();
        await retrying.page.getByRole('button', {name: /^改走 .+ 并刷新$/}).waitFor({timeout: 45000});
        assert.deepEqual(retrying.errors, []);
        pass('L8: a manual check retries failed metadata immediately');
        await retrying.context.close();

        const blindStall = {...quietStall, clock: true, failPagelist: true};
        const blind = await setup(browser, 'poor', blindStall);
        await buffering(blind.page); await blind.page.waitForTimeout(3500);
        assert.equal((await stored(blind.page)).lastStallAt, undefined);
        assert.equal(blind.requests.length, 0);
        blindStall.failPagelist = false;
        await blind.page.clock.fastForward(61000); await firstPing(blind.page);
        assert.deepEqual(blind.errors, []);
        pass('L18: a stall without metadata is not used up; it fires once metadata returns');
        await blind.context.close();

        const fragmented = await setup(browser, 'healthy', periodic());
        await fragmented.page.evaluate(() => { window.__ranges = [[0, 123.3], [400, 500]]; });
        await fragmented.page.waitForTimeout(8000);
        assert.equal((await stored(fragmented.page)).views, 3);
        assert.equal(fragmented.requests.length, 0);
        pass('L17: periodic checks use the buffered range around the playhead, not the last range');
        await fragmented.context.close();

        const skewed = await setup(browser, 'poor', {...quietStall, session: {...quietStall.session, lastScanAt: Date.now() + 3600000}});
        await buffering(skewed.page); await firstPing(skewed.page);
        assert.deepEqual(skewed.errors, []);
        pass('L21: a stall cooldown stamped in the future (clock moved back) does not block stall checks');
        await skewed.context.close();

        const moduleWorker = await setup(browser, 'healthy');
        const firstMessage = await moduleWorker.page.evaluate(() => new Promise(resolve => {
            const w = new Worker('/static/m.js', {type: 'module'});
            w.onmessage = e => resolve(e.data); w.onerror = e => resolve('ERROR ' + e.message); w.postMessage('ping');
        }));
        assert.equal(firstMessage, 'ping'); assert.deepEqual(moduleWorker.errors, []);
        pass('L11: module Workers never receive the private metrics handshake');
        await moduleWorker.context.close();

        const gdfs = 'cn-gdfs-ct-01-01.bilivideo.com', autoNode = pool.find(node => node.region === '香港');
        const panel = await setup(browser, 'healthy', {repoDown: true, gm: {CCB_main: gdfs, region_main: '广东'}});
        const panelState = await panel.page.evaluate(async node => {
            sessionStorage.setItem('CCB_AUTO_active_v1', JSON.stringify({...node, at: Date.now()}));
            window.__menus.find(([name]) => name.startsWith('📺CCB'))[1]();
            for (let i = 0; i < 100 && !document.querySelector('#ccb-settings-panel select'); i++) await new Promise(r => setTimeout(r, 100));
            const [region, nodeSelect] = document.querySelectorAll('#ccb-settings-panel select');
            const shown = {regions: [...region.options].map(o => o.value), region: region.value, node: nodeSelect.value};
            region.value = '广东'; region.dispatchEvent(new Event('change'));
            const [, after] = document.querySelectorAll('#ccb-settings-panel select');
            return {shown, node: after.value, saved: window.__gm.CCB_main, manualAt: window.__gm.CCB_AUTO_manual_at, active: sessionStorage.getItem('CCB_AUTO_active_v1')};
        }, autoNode);
        assert.ok(panelState.shown.regions.includes('香港') && panelState.shown.regions.includes('广东'));
        assert.equal(panelState.shown.node, autoNode.host);
        assert.equal(panelState.node, gdfs); assert.equal(panelState.saved, gdfs);
        assert.ok(panelState.manualAt > 0); assert.equal(panelState.active, null);
        assert.deepEqual(panel.errors, []);
        pass('L10/L13: offline CCB panel lists the bundled snapshot; switching region restores the real saved node');
        await panel.context.close();

        const manualAt = Date.now();
        const shared = await setup(browser, 'healthy', {gm: {CCB_AUTO_manual_at: manualAt}});
        const mediaHost = async at => {
            await shared.page.evaluate(({node, at}) => sessionStorage.setItem('CCB_AUTO_active_v1', JSON.stringify({...node, at})), {node: autoNode, at});
            await shared.page.reload(); await shared.page.waitForSelector('#ccb-auto-widget', {state: 'attached'});
            await shared.page.evaluate(async ({host, asset}) => {
                const r = await fetch('https://' + host + asset, {headers: {Range: 'bytes=0-1023'}}); await r.arrayBuffer();
            }, {host: currentHost, asset});
            return shared.requests.filter(r => r.range === 'bytes=0-1023').at(-1).host;
        };
        assert.equal(await mediaHost(manualAt - 1000), currentHost);
        assert.equal(await mediaHost(manualAt + 500), autoNode.host);
        assert.deepEqual(shared.errors, []);
        pass('L12: a later manual choice recorded in shared GM storage (any tab or origin) cancels older automatic picks');
        await shared.context.close();

        const resigned = {gm: {CCB_AUTO_settings_v1: {everyVideos: 30}}, clock: true};
        const resign = await setup(browser, 'healthy', resigned);
        await resign.page.evaluate(async ({bvid, cid}) => {
            const r = await fetch('https://api.bilibili.com/x/player/playurl?' + new URLSearchParams({bvid, cid}), {credentials: 'include'}); await r.text();
        }, {bvid: BV, cid: CID});
        resigned.expired = ['1', '2'];
        await resign.page.clock.fastForward(21 * 60000); await resign.page.waitForTimeout(1200);
        await resign.page.getByRole('button', {name: '驿程：视频网络状态与设置'}).click();
        await resign.page.getByRole('button', {name: '重新巡站', exact: true}).click();
        await resign.page.getByRole('button', {name: /^改走 .+ 并刷新$/}).waitFor({timeout: 45000});
        assert.deepEqual(resign.errors, []);
        pass('L3: the 20-minute metadata refresh asks the API again instead of reusing page-load signatures');
        await resign.context.close();

        const cached = await setup(browser, 'healthy', {gm: {CCB_AUTO_settings_v1: {watchedSeconds: 5, everyVideos: 30}},
            session: {views: 0, lastCheckViews: 0, lastCheckAt: Date.now()}});
        await cached.page.waitForFunction(() => JSON.parse(sessionStorage.getItem('CCB_AUTO_session_v1') || '{}').views === 1, null, {timeout: 15000});
        await cached.page.evaluate(() => { window.__fromCache = true; });
        await cached.page.goto('https://www.bilibili.com/video/BV13aH46QEZ6');
        await cached.page.waitForFunction(() => JSON.parse(sessionStorage.getItem('CCB_AUTO_session_v1') || '{}').views === 2, null, {timeout: 15000});
        await cached.page.goBack({waitUntil: 'commit'}); await cached.page.waitForTimeout(1500);
        assert.equal(await cached.page.evaluate(() => window.__fromCache), true);
        await cached.page.getByRole('button', {name: '驿程：视频网络状态与设置'}).click();
        await cached.page.getByRole('button', {name: '重新巡站', exact: true}).click();
        await cached.page.getByRole('button', {name: /^改走 .+ 并刷新$/}).waitFor({timeout: 45000});
        assert.equal((await cached.page.evaluate(() => JSON.parse(sessionStorage.getItem('CCB_AUTO_session_v1')))).views, 2);
        assert.deepEqual(cached.errors, []);
        pass('L7: a page restored from the back/forward cache re-reads the session instead of overwriting it');
        await cached.context.close();

        const tabs = await setup(browser, 'poor', quietStall);
        await tabs.page.evaluate(() => {
            window.__gm.CCB_AUTO_settings_v1 = {...window.__gm.CCB_AUTO_settings_v1, stallDetection: false};
            Object.defineProperty(document, 'hidden', {configurable: true, get: () => !!window.__fixtureHidden});
            window.__fixtureHidden = true; document.dispatchEvent(new Event('visibilitychange'));
            window.__fixtureHidden = false; document.dispatchEvent(new Event('visibilitychange'));
        });
        await buffering(tabs.page); await tabs.page.waitForTimeout(3500);
        assert.equal(tabs.requests.length, 0);
        assert.deepEqual(tabs.errors, []);
        pass('L9: settings changed in another tab apply when this tab becomes visible');
        await tabs.context.close();

        const denied = await setup(browser, 'healthy', {usableHosts: []});
        await denied.page.getByRole('button', {name: '驿程：视频网络状态与设置'}).click();
        await denied.page.getByRole('button', {name: '重新巡站', exact: true}).click();
        await denied.page.getByText('暂未找到可用的香港／海外节点：HTTP 403 ×15', {exact: true}).waitFor({timeout: 45000});
        assert.deepEqual(denied.errors, []);
        pass('L19: a scan with no usable node names the failure causes (HTTP 403 is not reported as too slow)');
        await denied.context.close();

        const tiny = await setup(browser, 'healthy');
        await tiny.page.evaluate(async ({host, asset}) => {
            const r = await fetch('https://' + host + asset, {headers: {Range: 'bytes=0-4095'}}); await r.arrayBuffer();
        }, {host: currentHost, asset});
        await tiny.page.waitForTimeout(1100);
        assert.doesNotMatch(await tiny.page.getByRole('button', {name: '驿程：视频网络状态与设置'}).getAttribute('title'), /分段加载/);
        assert.deepEqual(tiny.errors, []);
        pass('L4: a few-KB index request is not shown as the live loading speed');
        await tiny.context.close();

        const small = await setup(browser, 'healthy');
        await small.page.evaluate(async ({host, asset}) => {
            for (let i = 0; i < 3; i++) { const r = await fetch('https://' + host + asset, {headers: {Range: 'bytes=0-163839'}}); await r.arrayBuffer(); }
        }, {host: currentHost, asset});
        await small.page.waitForTimeout(1100);
        assert.match(await small.page.getByRole('button', {name: '驿程：视频网络状态与设置'}).getAttribute('title'), /分段加载/);
        assert.deepEqual(small.errors, []);
        pass('L4: short auto-quality segments (160 KiB each) pool into a live reading');
        await small.context.close();

        const lowTarget = await setup(browser, 'healthy', {hd: true, pace: {'*': 30, [currentHost]: 4}});
        await lowTarget.page.getByRole('button', {name: '驿程：视频网络状态与设置'}).click();
        await lowTarget.page.getByRole('button', {name: '重新巡站', exact: true}).click();
        await lowTarget.page.getByText('暂未找到可用的香港／海外节点：速度不足 ×15', {exact: true}).waitFor({timeout: 45000});
        assert.equal(await lowTarget.page.getByRole('button', {name: /^改走 .+ 并刷新$/}).count(), 0);
        assert.deepEqual(lowTarget.errors, []);
        pass('M6: on a non-4K video a healthy current node is not traded for slower nodes that only meet the lowered target');
        await lowTarget.context.close();

        const away = await setup(browser, 'poor', {...quietStall, clock: true});
        await away.page.getByRole('button', {name: '驿程：视频网络状态与设置'}).click();
        await away.page.getByRole('button', {name: '重新巡站', exact: true}).click();
        await firstPing(away.page);
        await away.page.evaluate(() => { window.__fromCache = true; });
        await away.page.goto('https://www.bilibili.com/video/BV13aH46QEZ6');
        await away.page.goBack({waitUntil: 'commit'}); await away.page.waitForTimeout(1500);
        assert.equal(await away.page.evaluate(() => window.__fromCache), true);
        await away.page.clock.fastForward(100000); await away.page.waitForTimeout(1200);
        await buffering(away.page); await firstPing(away.page);
        assert.deepEqual(away.errors, []);
        pass('M2: leaving through the back/forward cache is not a user cancel; stall checks resume after the cooldown');
        await away.context.close();

        const janky = await setup(browser, 'healthy', {...dueSoon, slowMs: 400, pace: {[currentHost]: 0}});
        await janky.page.waitForRequest(r => r.headers().range === 'bytes=0-2097151', {timeout: 20000});
        await janky.page.waitForTimeout(1500);
        assert.ok(janky.requests.every(r => r.host === currentHost));
        assert.deepEqual(janky.errors, []);
        pass('H1: headers seen late with the body already buffered (a busy main thread) do not inflate throughput');
        await janky.context.close();

        const tracksApart = await setup(browser, 'healthy', {mcdn2: true, gm: {CCB_main: '使用默认源'}});
        await tracksApart.page.evaluate(async host => {
            const r = await fetch('https://' + host + ':4483/v1/resource/42604365439-hd.m4s', {headers: {Range: 'bytes=0-262143'}}); await r.arrayBuffer();
        }, mcdnHost);
        await tracksApart.page.getByRole('button', {name: '驿程：视频网络状态与设置'}).click();
        await tracksApart.page.getByRole('button', {name: '重新巡站', exact: true}).click();
        await tracksApart.page.getByRole('button', {name: /^改走 .+ 并刷新$/}).waitFor({timeout: 45000});
        assert.ok(tracksApart.requests.some(r => r.host === mcdnHost && r.port === '4483' && r.range === 'bytes=0-0'));
        assert.ok(!tracksApart.requests.some(r => r.host === mcdnHost && r.port === ''));
        assert.deepEqual(tracksApart.errors, []);
        pass('H2: the current mcdn node seen on another track is probed at its own address and port');
        await tracksApart.context.close();

        const regionKept = await setup(browser, 'healthy', {repoDown: true, gm: {CCB_main: gdfs, region_main: '广东'}});
        const kept = await regionKept.page.evaluate(async node => {
            sessionStorage.setItem('CCB_AUTO_active_v1', JSON.stringify({...node, at: Date.now()}));
            window.__menus.find(([name]) => name.startsWith('📺CCB'))[1]();
            for (let i = 0; i < 100 && !document.querySelector('#ccb-settings-panel select'); i++) await new Promise(r => setTimeout(r, 100));
            const [, nodeSelect] = document.querySelectorAll('#ccb-settings-panel select');
            const other = [...nodeSelect.options].map(o => o.value).find(v => v !== node.host && v.startsWith('cn-hk'));
            nodeSelect.value = other; nodeSelect.dispatchEvent(new Event('change'));
            return {other, saved: window.__gm.CCB_main, region: window.__gm.region_main};
        }, autoNode);
        assert.ok(kept.other); assert.equal(kept.saved, kept.other); assert.equal(kept.region, '香港');
        assert.deepEqual(regionKept.errors, []);
        pass('L10: picking a node while the panel shows the automatic region saves that region with it');
        await regionKept.context.close();
    } finally { await browser.close(); }
    fs.writeFileSync(path.join(root, 'dist/test-results.json'), JSON.stringify({passed: log, note: 'Deterministic Chrome fixture, not a signed-in Bilibili/Tampermonkey session'}, null, 2));
})().catch(e => {console.error(e); process.exitCode = 1;});
