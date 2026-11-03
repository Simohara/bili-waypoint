// 驿程 widget checks with GSAP and Google Fonts loaded as in Tampermonkey; writes comparison shots next to the concept.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../src/auto-core.js');
const {chromium} = require('C:/Users/simoh/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = path.resolve(__dirname, '..'), shots = path.join(root, 'design/widget-concepts');
const script = fs.readFileSync(path.join(root, 'dist/ccb-auto.user.js'), 'utf8');
const fixture = fs.readFileSync(path.join(__dirname, 'fixture.html'), 'utf8');
const gsapUrl = /@require\s+(\S+gsap\S+)/.exec(script)[1];
const BV = 'BV175ph6CERk', CID = 42604365439, currentHost = 'upos-sz-mirrorcosov.bilivideo.com';
const LIGHT = 'body{background:#fff;color:#18191c}.meta,.hint{color:#61666d}.sidebar{background:#f6f7f8}.sidebar div{background:#e3e5e7}.bar{background:#f1f2f3;color:#61666d}';
const GO = /^改走 .+ 并刷新$/;
const pass = name => console.log('PASS ' + name);
// Runs fn(shadowRoot, arg) inside the page.
const inWidget = (page, fn, arg) => page.evaluate(({fn, arg}) => (0, eval)(fn)(document.querySelector('#ccb-auto-widget').shadowRoot, arg), {fn: fn.toString(), arg});

async function setup(browser, gsapSource, {theme = 'dark', reduce = false} = {}) {
    const context = await browser.newContext({viewport: {width: 1440, height: 900}, reducedMotion: reduce ? 'reduce' : 'no-preference', timezoneId: 'Asia/Tokyo'});
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript({content: gsapSource});
    await page.addInitScript(({script, host}) => {
        window.unsafeWindow = window; window.__gm = {CCB_main: host};
        window.GM_getValue = (k, d) => Object.hasOwn(window.__gm, k) ? window.__gm[k] : d;
        window.GM_setValue = (k, v) => { window.__gm[k] = v; };
        window.GM_registerMenuCommand = (name, fn) => { if (name.includes('CCB 自动优选')) window.__menu = fn; };
        window.GM_xmlhttpRequest = options => {
            const controller = new AbortController();
            fetch(options.url, {signal: controller.signal}).then(async r => options.onload({status: r.status, responseText: await r.text()})).catch(() => options.onerror?.());
            return {abort: () => controller.abort()};
        };
        // Media bodies arrive in 64 KiB chunks (as in run.cjs); candidates get slightly different paces so speeds vary.
        const baseFetch = window.fetch;
        window.fetch = async function (input, init) {
            const response = await baseFetch.call(this, input, init), name = new URL(response.url).hostname;
            const step = name === host ? 60 : /\.(bilivideo\.com|akamaized\.net)$/.test(name) ? 3 + name.length % 4 : 0;
            if (!step || response.status !== 206 || !response.body) return response;
            const data = new Uint8Array(await response.arrayBuffer());
            let offset = 0;
            const paced = new Response(new ReadableStream({async pull(controller) {
                if (offset >= data.length) { controller.close(); return; }
                await new Promise(resolve => setTimeout(resolve, step));
                controller.enqueue(data.slice(offset, offset += 65536));
            }}), {status: response.status, statusText: response.statusText, headers: response.headers});
            Object.defineProperty(paced, 'url', {value: response.url});
            return paced;
        };
        eval(script);
        document.addEventListener('DOMContentLoaded', () => {
            const video = document.querySelector('video');
            Object.defineProperties(video, {readyState: {get: () => 4}, paused: {get: () => true}, duration: {get: () => 3600},
                buffered: {get: () => ({length: 1, start: () => 0, end: () => 500})}});
            video.currentTime = 123; video.play = async () => {}; video.pause = () => {};
        });
    }, {script, host: currentHost});
    await context.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url());
        const headers = {'access-control-allow-origin': 'https://www.bilibili.com', 'access-control-allow-credentials': 'true',
            'access-control-allow-headers': 'range,pragma', 'access-control-expose-headers': 'Content-Range,Content-Length', 'access-control-max-age': '600'};
        if (/^fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) return route.continue();
        if (req.method() === 'OPTIONS') return route.fulfill({status: 204, headers});
        if (url.hostname === 'www.bilibili.com' && url.pathname.startsWith('/video/')) return route.fulfill({contentType: 'text/html', body: fixture});
        if (url.hostname === 'raw.githubusercontent.com') return route.fulfill({headers, contentType: 'application/json', body: fs.readFileSync(path.join(root, 'upstream/data/cdn.json'), 'utf8')});
        if (url.pathname === '/x/player/pagelist') return route.fulfill({headers, contentType: 'application/json', body: JSON.stringify({code: 0, data: [{page: 1, cid: CID}]})});
        if (url.pathname === '/x/player/playurl') return route.fulfill({headers, contentType: 'application/json', body: JSON.stringify({code: 0, data: {timelength: 1200000, dash: {
            // The 4K track keeps the target at 35 Mbps, so the paced current node (~9 Mbps) falls short of it.
            video: [{id: 32, codecid: 7, bandwidth: 3000000, base_url: `https://${currentHost}/upgcxcode/39/54/${CID}/video.m4s`},
                {id: 120, codecid: 7, bandwidth: 20000000, base_url: `https://${currentHost}/upgcxcode/39/54/${CID}/video-4k.m4s`}],
            audio: [{id: 30280, bandwidth: 320000, base_url: `https://${currentHost}/upgcxcode/39/54/${CID}/audio.m4s`}]}}})});
        if (C.host(url.origin)) {
            const range = req.headers().range, end = range ? Number(range.match(/-(\d+)$/)[1]) : 1023;
            // Slow pings on candidates make the scan long enough to watch.
            const wait = end === 0 && url.hostname !== currentHost ? 120 : 8;
            await new Promise(r => setTimeout(r, wait));
            return route.fulfill({status: 206, headers: {...headers, 'content-range': `bytes 0-${end}/100000000`, 'content-length': String(end + 1)},
                contentType: 'application/octet-stream', body: Buffer.alloc(end + 1, 0x42)});
        }
        return route.abort();
    });
    await page.goto('https://www.bilibili.com/video/' + BV);
    if (theme === 'light') await page.addStyleTag({content: LIGHT});
    await page.waitForSelector('#ccb-auto-widget', {state: 'attached'});
    await page.waitForTimeout(1400);
    return {context, page, errors, capsule: page.getByRole('button', {name: 'CCB 视频网络状态与设置'})};
}
const fonts = page => page.evaluate(async () => {
    await document.fonts.ready;
    return document.fonts.check('17px "ZCOOL XiaoWei"', '驿程') && document.fonts.check('13px "Noto Sans SC"', '巡站');
});
const capsuleText = page => inWidget(page, r => [...r.querySelector('.cap').children].slice(1).map(n => n.textContent).join(' ').trim());
async function scanToProposal(page) {
    await page.getByRole('button', {name: '重新巡站', exact: true}).click();
    await page.getByRole('button', {name: GO}).waitFor({timeout: 45000});
    await page.waitForTimeout(1800);
}
const shot = (page, name) => page.screenshot({path: path.join(shots, 'impl-' + name + '.png')});

