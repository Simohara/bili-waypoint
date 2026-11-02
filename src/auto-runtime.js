/* CCB Auto: contextual measurements, repository nodes, consent UI. MIT. */
function createCcbAuto(env) {
    const C = env.core, SKEY = 'CCB_AUTO_session_v1', CONFIG = 'CCB_AUTO_settings_v1', CACHE = 'CCB_AUTO_repo_v1';
    const repoUrl = 'https://raw.githubusercontent.com/Kanda-Akihito-Kun/ccb/main/data/cdn.json';
    const safeRead = (key, fallback) => { try { return JSON.parse(sessionStorage.getItem(key)) || fallback; } catch (_) { return fallback; } };
    const saveSession = () => { try { sessionStorage.setItem(SKEY, JSON.stringify(session)); } catch (_) {} };
    const session = Object.assign({views: 0, lastCheckViews: 0, lastCheckAt: 0}, safeRead(SKEY, {}));
    let config = C.settings(env.getValue(CONFIG, {})), state = null, rawPlay = null, running = null;
    let pool = C.nodes(env.snapshot), poolSource = '仓库内置快照', poolAt = env.snapshotAt;
    let hostElement, shadow, badge, panel, message = '等待视频加载', lastTick = performance.now(), wasHidden = document.hidden;
    let open = false, positionQueued = false, lastRepoFetch = 0;
    const endpoint = (path, params) => 'https://api.bilibili.com' + path + '?' + new URLSearchParams(params);
    const abortError = () => new DOMException('已取消测速', 'AbortError');
    const videoElement = () => document.querySelector('.bpx-player-video-wrap video, .bilibili-player-video video')
        || Array.from(document.querySelectorAll('video')).find(v => v.offsetWidth > 0) || document.querySelector('video');
    const currentKey = () => { const id = C.identity(location.href); return id ? id.bvid + ':' + id.page : ''; };
    const current = s => state === s && currentKey() === s.key;
    const number = (value, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : '—';
    const shortHost = value => (value || '默认调度').replace(/\.bilivideo\.(?:com|cn)$/, '').replace(/\.akamaized\.net$/, '');
    const stallWatcher = createCcbStallWatcher({
        enabled: () => config.enabled && config.stallDetection,
        active: key => !!state && current(state) && key === state.key && !document.hidden,
        busy: () => !!running || !!state?.proposal || Date.now() < (state?.nextTry || 0),
        lastRunAt: () => Math.max(session.lastStallAt || 0, session.lastScanAt || 0),
        onStall: () => {
            session.lastStallAt = Date.now(); saveSession();
            message = '检测到卡顿，正在测速'; render(); run(false, 'stall');
        },
    });
    function syncContext() {
        const id = C.identity(location.href), key = id ? id.bvid + ':' + id.page : '';
        if (key === (state && state.key)) return;
        stallWatcher.dispose();
        if (running) running.abort();
        if (state && state.metaAbort) state.metaAbort.abort();
        state = id ? {key, ...id, watched: 0, counted: false, createdAt: Date.now(), live: null,
            probe: null, proposal: null, results: [], meta: null, pendingMetrics: [], preparing: false, retryAfter: 0} : null;
        rawPlay = null; open = false; message = '等待视频加载';
        render();
    }
    // Both transports were saved before the CDN and telemetry hooks. Fetch's
    // cache mode avoids the extra Pragma preflight rejected by some CDN nodes.
    async function requestMedia(url, bytes, signal, timeout) {
        if (signal && signal.aborted) throw abortError();
        const controller = new AbortController(), cancel = () => controller.abort();
        let timedOut = false, reader;
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
        if (signal) signal.addEventListener('abort', cancel, {once: true});
        const start = performance.now();
        try {
            const response = await env.rawFetch(url, {headers: {Range: 'bytes=0-' + (bytes - 1)},
                cache: 'no-store', credentials: 'omit', signal: controller.signal});
            if (response.status !== 206) throw new Error(`HTTP ${response.status}，节点未提供分段`);
            if (new URL(response.url).hostname !== new URL(url).hostname) throw new Error('响应跳转到了其他节点');
            const range = response.headers.get('Content-Range'), match = /^bytes 0-(\d+)\/(\d+)$/.exec(range || '');
            if (!match || Number(match[1]) + 1 !== bytes || Number(match[2]) < bytes) throw new Error('分段长度校验失败');
            const length = Number(response.headers.get('Content-Length'));
            if (length && length !== bytes) throw new Error('响应超过或不足样本长度');
            if (!response.body) throw new Error('浏览器未提供可读取的分段');
            reader = response.body.getReader();
            let total = 0, sample = new Uint8Array(0);
            for (;;) {
                const part = await reader.read(); if (part.done) break;
                total += part.value.byteLength;
                if (total > bytes) throw new Error('响应超过样本上限，已中止');
                if (sample.length < 80) {
                    const next = new Uint8Array(Math.min(80, sample.length + part.value.byteLength));
                    next.set(sample); next.set(part.value.subarray(0, next.length - sample.length), sample.length); sample = next;
                }
            }
            C.validateRange({status: response.status, range, size: total, expected: bytes,
                type: response.headers.get('Content-Type'), sample: new TextDecoder().decode(sample),
                finalUrl: response.url, expectedHost: new URL(url).hostname});
            return {duration: performance.now() - start, bytes: total};
        } catch (error) {
            if (signal && signal.aborted) throw abortError();
            if (timedOut) throw new Error('请求超时');
            if (error instanceof TypeError) throw new Error('网络或 CORS 错误');
            throw error;
        } finally {
            clearTimeout(timer); controller.abort();
            if (signal) signal.removeEventListener('abort', cancel);
            if (reader) try { reader.releaseLock(); } catch (_) {}
        }
    }
    function request(url, {bytes, signal, timeout = 6000, json = false} = {}) {
        if (bytes) return requestMedia(url, bytes, signal, timeout);
        return new Promise((resolve, reject) => {
            if (signal && signal.aborted) return reject(abortError());
            const xhr = new env.RawXHR();
            let settled = false;
            const finish = (error, value) => {
                if (settled) return; settled = true;
                if (signal) signal.removeEventListener('abort', cancel);
                error ? reject(error) : resolve(value);
            };
            const cancel = () => { xhr.abort(); finish(abortError()); };
            xhr.open('GET', url, true); xhr.timeout = timeout;
            xhr.withCredentials = true; xhr.responseType = 'text';
            xhr.onprogress = event => {
                if (event.loaded > 4 * 1024 * 1024) {
                    finish(new Error('响应超过样本上限，已中止')); xhr.abort();
                }
            };
            xhr.onerror = () => finish(new Error('网络或 CORS 错误'));
            xhr.ontimeout = () => finish(new Error('请求超时'));
            xhr.onabort = () => finish(signal && signal.aborted ? abortError() : new Error('请求已中止'));
            xhr.onload = () => {
                try {
                    if (xhr.status !== 200) throw new Error('元数据 HTTP ' + xhr.status);
                    finish(null, JSON.parse(xhr.responseText));
                } catch (error) { finish(error); }
            };
            if (signal) signal.addEventListener('abort', cancel, {once: true});
            xhr.send();
        });
    }
    function observePlayInfo(object, requestUrl) {
        syncContext(); if (!state || !object || (object.code !== undefined && object.code !== 0)) return;
        const data = object.data || object.result || object;
        if (!data.dash && !data.durl) return;
        let cid = null;
        try {
            if (requestUrl) {
                const u = new URL(requestUrl, location.href);
                if (u.searchParams.get('bvid') && u.searchParams.get('bvid') !== state.bvid) return;
                cid = Number(u.searchParams.get('cid')) || null;
            }
            rawPlay = {key: state.key, cid, data: JSON.parse(JSON.stringify(data))};
        } catch (_) {}
    }
    async function prepare(s) {
        if (!s || s.meta || Date.now() < s.retryAfter) return;
        if (s.preparing) { await s.metaTask; return; }
        s.preparing = true;
        let metadataDone;
        s.metaTask = new Promise(resolve => { metadataDone = resolve; });
        const controller = new AbortController(); s.metaAbort = controller;
        try {
            const pages = await request(endpoint('/x/player/pagelist', {bvid: s.bvid}), {json: true, signal: controller.signal});
            if (pages.code !== 0 || !Array.isArray(pages.data)) throw new Error('无法获取当前分 P');
            const part = pages.data.find(p => p.page === s.page);
            if (!part || !Number.isSafeInteger(Number(part.cid)) || Number(part.cid) <= 0) throw new Error('当前分 P 不存在');
            if (!current(s)) return;
            let data;
            if (rawPlay && rawPlay.key === s.key && (!rawPlay.cid || rawPlay.cid === Number(part.cid))) data = rawPlay.data;
            if (!data) {
                const response = await request(endpoint('/x/player/playurl', {bvid: s.bvid, cid: part.cid,
                    fnver: 0, fnval: 1616, fourk: 1, otype: 'json'}), {json: true, signal: controller.signal});
                if (response.code !== 0 || !response.data) throw new Error('播放地址接口：' + (response.message || response.code));
                data = response.data;
            }
            if (!current(s)) return;
            const videos = data.dash && data.dash.video || [];
            const audios = data.dash && data.dash.audio || [];
            const urls = videos.map(t => t.baseUrl || t.base_url).filter(Boolean);
            if (!urls.length && data.durl && data.durl[0]) urls.push(data.durl[0].url);
            if (!urls.length) throw new Error('当前视频没有可测的媒体地址');
            s.meta = {data, cid: Number(part.cid), urls, audio: audios.map(t => t.baseUrl || t.base_url).filter(Boolean),
                paths: new Set(urls.map(u => new URL(u, location.href).pathname)), fetchedAt: Date.now()};
            const pending = s.pendingMetrics.splice(0); pending.forEach(ingestMetric);
            restorePosition(s); message = '已就绪'; render();
        } catch (error) {
            if (current(s) && error.name !== 'AbortError') { message = error.message; s.retryAfter = Date.now() + 60000; render(); }
        } finally { s.preparing = false; metadataDone(); }
    }
    function ingestMetric(metric) {
        if (!state || !metric || metric.at < state.createdAt - 500 || metric.at > Date.now() + 1000) return;
        if (!state.meta) { state.pendingMetrics.push(metric); if (state.pendingMetrics.length > 30) state.pendingMetrics.shift(); return; }
        try {
            const url = new URL(metric.url);
            if (!state.meta.paths.has(url.pathname) || !C.host(url.origin)) return;
            if (!(metric.bytes > 0 && metric.duration >= 2 && metric.status >= 200 && metric.status < 300)) return;
            state.live = {mbps: metric.bytes * 8 / (metric.duration / 1000) / 1e6,
                pingMs: metric.ping, host: url.hostname, at: metric.at};
        } catch (_) {}
    }
    function loadNodes(signal) {
        if (Date.now() - lastRepoFetch < 3600000) return Promise.resolve(pool);
        lastRepoFetch = Date.now();
        return new Promise(resolve => {
            let done = false, handle;
            const finish = () => { if (!done) { done = true; clearTimeout(timer); if (signal) signal.removeEventListener('abort', cancel); resolve(pool); } };
            const cancel = () => { if (handle) handle.abort(); finish(); };
            const timer = setTimeout(cancel, 8500);
            try {
                const cached = env.getValue(CACHE, null);
                if (cached && cached.url === repoUrl && C.nodes(cached.data).length && cached.at > Date.now() - 7 * 86400000) {
                    pool = C.nodes(cached.data); poolSource = '仓库缓存'; poolAt = new Date(cached.at).toISOString();
                }
                handle = env.gmRequest({method: 'GET', url: repoUrl, timeout: 8000,
                    onload: response => {
                        try {
                            if (response.status !== 200) throw new Error();
                            const data = JSON.parse(response.responseText), next = C.nodes(data);
                            if (!next.length) throw new Error();
                            pool = next; poolSource = 'GitHub 仓库'; poolAt = new Date().toISOString();
                            env.setValue(CACHE, {url: repoUrl, data, at: Date.now()});
                        } catch (_) {} finish();
                    }, onerror: finish, ontimeout: finish});
                if (signal) signal.addEventListener('abort', cancel, {once: true});
            } catch (_) { finish(); }
        });
    }
    async function probe(url, host, bytes, signal) {
        const u = new URL(url, location.href); if (host) u.hostname = host;
        const result = {host: u.hostname, pingMs: null, mbps: null, bytes: 0, at: Date.now()};
        const pings = [];
        try {
            for (let i = 0; i < 3; i++) {
                const ping = await request(u.href, {bytes: 1, signal}); pings.push(ping.duration);
            }
            result.pingMs = C.median(pings);
            const download = await request(u.href, {bytes, signal});
            if (download.duration < 2) throw new Error('样本计时过短，不能作为优选依据');
            result.bytes = download.bytes; result.mbps = download.bytes * 8 / (download.duration / 1000) / 1e6;
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            result.pingMs = C.median(pings); result.error = error.message;
        }
        return result;
    }
    function activeHost(s) {
        const configured = C.host(env.getNode());
        return configured || (s.live && s.live.host) || new URL(s.meta.urls[0], location.href).hostname;
    }
    async function check(s, signal, fullScan = false) {
        if (!current(s) || !s.meta) return;
        if (Date.now() - s.meta.fetchedAt > 20 * 60000) {
            s.meta = null; await prepare(s); if (!s.meta || !current(s)) return;
        }
        const hosts = await loadNodes(signal);
        if (signal.aborted || !current(s)) throw abortError();
        const host = activeHost(s), url = s.meta.urls[0], required = C.threshold(s.meta.data, config.minMbps);
        message = '轻量检查当前节点…'; render();
        let observed = await probe(url, host, 512 * 1024, signal);
        if (!current(s)) return;
        s.probe = observed; s.required = required; render();
        let currentHealthy = C.healthy(observed, config, required) && hosts.some(n => n.host === host);
        if (currentHealthy && !fullScan) { message = '节点正常'; return; }
        // Confirm a poor short sample with a longer one before scanning/suggesting.
        if (!currentHealthy) {
            message = '复测当前节点…'; render();
            observed = await probe(url, host, 2 * 1024 * 1024, signal);
            if (!current(s)) return;
            s.probe = observed;
        }
        const inPool = hosts.some(n => n.host === host);
        currentHealthy = C.healthy(observed, config, required) && inPool;
        if (currentHealthy && !fullScan) { message = '复测达标 · 保持当前节点'; return; }
        if (!currentHealthy) s.problem = inPool ? C.reasons(observed, config, required) : ['当前源不在仓库香港／海外候选池', ...C.reasons(observed, config, required)];
        const candidates = [];
        // Serial requests only. A failed or slow sample has a six-second bound.
        for (let i = 0; i < hosts.length; i++) {
            if (signal.aborted || !current(s)) throw abortError();
            if (hosts[i].host === host) continue;
            if (document.hidden) throw abortError();
            message = `筛选香港／海外 ${i + 1}/${hosts.length}`; render();
            const result = await probe(url, hosts[i].host, 256 * 1024, signal);
            candidates.push({...result, region: hosts[i].region}); s.results = candidates.slice();
        }
        const shortlist = candidates.filter(r => !r.error && Number.isFinite(r.mbps) && r.pingMs <= config.maxPingMs)
            .sort((a, b) => b.mbps - a.mbps || a.pingMs - b.pingMs);
        const finalists = [];
        for (const candidate of shortlist) {
            if (signal.aborted || !current(s)) throw abortError();
            message = '验证 ' + shortHost(candidate.host); render();
            const verified = {...await probe(url, candidate.host, 2 * 1024 * 1024, signal), region: candidate.region};
            if (C.healthy(verified, config, required)) {
                try {
                    // Test every returned normal audio track before recommending the video node.
                    for (const audio of s.meta.audio) {
                        const u = new URL(audio, location.href); u.hostname = candidate.host;
                        await request(u.href, {bytes: 1024, signal});
                    }
                    finalists.push(verified);
                } catch (error) { if (error.name === 'AbortError') throw error; verified.error = '音频校验失败：' + error.message; }
            }
            s.results = [verified, ...s.results.filter(r => r.host !== verified.host)];
            if (finalists.length >= 3) break;
        }
        if (!current(s)) return;
        finalists.sort((a, b) => b.mbps - a.mbps || a.pingMs - b.pingMs);
        if (!finalists.length) { message = '暂未找到达到阈值的香港／海外节点'; open = true; return; }
        s.proposal = {candidates: finalists, selectedHost: finalists[0].host, old: observed, at: Date.now(), required, key: s.key};
        message = '请选择节点'; open = true;
    }
    async function run(manual = false, reason = 'periodic') {
        syncContext(); const s = state;
        if (running || !s || document.hidden) return;
        if (!manual && !config.enabled) return;
        const controller = new AbortController(); running = controller;
        s.proposal = null; s.results = []; s.problem = null;
        try {
            await prepare(s);
            if (!current(s) || !s.meta || controller.signal.aborted) return;
            const task = async () => {
                if (controller.signal.aborted) return;
                if (manual || reason === 'stall') { session.lastScanAt = Date.now(); saveSession(); }
                await check(s, controller.signal, manual || reason === 'stall');
            };
            let executed = false;
            if (navigator.locks) {
                await navigator.locks.request('ccb-auto-probe-v1', {ifAvailable: true}, async lock => {
                    if (lock) { executed = true; await task(); }
                    else { message = '另一标签页正在测速，本次延后'; s.nextTry = Date.now() + 30000; }
                });
            } else { executed = true; await task(); }
            if (executed && current(s) && !controller.signal.aborted) {
                session.lastCheckAt = Date.now(); session.lastCheckViews = session.views; saveSession();
            }
        } catch (error) { if (current(s)) message = error.name === 'AbortError' ? '测速已取消' : '测速失败：' + error.message; }
        finally { if (running === controller) running = null; render(); }
    }
    function approve() {
        const s = state, p = s && s.proposal;
        if (!p || !current(s) || p.key !== s.key) return;
        if (Date.now() - p.at > 120000) { s.proposal = null; message = '结果已过期，请重新测速'; render(); return; }
        const candidate = p.candidates.find(node => node.host === p.selectedHost);
        if (!candidate || !pool.some(n => n.host === candidate.host) || !C.healthy(candidate, config, p.required)) return;
        const video = videoElement();
        // This is the only automatic-node write, and only a user click reaches it.
        const active = {host: candidate.host, region: candidate.region, at: Date.now()};
        const restore = {bvid: s.bvid, cid: s.meta.cid, time: video && video.currentTime || 0,
            paused: !video || video.paused, at: Date.now()};
        try {
            sessionStorage.setItem('CCB_AUTO_active_v1', JSON.stringify(active));
            sessionStorage.setItem('CCB_AUTO_restore_v1', JSON.stringify(restore));
            // Verify persistence before refreshing; otherwise the new node would be lost.
            if (JSON.parse(sessionStorage.getItem('CCB_AUTO_active_v1')).host !== active.host) throw new Error();
            location.reload();
        } catch (_) { message = '无法保存节点，本次未刷新'; render(); }
    }
    function restorePosition(s) {
        const restore = safeRead('CCB_AUTO_restore_v1', null);
        if (!restore || restore.bvid !== s.bvid || restore.cid !== s.meta.cid || Date.now() - restore.at > 120000) return;
        const video = videoElement(); if (!video) return;
        const apply = () => {
            if (!current(s)) return;
            try {
                if (restore.time > 0 && Number.isFinite(video.duration)) video.currentTime = Math.min(restore.time, Math.max(0, video.duration - 1));
                sessionStorage.removeItem('CCB_AUTO_restore_v1');
                if (restore.paused) video.pause(); else { const playing = video.play(); if (playing) playing.catch(() => {}); }
            } catch (_) {}
        };
        if (video.readyState >= 1) apply(); else video.addEventListener('loadedmetadata', apply, {once: true});
    }
    function element(tag, text, className) {
        const node = document.createElement(tag); if (text !== undefined) node.textContent = text;
        if (className) node.className = className; return node;
    }
    function button(text, action, className = '') {
        const b = element('button', text, className); b.type = 'button'; b.addEventListener('click', action); return b;
    }
    function row(parent, label, value) {
        const r = element('div', undefined, 'row'); r.append(element('span', label, 'muted'), element('span', value, 'value')); parent.append(r);
    }
    function mount() {
        if (hostElement || !document.documentElement) return;
        hostElement = element('div'); hostElement.id = 'ccb-auto-widget';
        shadow = hostElement.attachShadow({mode: 'open'});
        const style = element('style'); style.textContent = env.css;
        badge = button('', () => { open = !open; render(); }, 'badge');
        badge.setAttribute('aria-label', 'CCB 视频网络状态与设置'); badge.setAttribute('aria-expanded', 'false');
        panel = element('section', undefined, 'panel'); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'CCB 网络状态');
        shadow.append(style, badge, panel); document.documentElement.append(hostElement);
        document.addEventListener('pointerdown', e => { if (!e.composedPath().includes(hostElement) && open) { open = false; render(); } });
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && open) { open = false; render(); badge.focus(); } });
    }
    function position() {
        positionQueued = false;
        if (!hostElement || !state) { if (hostElement) hostElement.hidden = true; return; }
        const title = document.querySelector('h1.video-title, .video-info-title h1, h1[title], .video-title h1');
        if (document.fullscreenElement || document.querySelector('.bpx-state-web') || document.hidden) { hostElement.hidden = true; return; }
        let left = innerWidth - 210, top = 14;
        if (title) {
            const box = title.getBoundingClientRect();
            if (box.bottom < 0 || box.top > innerHeight || !box.width) { hostElement.hidden = true; return; }
            const range = document.createRange(); range.selectNodeContents(title);
            const text = range.getBoundingClientRect();
            left = Math.min(text.right, box.right) + 12; top = box.top + Math.max(0, (box.height - 26) / 2);
            const boundary = Math.min(innerWidth - 12, title.closest('.video-info-container, .video-info')?.getBoundingClientRect().right || innerWidth - 12);
            if (left + 196 > boundary) { left = Math.max(box.left, boundary - 196); top = box.bottom + 5; }
            hostElement.dataset.theme = (() => { const m = getComputedStyle(title).color.match(/[\d.]+/g); return m && Number(m[0]) > 150 ? 'dark' : 'light'; })();
        }
        hostElement.hidden = false;
        badge.style.left = Math.max(8, Math.min(left, innerWidth - 204)) + 'px'; badge.style.top = Math.max(6, top) + 'px';
        panel.style.left = Math.max(8, Math.min(left, innerWidth - 368)) + 'px';
        panel.style.top = Math.min(top + 34, Math.max(8, innerHeight - Math.min(panel.scrollHeight || 380, innerHeight - 32))) + 'px';
    }
    function schedulePosition() { if (!positionQueued) { positionQueued = true; requestAnimationFrame(position); } }
    function render() {
        mount(); if (!badge) return;
        if (!state) { hostElement.hidden = true; return; }
        const s = state, fresh = s.live && Date.now() - s.live.at < 12000;
        const sample = fresh ? s.live : s.probe;
        badge.replaceChildren(element('i', undefined, running ? 'dot working' : s.proposal ? 'dot warning' : 'dot'),
            element('span', (fresh ? '↓ ' : '测 ') + number(sample && sample.mbps) + ' Mbps'),
            element('span', number(sample && sample.pingMs, 0) + ' ms', 'ping'));
        badge.title = (fresh ? '当前视频分段加载速度（含缓存影响）' : '上次主动测速 ' + (s.probe ? new Date(s.probe.at).toLocaleTimeString() : '尚无结果') + '；点击查看详情') + '\nHTTP 延迟，非 ICMP ping\n' + message;
        badge.setAttribute('aria-expanded', String(open)); panel.hidden = !open;
        if (open && !shadow.activeElement?.matches('input') && !panel.querySelector('details[open]')) renderPanel(s, fresh);
        schedulePosition();
    }
    function renderPanel(s, fresh) {
        panel.replaceChildren();
        const header = element('div', undefined, 'header');
        header.append(element('strong', 'CCB · 网络'), button('×', () => { open = false; render(); }, 'close'));
        panel.append(header);
        const info = element('div', undefined, 'content'); panel.append(info);
        const currentNode = s.meta ? activeHost(s) : C.host(env.getNode());
        row(info, '当前节点', shortHost(currentNode));
        const sample = fresh ? s.live : s.probe, metrics = element('div', undefined, 'metrics');
        for (const [label, value, unit] of [[fresh ? '加载速度' : '测速速度', sample?.mbps, 'Mbps'], ['HTTP 延迟', sample?.pingMs, 'ms']]) {
            const tile = element('div', undefined, 'metric');
            tile.append(element('span', label, 'muted'), element('strong', number(value, unit === 'ms' ? 0 : 1)), element('small', unit));
            metrics.append(tile);
        }
        metrics.title = fresh ? '当前视频分段观测值' : s.probe ? '上次测速 ' + new Date(s.probe.at).toLocaleTimeString() : '等待有效样本';
        info.append(metrics);
        info.append(element('p', message, 'status'));
        if (s.problem) {
            const problem = element('p', '当前节点异常', 'reason'); problem.title = s.problem.join('；'); info.append(problem);
        }
        if (s.proposal) {
            const p = s.proposal, card = element('div', undefined, 'proposal');
            card.append(element('span', '可用节点', 'eyebrow'));
            const choices = element('div', undefined, 'node-choices');
            choices.setAttribute('role', 'radiogroup'); choices.setAttribute('aria-label', '选择切换节点');
            p.candidates.forEach((candidate, index) => {
                const label = element('label', undefined, 'node-option'); label.title = candidate.host;
                const radio = element('input'); radio.type = 'radio'; radio.name = 'ccb-auto-candidate';
                radio.value = candidate.host; radio.checked = p.selectedHost === candidate.host;
                radio.setAttribute('aria-label', `第 ${index + 1} 名 ${candidate.host}，${candidate.region}`);
                radio.addEventListener('change', () => { if (radio.checked && s.proposal === p) p.selectedHost = candidate.host; });
                const details = element('span', undefined, 'node-details');
                details.append(element('strong', shortHost(candidate.host)),
                    element('span', `${candidate.region} · ${number(candidate.mbps)} Mbps · ${number(candidate.pingMs, 0)} ms`, 'node-metrics'));
                label.append(radio, element('span', String(index + 1), 'node-rank'), details); choices.append(label);
            });
            card.append(choices);
            const actions = element('div', undefined, 'actions');
            actions.append(button('切换并刷新', approve, 'primary'), button('稍后', () => { open = false; render(); }),
                button('保持当前', () => { s.proposal = null; open = false; message = '已保留当前节点'; render(); }));
            card.append(actions); info.append(card);
        }
        const actions = element('div', undefined, 'actions');
        actions.append(button(running ? '取消测速' : '立即测速', () => { if (running) running.abort(); else run(true); }));
        info.append(actions);
        const details = element('details'), summary = element('summary', '设置'); details.append(summary);
        const form = element('form'), enableLabel = element('label', '自动检查');
        const enable = element('input'); enable.type = 'checkbox'; enable.checked = config.enabled; enableLabel.append(enable); form.append(enableLabel);
        const stallLabel = element('label', '卡顿时测速'), stallEnable = element('input');
        stallEnable.type = 'checkbox'; stallEnable.checked = config.stallDetection;
        stallLabel.title = '连续缓冲约 2.5 秒后测速'; stallLabel.append(stallEnable); form.append(stallLabel);
        const inputs = {};
        for (const [key, title, min, max, step] of [['everyVideos', '每几个视频检查', 1, 30, 1],
            ['maxPingMs', '最大 HTTP 延迟 ms', 50, 3000, 10], ['minMbps', '4K 目标 Mbps', 5, 200, 1]]) {
            const label = element('label', title), input = element('input');
            input.type = 'number'; input.min = min; input.max = max; input.step = step; input.value = config[key];
            inputs[key] = input; label.append(input); form.append(label);
        }
        form.append(button('保存设置', () => {
            if (!form.reportValidity()) return;
            config = C.settings({...config, enabled: enable.checked, stallDetection: stallEnable.checked,
                ...Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.value]))});
            env.setValue(CONFIG, config);
            if (running) running.abort();
            stallWatcher.reset();
            s.proposal = null; s.problem = null;
            s.required = s.meta ? C.threshold(s.meta.data, config.minMbps) : config.minMbps;
            message = '设置已保存'; renderPanel(s, fresh); schedulePosition();
        }));
        form.addEventListener('submit', e => e.preventDefault()); details.append(form); info.append(details);
        const links = element('div', undefined, 'settings-links');
        const source = element('a', `香港 / 海外 · ${pool.length} 节点`);
        source.href = repoUrl; source.target = '_blank'; source.rel = 'noopener noreferrer';
        source.title = poolSource + ' · ' + new Date(poolAt).toLocaleDateString(); links.append(source);
        if (s.meta) {
            const a = element('a', '诊断 ↗');
            a.href = 'https://www.bilibili.com/blackboard/video-diagnostics.html?' + new URLSearchParams({bvid: s.bvid, cid: s.meta.cid});
            a.target = '_blank'; a.rel = 'noopener noreferrer'; links.append(a);
        }
        details.append(links);
    }
    function tick() {
        syncContext(); const s = state, now = performance.now(), elapsed = Math.min(2, Math.max(0, (now - lastTick) / 1000)); lastTick = now;
        if (!s) return;
        const video = videoElement();
        stallWatcher.update(video, s.key);
        if (video && !document.hidden) prepare(s);
        if (video && !video.paused && !video.seeking && video.readyState >= 2 && !document.hidden && !wasHidden) {
            s.watched += elapsed;
            if (!s.counted && s.watched >= config.watchedSeconds) {
                s.counted = true;
                if (session.lastCountedBvid !== s.bvid) { session.views++; session.lastCountedBvid = s.bvid; saveSession(); }
            }
            if (s.counted && s.meta && !running && !s.proposal && Date.now() >= (s.nextTry || 0) && C.due(session, config, Date.now())) {
                const ahead = video.buffered.length ? video.buffered.end(video.buffered.length - 1) - video.currentTime : 0;
                if (ahead >= 5) run();
            }
        }
        wasHidden = document.hidden; render();
    }
    document.addEventListener('visibilitychange', () => { if (document.hidden && running) running.abort(); stallWatcher.reset(); lastTick = performance.now(); wasHidden = document.hidden; render(); });
    window.addEventListener('resize', schedulePosition); window.addEventListener('scroll', schedulePosition, {passive: true});
    document.addEventListener('fullscreenchange', schedulePosition);
    window.addEventListener('pagehide', () => { stallWatcher.dispose(); if (running) running.abort(); if (state && state.metaAbort) state.metaAbort.abort(); });
    syncContext(); setInterval(tick, 1000);
    env.registerMenu('🌐 CCB 自动优选与网络状态', () => { open = true; render(); });
    return {observePlayInfo, ingestMetric,
        isVideoContext: () => !!C.identity(location.href),
        clearOverride: () => { try { sessionStorage.removeItem('CCB_AUTO_active_v1'); } catch (_) {} },
        // Used only by the local fixture tests through the returned lexical controller.
        inspect: () => ({state, session, config, pool, message, running: !!running}), run};
}