(async () => {
    const gsapSource = await (await fetch(gsapUrl)).text();
    assert.match(gsapSource, /GreenSock/);
    const browser = await chromium.launch({channel: 'chrome', headless: true});
    try {
        const light = await setup(browser, gsapSource, {theme: 'light'}), {page, capsule} = light;
        assert.equal(await inWidget(page, r => r.host.dataset.theme), 'light');
        await capsule.click();
        await page.waitForTimeout(1200);
        assert.ok(await fonts(page));
        assert.equal(await inWidget(page, r => r.querySelector('.panel').style.clipPath), '');
        await shot(page, 'idle');
        pass('Capsule opens the panel; fonts load from the document; the open clip is cleared');

        await page.getByRole('button', {name: '重新巡站', exact: true}).click();
        const cancel = page.getByRole('button', {name: '取消', exact: true});
        await cancel.waitFor();
        await page.waitForFunction(() => /^[2-9]\/15$/.test(document.querySelector('#ccb-auto-widget').shadowRoot.querySelector('.cap .num').textContent));
        await cancel.focus();
        await inWidget(page, r => { r.querySelector('.stop.cur').marked = 1; });
        await page.waitForTimeout(2200);
        assert.deepEqual(await inWidget(page, r => [r.activeElement && r.activeElement.textContent, !!r.querySelector('.stop.cur').marked,
            r.querySelector('.hd').classList.contains('riding'), r.querySelectorAll('.st.ok, .st.dim').length > 0]), ['取消', true, true, true]);
        assert.match(await capsuleText(page), /^\d+\/15 巡站中$/);
        pass('M3: ticks during a scan keep focus and DOM nodes; capsule shows n/15 巡站中 and the horse rides');
        await page.waitForFunction(() => /^(9|1\d)\/15$/.test(document.querySelector('#ccb-auto-widget').shadowRoot.querySelector('.cap .num').textContent));
        await shot(page, 'scan');

        await page.getByRole('button', {name: GO}).waitFor({timeout: 45000});
        await page.waitForTimeout(1800);
        // How many candidates pass verification depends on timer jitter under load; the UI must match whatever came back.
        const offered = await page.getByRole('radio').count();
        assert.ok(offered >= 2 && offered <= 3);
        assert.equal(await inWidget(page, r => r.querySelector('.cap').classList.contains('alert')), true);
        assert.equal(await inWidget(page, r => r.querySelector('.gap').textContent), offered + ' 站可换');
        await shot(page, 'open');
        pass('Proposal lists one row per candidate, the vermilion end on the capsule and “N 站可换”');
        assert.equal(await page.getByText(/^\d+ ms · 低于目标 35$/).isVisible(), true);
        pass('L19: the current node’s problem is written in the panel, not only in a tooltip');

        const host = await page.getByRole('radio').nth(1).inputValue();
        await page.getByRole('radio').nth(1).check();
        await page.waitForTimeout(700);
        const picked = await inWidget(page, r => {
            const row = r.querySelectorAll('.stop.cand')[1], mark = r.querySelector('.mark');
            return {dest: r.querySelector('.go b').textContent, delta: Math.abs(mark.offsetTop + 8.5 - (row.offsetTop + row.offsetHeight / 2)), sel: r.querySelectorAll('.st.sel').length};
        });
        assert.equal(picked.dest, host.replace(/\.bilivideo\.com$/, '').replace(/^(?:cn-|upos-[a-z0-9]+-)/, ''));
        assert.ok(picked.delta < 1); assert.equal(picked.sel, 1);
        pass('Choosing a station slides the mark, flips the destination and lights one vermilion station');

        await page.getByRole('button', {name: '设置', exact: true}).click();
        await scanToProposal(page);
        assert.ok(await page.getByRole('radio').count() >= 1);
        assert.equal(await page.getByLabel('每几个视频检查', {exact: true}).isVisible(), true);
        pass('H5: with settings open, a new scan still delivers its proposal');
        await page.getByRole('button', {name: '设置', exact: true}).click();

        await page.getByRole('button', {name: '收起', exact: true}).click();
        assert.equal(await page.getByRole('dialog').count(), 0);
        await page.waitForTimeout(300);
        await shot(page, 'alert');
        await capsule.click();
        await page.waitForTimeout(1500);
        const chosen = await page.getByRole('radio').last().inputValue();
        await page.getByRole('radio').last().check();
        await page.waitForTimeout(500);
        const reload = page.waitForEvent('framenavigated', {timeout: 8000});
        await page.getByRole('button', {name: GO}).click();
        await page.waitForTimeout(900);
        assert.deepEqual(await inWidget(page, r => [r.querySelector('.go').textContent, Number(getComputedStyle(r.querySelector('.seal')).opacity) > .9]), ['正在刷新…', true]);
        await shot(page, 'stamp');
        await reload; await page.waitForLoadState('load');
        assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('CCB_AUTO_active_v1')).host), chosen);
        pass('改走 draws the trail, stamps 换, then reloads onto the chosen node');

        await page.addStyleTag({content: LIGHT});
        await page.waitForTimeout(1400);
        await page.evaluate(() => { const t = document.createElement('textarea'); t.id = 'comment'; document.querySelector('.hint').after(t); });
        await capsule.click();
        await page.locator('#comment').focus();
        await page.keyboard.press('Escape');
        assert.equal(await page.getByRole('dialog').count(), 1);
        assert.equal(await page.evaluate(() => document.activeElement.id), 'comment');
        await page.getByRole('button', {name: '设置', exact: true}).focus();
        await page.keyboard.press('Escape');
        assert.equal(await page.getByRole('dialog').count(), 0);
        assert.equal(await inWidget(page, r => r.activeElement && r.activeElement.classList.contains('cap')), true);
        pass('L14: Esc from the comment box leaves the panel alone; Esc inside closes it and returns focus');

        await page.evaluate(() => { document.body.style.paddingBottom = '3000px'; scrollTo(0, 900); });
        await page.waitForTimeout(200);
        assert.equal(await inWidget(page, r => getComputedStyle(r.host).display), 'none');
        await page.evaluate(() => window.__menu());
        await page.waitForTimeout(200);
        const corner = await inWidget(page, r => {
            const box = r.querySelector('.panel').getBoundingClientRect();
            return [getComputedStyle(r.host).display !== 'none', r.querySelector('.cap').hidden, Math.round(document.documentElement.clientWidth - box.right), Math.round(box.top)];
        });
        assert.deepEqual(corner, [true, true, 16, 16]);
        await page.evaluate(() => scrollTo(0, 0));
        await page.waitForTimeout(200);
        assert.equal(await capsule.isVisible(), true);
        await page.getByRole('button', {name: '收起', exact: true}).click();
        pass('H4: hidden really hides the host; an open panel moves to the corner when the title scrolls away');

        await page.evaluate(() => { const p = document.querySelector('.player'); p.classList.add('bpx-player-container'); p.dataset.screen = 'web'; });
        await page.waitForTimeout(1200);
        assert.equal(await inWidget(page, r => getComputedStyle(r.host).display), 'none');
        await page.evaluate(() => { document.querySelector('.player').dataset.screen = 'normal'; });
        await page.waitForTimeout(1200);
        assert.equal(await capsule.isVisible(), true);
        pass('L15: web fullscreen on the player container hides the widget');

        await capsule.click();
        await page.getByRole('button', {name: '设置', exact: true}).click();
        const auto = page.getByRole('checkbox', {name: '自动检查', exact: true}), stall = page.getByRole('checkbox', {name: /卡顿时测速/});
        await auto.uncheck();
        assert.equal(await stall.isDisabled(), true);
        assert.equal(await page.getByText('随自动检查关闭', {exact: true}).isVisible(), true);
        await page.waitForTimeout(400);
        await shot(page, 'settings');
        await auto.check();
        assert.equal(await stall.isDisabled(), false);
        pass('L20: turning automatic checks off disables the stall switch with a reason');

        const every = page.getByLabel('每几个视频检查', {exact: true});
        await every.fill('');
        await page.getByRole('button', {name: '保存设置'}).click();
        assert.equal(await page.evaluate(() => window.__gm.CCB_AUTO_settings_v1), undefined);
        assert.equal(await every.evaluate(input => input.validity.valueMissing), true);
        await every.fill('5');
        await page.getByRole('button', {name: '保存设置'}).click();
        assert.equal(await page.evaluate(() => window.__gm.CCB_AUTO_settings_v1.everyVideos), 5);
        assert.equal(await inWidget(page, r => r.querySelector('.brand span').textContent), '设置已保存');
        assert.deepEqual(light.errors, []);
        pass('L16: an emptied number field blocks saving instead of restoring the default');

        const back = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        await every.fill('6');
        await back();
        assert.equal(await every.inputValue(), '6');
        await page.evaluate(() => { window.__gm.CCB_AUTO_settings_v1 = {...window.__gm.CCB_AUTO_settings_v1, everyVideos: 8}; });
        await back();
        assert.equal(await every.inputValue(), '8');
        pass('L9: an open form keeps unsaved edits on return and picks up settings saved in another tab');

        await page.evaluate(() => {
            const s = JSON.parse(sessionStorage.getItem('CCB_AUTO_session_v1') || '{}');
            sessionStorage.setItem('CCB_AUTO_session_v1', JSON.stringify({...s, missAt: Date.now()}));
        });
        await page.reload(); await page.addStyleTag({content: LIGHT}); await page.waitForTimeout(1400);
        assert.deepEqual(await inWidget(page, r => [r.querySelector('.cap').classList.contains('miss'), r.querySelector('.panel').hidden]), [true, true]);
        await shot(page, 'miss');
        assert.deepEqual(light.errors, []);
        pass('M6: a scan that found nothing leaves the capsule’s end station hollow and the panel closed');
        await light.context.close();

        const dark = await setup(browser, gsapSource);
        assert.equal(await inWidget(dark.page, r => r.host.dataset.theme), 'dark');
        await dark.capsule.click();
        await scanToProposal(dark.page);
        await fonts(dark.page);
        await shot(dark.page, 'dark');
        assert.deepEqual(dark.errors, []);
        pass('Dark theme follows the Bilibili title colour');
        await dark.context.close();

        const still = await setup(browser, gsapSource, {theme: 'light', reduce: true});
        await still.capsule.click();
        await scanToProposal(still.page);
        await still.page.getByRole('radio').last().check();
        assert.ok(await inWidget(still.page, r => {
            const row = [...r.querySelectorAll('.stop.cand')].at(-1), mark = r.querySelector('.mark');
            return Math.abs(mark.offsetTop + 8.5 - (row.offsetTop + row.offsetHeight / 2)) < 1;
        }), 'the mark jumps without travelling');
        await still.page.getByRole('button', {name: '收起', exact: true}).click();
        await still.capsule.click();
        await still.page.waitForTimeout(120);
        assert.ok(await inWidget(still.page, r => [...r.querySelectorAll('.stop, .hill, .go, .ft')].every(n => {
            const m = new DOMMatrix(getComputedStyle(n).transform === 'none' ? undefined : getComputedStyle(n).transform);
            return Math.abs(m.e) < .01 && Math.abs(m.f) < .01;
        })), 'rows and hills do not move while fading in');
        await still.page.waitForTimeout(1500);
        await shot(still.page, 'reduce');
        const reload2 = still.page.waitForEvent('framenavigated', {timeout: 8000});
        await still.page.getByRole('button', {name: GO}).click();
        await still.page.waitForTimeout(320);
        const seal = await inWidget(still.page, r => { const m = new DOMMatrix(getComputedStyle(r.querySelector('.seal')).transform); return Math.hypot(m.a, m.b); });
        assert.ok(Math.abs(seal - 1) < .01, 'the seal is stamped without the zoom');
        await reload2;
        assert.deepEqual(still.errors, []);
        pass('Reduced motion keeps state changes and drops travel, zoom and squash');
        await still.context.close();
    } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
