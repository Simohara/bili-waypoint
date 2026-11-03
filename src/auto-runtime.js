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
        // Without metadata nothing can be probed, so the stall window keeps waiting instead of being used up.
        busy: () => !!running || !state?.meta || !!state.proposal || performance.now() < (state.nextTry || 0)
            || C.since(session.missAt, Date.now()) < 10 * 60000,
        lastRunAt: () => Math.max(0, ...[session.lastStallAt, session.lastScanAt].filter(at => at <= Date.now())),
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
            // Throughput excludes the wait for headers; latency keeps the full request time.
            const headersAt = performance.now();
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
            const end = performance.now();
            return {duration: end - start, transfer: end - headersAt, bytes: total, size: Number(match[2])};
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
        if (!s || s.meta || performance.now() < s.retryAfter) return;
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
            const sources = t => [t.baseUrl || t.base_url || t.url, ...(t.backupUrl || t.backup_url || [])].filter(Boolean);
            const tracks = (videos.length ? videos : (data.durl || []).slice(0, 1)).map(sources).filter(list => list.length);
            if (!tracks.length) throw new Error('当前视频没有可测的媒体地址');
            s.meta = {data, cid: Number(part.cid), urls: tracks.flat(), audio: audios.map(sources).filter(list => list.length),
                paths: new Set(tracks.flat().map(u => new URL(u, location.href).pathname)), fetchedAt: Date.now()};
            const pending = s.pendingMetrics.splice(0); pending.forEach(ingestMetric);
            restorePosition(s); message = '已就绪'; render();
        } catch (error) {
            if (current(s) && error.name !== 'AbortError') { message = error.message; s.retryAfter = performance.now() + 60000; render(); }
        } finally { s.preparing = false; metadataDone(); }
    }
    function ingestMetric(metric) {
        if (!state || !metric || metric.at < state.createdAt - 500 || metric.at > Date.now() + 1000) return;
        if (!state.meta) { state.pendingMetrics.push(metric); if (state.pendingMetrics.length > 30) state.pendingMetrics.shift(); return; }
        try {
            const url = new URL(metric.url);
            if (!state.meta.paths.has(url.pathname) || !C.host(url.hostname)) return;
            state.mediaAt = metric.at; state.seenHost = url.hostname;
            const transfer = metric.duration - (Number.isFinite(metric.ping) ? metric.ping : 0);
            if (!(metric.bytes > 0 && transfer >= 0 && metric.status >= 200 && metric.status < 300)) return;
            // Auto quality fetches 40–200 KiB segments: pool finished ones from the last 3 s on this host; a lone few-KB index request stays below the bar.
            let bytes = metric.bytes, time = transfer;
            if (metric.final) {
                state.recent = (state.recent || []).filter(r => r.host === url.hostname && metric.at - r.at < 3000);
                state.recent.push({host: url.hostname, at: metric.at, bytes, time});
                bytes = state.recent.reduce((sum, r) => sum + r.bytes, 0); time = state.recent.reduce((sum, r) => sum + r.time, 0);
            }
            if (bytes < 256 * 1024 || time < 2) return;
            state.live = {mbps: bytes * 8 / (time / 1000) / 1e6,
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
    // Use the player's own address for that host; otherwise move a port-free upos path onto it (mcdn uses :4483 and /v1/resource/).
    function target(urls, host) {
        const list = urls.map(value => new URL(value, location.href)), own = list.find(u => u.hostname === host);
        if (own) return own;
        const u = list.find(item => !item.port && item.pathname.startsWith('/upgcxcode/')) || list[0];
        u.hostname = host; u.port = ''; return u;
    }
    async function probe(urls, host, bytes, signal) {
        const u = target(urls, host);
        const result = {host: u.hostname, pingMs: null, mbps: null, bytes: 0, at: Date.now()};
        const pings = [];
        try {
            let size = bytes;
            for (let i = 0; i < 3; i++) {
                const ping = await request(u.href, {bytes: 1, signal}); pings.push(ping.duration); size = ping.size;
            }
            result.pingMs = C.median(pings);
            // A file shorter than the sample can only answer with its whole length.
            const download = await request(u.href, {bytes: Math.min(bytes, size), signal});
            const time = Math.max(download.transfer, download.duration - result.pingMs);
            if (time < 2) throw new Error('样本计时过短，不能作为优选依据');
            result.bytes = download.bytes; result.mbps = download.bytes * 8 / (time / 1000) / 1e6;
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            result.pingMs = C.median(pings); result.error = error.message;
        }
        return result;
    }
    function activeHost(s) {
        const configured = C.host(env.getNode());
        return configured || s.seenHost || new URL(s.meta.urls[0], location.href).hostname;
    }
    async function check(s, signal, fullScan = false) {
        if (!current(s) || !s.meta) return;
        if (C.since(s.meta.fetchedAt, Date.now()) > 20 * 60000) {
            // rawPlay holds the page-load signatures; a refresh must ask the API again.
            s.meta = null; rawPlay = null; await prepare(s); if (!s.meta || !current(s)) return;
        }
        const hosts = await loadNodes(signal);
        if (signal.aborted || !current(s)) throw abortError();
        const host = activeHost(s), urls = s.meta.urls, required = C.threshold(s.meta.data, config.minMbps);
        message = '轻量检查当前节点…'; render();
        let observed = await probe(urls, host, 1024 * 1024, signal);
        if (!current(s)) return;
        s.probe = observed; s.required = required; render();
        let currentHealthy = C.healthy(observed, config, required) && hosts.some(n => n.host === host);
        if (currentHealthy && !fullScan) { message = '节点正常'; return 'healthy'; }
        // Confirm a poor short sample with a longer one before scanning/suggesting.
        if (!currentHealthy) {
            message = '复测当前节点…'; render();
            observed = await probe(urls, host, 2 * 1024 * 1024, signal);
            if (!current(s)) return;
            s.probe = observed;
        }
        const inPool = hosts.some(n => n.host === host);
        currentHealthy = C.healthy(observed, config, required) && inPool;
        if (currentHealthy && !fullScan) { message = '复测达标 · 保持当前节点'; return 'healthy'; }
        if (!currentHealthy) s.problem = inPool ? C.reasons(observed, config, required) : ['当前源不在仓库香港／海外候选池', ...C.reasons(observed, config, required)];
        const candidates = [];
        // Serial requests only. A failed or slow sample has a six-second bound.
        for (let i = 0; i < hosts.length; i++) {
            if (signal.aborted || !current(s)) throw abortError();
            if (hosts[i].host === host) continue;
            if (document.hidden) throw abortError();
            message = `筛选香港／海外 ${i + 1}/${hosts.length}`; render();
            const result = await probe(urls, hosts[i].host, 256 * 1024, signal);
            candidates.push({...result, region: hosts[i].region}); s.results = candidates.slice();
        }
        // Short samples read low under TCP slow start, so the coarse top five are always verified; below them, half the target is the cut.
        const shortlist = candidates.filter(r => !r.error && Number.isFinite(r.mbps) && r.pingMs <= config.maxPingMs)
            .sort((a, b) => b.mbps - a.mbps || a.pingMs - b.pingMs).filter((r, i) => i < 5 || r.mbps >= required / 2);
        // A healthy current node is only worth leaving for one that meets the configured target (M6 lowers it for non-4K videos).
        const bar = C.healthy(observed, config, required) ? Math.max(required, config.minMbps) : required;
        const finalists = [];
        let tried = 0;
        for (const candidate of shortlist) {
            if (signal.aborted || !current(s)) throw abortError();
            message = '验证 ' + shortHost(candidate.host); render();
            const verified = {...await probe(urls, candidate.host, 2 * 1024 * 1024, signal), region: candidate.region};
            if (C.healthy(verified, config, bar)) {
                try {
                    // Test every returned normal audio track before recommending the video node.
                    for (const audio of s.meta.audio) {
                        await request(target(audio, candidate.host).href, {bytes: 1024, signal});
                    }
                    finalists.push(verified);
                } catch (error) { if (error.name === 'AbortError') throw error; verified.error = '音频校验失败：' + error.message; }
            }
            s.results = [verified, ...s.results.filter(r => r.host !== verified.host)];
            // Coarse samples rank roughly; verify at least five before keeping the best three.
            if (++tried >= 5 && finalists.length >= 3) break;
        }
        if (!current(s)) return;
        finalists.sort((a, b) => b.mbps - a.mbps || a.pingMs - b.pingMs).splice(3);
        if (!finalists.length) {
            // Name the causes, so 403 or CORS failures are not reported as "too slow".
            const causes = {};
            for (const r of s.results) {
                const cause = r.error ? r.error.split(/[，：]/)[0] : r.pingMs > config.maxPingMs ? '延迟过高' : '速度不足';
                causes[cause] = (causes[cause] || 0) + 1;
            }
            const summary = Object.entries(causes).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([cause, n]) => `${cause} ×${n}`).join('，');
            message = '暂未找到可用的香港／海外节点' + (summary ? '：' + summary : '');
            if (fullScan) open = true; // a periodic check stays quiet
            return 'none';
        }
        s.proposal = {candidates: finalists, selectedHost: finalists[0].host, old: observed, at: Date.now(), required, key: s.key};
        message = '请选择节点'; open = true; return 'proposal';
    }
    async function run(manual = false, reason = 'periodic') {
        syncContext(); const s = state;
        if (running || !s || document.hidden) return;
        if (!manual && !config.enabled) return;
        const controller = new AbortController(); running = controller;
        s.proposal = null; s.results = []; s.problem = null;
        const scan = manual || reason === 'stall';
        let executed = false;
        try {
            if (manual) s.retryAfter = 0; // a click retries failed metadata at once
            await prepare(s);
            if (!current(s) || !s.meta || controller.signal.aborted) return;
            const task = async () => {
                if (controller.signal.aborted) return;
                executed = true;
                if (scan) { session.lastScanAt = Date.now(); saveSession(); }
                const outcome = await check(s, controller.signal, scan);
                // Only a check that actually measured uses up the periodic quota.
                if (outcome && current(s) && !controller.signal.aborted) {
                    session.lastCheckAt = Date.now(); session.lastCheckViews = session.views;
                    session.missAt = outcome === 'none' ? Date.now() : 0;
                    saveSession();
                }
            };
            if (navigator.locks) {
                await navigator.locks.request('ccb-auto-probe-v1', {ifAvailable: true}, async lock => {
                    if (lock) await task();
                    else { message = scan ? '另一标签页正在测速，请稍后重试' : '另一标签页正在测速，本次延后'; s.nextTry = performance.now() + 30000; }
                });
            } else await task();
        } catch (error) { if (current(s)) message = error.name === 'AbortError' ? '测速已取消' : '测速失败：' + error.message; }
        finally {
            if (running === controller) running = null;
            // The stall cooldown counts from the end of a scan, not its start.
            if (executed && scan) { session.lastScanAt = Date.now(); saveSession(); }
            render();
        }
    }
    // A user's cancel or settings save holds off automatic checks for one cooldown.
    function cancel() {
        if (!running) return;
        if (state) state.nextTry = performance.now() + config.cooldownMinutes * 60000;
        running.abort();
    }
    function approve() {
        const s = state, p = s && s.proposal;
        if (!p || !current(s) || p.key !== s.key) return;
        if (C.since(p.at, Date.now()) > 120000) { s.proposal = null; message = '结果已过期，请重新测速'; render(); return; }
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
        if (!restore || restore.bvid !== s.bvid || restore.cid !== s.meta.cid || C.since(restore.at, Date.now()) > 120000) return;
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
    // 驿程 UI. The skeleton is built once; the route is rebuilt only when its structure changes,
    // everything else is rewritten as text, so focus and clicks survive the one-second tick.
    const SVG = 'http://www.w3.org/2000/svg';
    const FONTS = 'https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;700&family=ZCOOL+XiaoWei&display=swap';
    const CAP = '<svg viewBox="0 0 24 10" aria-hidden="true"><rect class="track" x="0" y="3.5" width="24" height="3"/><rect class="fill" x="0" y="3.5" width="24" height="3"/>'
        + '<rect class="start" x="0" y="1" width="8" height="8"/><rect class="end" x="16" y="1" width="8" height="8"/></svg><b class="num"></b><span></span><em></em>';
    const PANEL = '<header class="hd"><svg viewBox="0 0 384 112" preserveAspectRatio="xMinYMax slice" aria-hidden="true">'
        + '<path class="hill" d="M0 94 60 84 120 90 180 70 232 78 282 46 332 60 384 38V112H0Z" fill="#fff" fill-opacity=".06"/>'
        + '<path class="hill" d="M0 102 70 94 140 100 200 84 262 94 322 72 384 82V112H0Z" fill="#fff" fill-opacity=".1"/>'
        + '<path class="hill" d="M0 107 80 100 160 107 240 100 320 107 384 102V112H0Z" fill="#000" fill-opacity=".22"/>'
        + '<path class="road" d="M384 54C352 58 330 46 300 62S240 92 190 90 110 86 76 98 36 107 27.5 112"/><g></g><rect class="horse" width="9" height="9"/></svg>'
        + '<div class="brand"><strong>驿程</strong><span></span></div><button type="button" class="x" aria-label="收起">×</button></header>'
        + '<div class="route"></div><button type="button" class="go"><span></span></button>'
        + '<div class="ft"><button type="button">保持当前</button><button type="button"></button><button type="button" class="cfg" aria-expanded="false">设置</button></div>'
        + '<form class="set" hidden><label>自动检查<input type="checkbox" name="enabled"></label>'
        + '<label title="连续缓冲约 2.5 秒后测速">卡顿时测速<small hidden>随自动检查关闭</small><input type="checkbox" name="stallDetection"></label>'
        + '<label>每几个视频检查<input type="number" name="everyVideos" min="1" max="30" step="1" required></label>'
        + '<label>最大 HTTP 延迟 ms<input type="number" name="maxPingMs" min="50" max="3000" step="10" required></label>'
        + '<label title="有 4K 轨道时按 4K 码率提高；没有时取最高轨道码率 × 1.3，不超过此值">目标 Mbps<input type="number" name="minMbps" min="5" max="200" step="1" required></label>'
        + '<div class="links"><a target="_blank" rel="noopener noreferrer"></a><a target="_blank" rel="noopener noreferrer">诊断 ↗</a><button type="submit">保存设置</button></div></form>';
    let ui = null, settingsOpen = false;
    // No motion while the host is display:none: GSAP cannot measure the SVG there and falls back to the document.
    const G = () => typeof gsap === 'undefined' || !hostElement || hostElement.hidden ? null : gsap;
    const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
    const mid = node => node.offsetTop + node.offsetHeight / 2;
    const station = host => shortHost(host).replace(/^(?:cn-|upos-[a-z0-9]+-)/, '');
    const nodeHost = s => s.meta ? activeHost(s) : C.host(env.getNode());
    const times = (candidate, old) => {
        const x = old && old.mbps > 0 ? candidate.mbps / old.mbps : NaN;
        return Number.isFinite(x) ? '当前 ' + (x >= 10 ? Math.round(x) : x.toFixed(1)) + ' 倍' : '';
    };
    function element(tag, text, className) {
        const node = document.createElement(tag); if (text !== undefined) node.textContent = text;
        if (className) node.className = className; return node;
    }
    function button(text, action, className = '') {
        const b = element('button', text, className); b.type = 'button'; b.addEventListener('click', action); return b;
    }
    function row(kind, name, chip, info, value, unit, gain) {
        const r = element(kind === 'cur' ? 'div' : 'label', undefined, 'stop ' + kind), txt = element('div', undefined, 'txt');
        const meta = element('span', undefined, 'meta'), fig = element('div', undefined, 'fig'), num = element('b', value, 'num');
        meta.append(element('em', chip, 'chip'), element('span', info, 'info')); txt.append(element('strong', name), meta);
        if (unit) num.append(element('small', unit));
        fig.append(num); if (gain) fig.append(element('span', gain, 'gain'));
        r.append(element('i', undefined, 'dot'), txt, fig); return r;
    }
    function mount() {
        if (hostElement || !document.documentElement) return;
        hostElement = element('div'); hostElement.id = 'ccb-auto-widget';
        shadow = hostElement.attachShadow({mode: 'open'});
        const style = element('style'); style.textContent = env.css;
        badge = button('', () => { open = !open; render(); }, 'cap'); badge.innerHTML = CAP;
        badge.setAttribute('aria-label', '驿程：视频网络状态与设置'); badge.setAttribute('aria-expanded', 'false');
        panel = element('section', undefined, 'panel'); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', '驿程');
        panel.hidden = true; panel.innerHTML = PANEL;
        const $ = selector => panel.querySelector(selector), [keep, scan, cfg] = $('.ft').children;
        ui = {key: null, num: badge.querySelector('.num'), unit: badge.querySelector('span'), ms: badge.querySelector('em'), fill: badge.querySelector('.fill'),
            hd: $('.hd'), hills: [...panel.querySelectorAll('.hill')], road: $('.road'), group: $('.hd g'), horse: $('.horse'), brand: $('.brand'),
            sub: $('.brand span'), route: $('.route'), go: $('.go'), label: $('.go span'), dest: element('b'), ft: $('.ft'), keep, scan, cfg,
            set: $('.set'), stations: [], sig: '', at: -1, pos: 0, deco: {}, cur: null, gap: null, cands: [], p: null};
        $('.x').addEventListener('click', () => { open = false; render(); });
        ui.go.addEventListener('click', go);
        keep.addEventListener('click', () => { if (!state) return; state.proposal = null; open = false; message = '已保留当前节点'; render(); });
        scan.addEventListener('click', () => { if (running) cancel(); else run(true); render(); });
        cfg.addEventListener('click', () => toggleSettings(!settingsOpen));
        ui.route.addEventListener('change', event => choose(event.target));
        ui.set.elements.enabled.addEventListener('change', syncStall);
        ui.set.addEventListener('submit', event => { event.preventDefault(); save(); });
        shadow.addEventListener('pointerdown', event => press(event.target.closest('button')));
        shadow.addEventListener('pointerup', release); shadow.addEventListener('pointercancel', release);
        shadow.addEventListener('pointerout', event => { if (ui.pressed && !ui.pressed.contains(event.relatedTarget)) release(); });
        shadow.append(style, badge, panel); document.documentElement.append(hostElement);
        // GSAP @require'd at document-start may have cached a null documentElement; let its CSS plugin read it again.
        if (typeof CSSPlugin !== 'undefined' && CSSPlugin.register) CSSPlugin.register();
        // @font-face inside a shadow root is ignored, so the fonts are linked at document level.
        const fonts = element('link'); fonts.rel = 'stylesheet'; fonts.href = FONTS; (document.head || document.documentElement).append(fonts);
        document.addEventListener('pointerdown', e => { if (!e.composedPath().includes(hostElement) && open) { open = false; render(); } });
        // Only Esc pressed inside the widget closes it; comment boxes and the player keep theirs.
        hostElement.addEventListener('keydown', e => { if (e.key === 'Escape' && open) { open = false; render(); badge.focus(); } });
    }
    function position() {
        positionQueued = false;
        if (!hostElement || !state) { if (hostElement) hostElement.hidden = true; return; }
        const title = document.querySelector('h1.video-title, .video-info-title h1, h1[title], .video-title h1'), box = title && title.getBoundingClientRect();
        if (title) hostElement.dataset.theme = (() => { const m = getComputedStyle(title).color.match(/[\d.]+/g); return m && Number(m[0]) > 150 ? 'dark' : 'light'; })();
        // The current player marks web fullscreen on its container; .bpx-state-web no longer exists.
        if (document.fullscreenElement || document.hidden || document.querySelector('.bpx-player-container[data-screen=web], .bpx-player-container[data-screen=full]')) { hostElement.hidden = true; return; }
        const inView = !box || box.bottom > 0 && box.top < innerHeight && box.width > 0;
        if (!inView && !open) { hostElement.hidden = true; return; }
        const reappeared = hostElement.hidden; hostElement.hidden = false; badge.hidden = !inView;
        if (reappeared && open && ui.cur) layout();
        const pw = panel.offsetWidth || 384, ph = panel.offsetHeight;
        // An open panel whose title has scrolled away waits in the top-right corner.
        if (!inView) { panel.style.left = Math.max(8, document.documentElement.clientWidth - pw - 16) + 'px'; panel.style.top = '16px'; return; }
        const bw = badge.offsetWidth;
        let left = innerWidth - bw - 16, top = 14;
        if (box) {
            const range = document.createRange(); range.selectNodeContents(title);
            const text = range.getBoundingClientRect();
            left = Math.min(text.right, box.right) + 12; top = box.top + Math.max(0, (box.height - 28) / 2);
            const boundary = Math.min(innerWidth - 12, title.closest('.video-info-container, .video-info')?.getBoundingClientRect().right || innerWidth - 12);
            if (left + bw > boundary) { left = Math.max(box.left, boundary - bw); top = box.bottom + 5; }
        }
        left = Math.max(8, Math.min(left, innerWidth - bw - 8)); top = Math.max(6, top);
        badge.style.left = left + 'px'; badge.style.top = top + 'px';
        panel.style.left = Math.max(8, Math.min(left, innerWidth - pw - 8)) + 'px';
        panel.style.top = Math.max(8, Math.min(top + 38, innerHeight - ph - 8)) + 'px';
    }
    function schedulePosition() { if (!positionQueued) { positionQueued = true; requestAnimationFrame(position); } }
    function render() {
        mount(); if (!badge) return;
        if (!state) { hostElement.hidden = true; return; }
        const s = state, fresh = s.live && Date.now() - s.live.at < 12000;
        const sample = fresh ? s.live : s.probe, stops = pool.map(n => n.host).filter(host => host !== nodeHost(s));
        const total = stops.length || 1, done = Math.min(s.results.length, total), scanning = !!running && (done > 0 || message.startsWith('筛选'));
        ui.num.textContent = scanning ? done + '/' + total : number(sample && sample.mbps);
        ui.unit.textContent = scanning ? '巡站中' : 'Mbps';
        ui.ms.textContent = scanning ? '' : running ? '测速中' : number(sample && sample.pingMs, 0) + ' ms';
        ui.fill.setAttribute('width', scanning ? 24 * done / total : 24);
        badge.classList.toggle('alert', !!s.proposal);
        // A scan that found nothing leaves the end station hollow for the quiet window instead of opening the panel.
        badge.classList.toggle('miss', !s.proposal && !running && C.since(session.missAt, Date.now()) < 3 * config.cooldownMinutes * 60000);
        badge.title = (fresh ? '当前视频分段加载速度（含缓存影响）' : '上次主动测速 ' + (s.probe ? new Date(s.probe.at).toLocaleTimeString() : '尚无结果') + '；点击查看详情') + '\nHTTP 延迟，非 ICMP ping\n' + message;
        badge.setAttribute('aria-expanded', String(open));
        // Finish a running timeline while its targets can still be measured.
        if (!open && !panel.hidden && ui.tl) { ui.tl.progress(1).kill(); ui.tl = null; }
        const opening = open && panel.hidden; panel.hidden = !open;
        if (opening) position();
        if (open) renderPanel(s, s.proposal ? s.proposal.old : sample, {opening, stops, scanning, done, total});
        else if (settingsOpen) toggleSettings(false);
        schedulePosition();
    }
    function renderPanel(s, sample, view) {
        const p = s.proposal, key = [s.key, p ? p.at : 0, view.scanning].join('|'), rebuild = view.opening || key !== ui.key;
        const before = ui.deco.line ? ui.deco.line.offsetHeight : 0, g = G();
        if (rebuild) { ui.key = key; build(p, view.scanning); }
        update(s, sample, view);
        if (!rebuild) return;
        layout();
        if (!g) return;
        if (ui.tl) ui.tl.progress(1).kill();
        ui.tl = view.opening ? opener(g) : p ? reveal(g.timeline(), 0, before) : null;
    }
    function build(p, scanning) {
        const route = ui.route, deco = ui.deco = {};
        route.replaceChildren();
        for (const name of ['line', 'trail', 'hl', 'mark', 'rider', 'ring', 'seal']) route.append(deco[name] = element('i', name === 'seal' ? '换' : undefined, name));
        deco.hl.hidden = deco.mark.hidden = !p;
        route.append(ui.cur = row('cur', '', '当前', '', '—', 'Mbps'));
        ui.gap = p || scanning ? route.appendChild(element('div', undefined, 'gap')) : null;
        ui.p = p; ui.cands = p ? p.candidates.map((c, i) => {
            const r = row('cand', station(c.host), c.region, number(c.pingMs, 0) + ' ms', number(c.mbps), i ? '' : 'Mbps', times(c, p.old));
            const radio = element('input'); radio.type = 'radio'; radio.name = 'ccb-auto-candidate'; radio.value = c.host;
            radio.checked = c.host === p.selectedHost; radio.setAttribute('aria-label', `第 ${i + 1} 名 ${c.host}，${c.region}`);
            r.title = c.host; r.prepend(radio); route.append(r); return r;
        }) : [];
        ui.go.hidden = ui.keep.hidden = !p;
        ui.label.replaceChildren('改走 ', ui.dest, ' 并刷新'); ui.dest.textContent = p ? station(p.selectedHost) : '';
        if (scanning) { ui.at = -1; ride(0, true); }
    }
    function update(s, sample, {stops, scanning, done, total}) {
        const p = s.proposal, required = s.required || config.minMbps, host = nodeHost(s), num = ui.cur.querySelector('.num');
        ui.sub.textContent = p && message === '请选择节点' ? `巡过 ${done} 站 · 香港 / 海外` : scanning ? `巡站 ${done} / ${total}` : message;
        ui.cur.querySelector('strong').textContent = station(host);
        // The last check's problems stay visible on touch screens as short phrases after the latency.
        const brief = r => /^速度 /.test(r) ? '低于目标 ' + Math.round(required) : /^HTTP 延迟 /.test(r) ? '延迟偏高' : /候选池/.test(r) ? '不在候选池' : r.split(/[，：]/)[0];
        const notes = s.problem ? s.problem.map(brief) : sample && Number.isFinite(sample.mbps) && sample.mbps < required ? ['低于目标 ' + Math.round(required)]
            : sample && sample.pingMs > config.maxPingMs ? ['延迟偏高'] : [];
        ui.cur.querySelector('.info').textContent = [number(sample && sample.pingMs, 0) + ' ms', ...notes].join(' · ');
        ui.cur.title = [host, ...(s.problem || [])].join('\n');
        if (!(num.roll && num.roll.isActive())) num.firstChild.nodeValue = number(sample && sample.mbps);
        if (ui.gap) ui.gap.replaceChildren(...(p ? [element('b', String(p.candidates.length)), ' 站可换'] : ['巡站中 ', element('b', String(done)), ' / ' + total]));
        ui.scan.textContent = running ? '取消' : '重新巡站';
        light(s, stops, scanning);
        if (settingsOpen) links(s);
    }
    // One station per candidate on the road, lit as its result arrives; the post horse rides to the latest one.
    function light(s, stops, scanning) {
        const g = G(), motion = g && !still(), p = s.proposal, picks = p ? p.candidates.map(c => c.host) : [];
        if (ui.sig !== stops.join()) {
            const length = ui.road.getTotalLength(), n = stops.length;
            ui.sig = stops.join(); ui.stations = stops.map((host, i) => {
                const at = .05 + (n > 1 ? i * .812 / (n - 1) : 0), point = ui.road.getPointAtLength(length * at);
                return {host, at, x: point.x, y: point.y, kind: null, rect: document.createElementNS(SVG, 'rect')};
            });
            ui.group.replaceChildren(...ui.stations.map(t => t.rect));
        }
        const results = new Map(s.results.map(r => [r.host, r]));
        let last = -1;
        ui.stations.forEach((t, i) => {
            const r = results.get(t.host), pick = picks.includes(t.host);
            const kind = !r ? '' : pick ? (t.host === p.selectedHost ? 'sel' : 'pick') : !r.error && Number.isFinite(r.mbps) && r.pingMs <= config.maxPingMs ? 'ok' : 'dim';
            if (r) last = i;
            if (kind === t.kind) return;
            const size = pick ? 9 : 7, lit = t.kind === '' && kind;
            t.kind = kind; t.rect.setAttribute('class', 'st ' + kind);
            for (const [k, v] of [['x', t.x - size / 2], ['y', t.y - size / 2], ['width', size], ['height', size]]) t.rect.setAttribute(k, v);
            if (lit && scanning && motion) g.fromTo(t.rect, {scale: 2.2}, {scale: 1, duration: .35, ease: 'back.out(2)', transformOrigin: '50% 50%'});
        });
        ui.hd.classList.toggle('riding', scanning);
        if (scanning) ride(last < 0 ? 0 : ui.stations[last].at);
    }
    function ride(to, jump) {
        if (to === ui.at) return;
        ui.at = to; if (ui.ride) ui.ride.kill();
        const g = G(), o = {t: ui.pos}, put = t => {
            const point = ui.road.getPointAtLength(ui.road.getTotalLength() * t);
            ui.pos = t; ui.horse.setAttribute('x', point.x - 4.5); ui.horse.setAttribute('y', point.y - 4.5);
        };
        if (jump || !g || still()) return put(to);
        ui.ride = g.to(o, {t: to, duration: .4, ease: 'power1.inOut', onUpdate: () => put(o.t)});
    }
    function layout() {
        ui.deco.line.style.height = mid(ui.cands.at(-1) || ui.cur) + 'px';
        if (ui.p) place(false);
    }
    function place(animate) {
        const r = ui.cands[ui.p.candidates.findIndex(c => c.host === ui.p.selectedHost)], {hl, mark} = ui.deco, g = G();
        if (!r) return;
        const top = r.offsetTop, height = r.offsetHeight, markTop = mid(r) - 8.5;
        if (!animate || !g || still()) { hl.style.top = top + 'px'; hl.style.height = height + 'px'; mark.style.top = markTop + 'px'; return; }
        g.to(hl, {top, height, duration: .42, ease: 'power3.inOut'});
        g.to(mark, {top: markTop, duration: .42, ease: 'power3.inOut'});
        g.fromTo(mark, {scaleY: 1}, {keyframes: [{scaleY: 1.5, scaleX: .8, duration: .21}, {scaleY: 1, scaleX: 1, duration: .21}], ease: 'sine.inOut'});
    }
    function choose(input) {
        const p = ui.p, g = G();
        if (!input.checked || !p || !state || state.proposal !== p) return;
        p.selectedHost = input.value; place(true); render();
        const dest = ui.dest, name = station(input.value), shift = still() ? 0 : 100;
        if (!g) { dest.textContent = name; return; }
        g.timeline().to(dest, {yPercent: -shift, opacity: 0, duration: .14, ease: 'power2.in'}).call(() => { dest.textContent = name; })
            .fromTo(dest, {yPercent: shift}, {yPercent: 0, opacity: 1, duration: .22, ease: 'power3.out'});
    }
    // The vermilion trail runs from the current stop to the chosen one and the 换 seal lands before reload.
    function go() {
        const p = state && state.proposal, g = G();
        if (!p || ui.busy) return;
        const finish = () => { const before = message; ui.busy = false; approve(); if (message !== before) { ui.key = null; render(); } };
        const target = ui.cands[p.candidates.findIndex(c => c.host === p.selectedHost)];
        if (!g || !target) return finish();
        ui.busy = true;
        const R = still(), {trail, rider, seal, ring} = ui.deco, a = mid(ui.cur), b = mid(target), travel = R ? .01 : .55;
        if (ui.tl) ui.tl.progress(1).kill();
        ui.tl = g.timeline().set(trail, {top: a, height: b - a, scaleY: 0}).set(rider, {top: a - 6.5, opacity: 1})
            .to(trail, {scaleY: 1, duration: travel, ease: 'power2.inOut'})
            .to(rider, {top: b - 6.5, duration: travel, ease: 'power2.inOut'}, '<')
            .set(rider, {opacity: 0})
            .fromTo(seal, {top: b - 18, scale: R ? 1 : 2.6, rotation: R ? -8 : -26, opacity: 0}, {scale: 1, rotation: -8, opacity: 1, duration: .3, ease: 'power4.in'})
            .fromTo(ring, {top: b - 18, scale: 1, opacity: .7}, {scale: R ? 1 : 2.4, opacity: 0, duration: .5, ease: 'power2.out'})
            .add(nudge(panel, 'translate', R ? 0 : 2, {duration: .05, yoyo: true, repeat: 1}), '<')
            .call(() => { ui.label.textContent = '正在刷新…'; }, null, '<')
            .call(finish, null, '+=0.35');
    }
    function opener(g) {
        const R = still(), tl = g.timeline({defaults: {ease: 'power3.out'}});
        tl.fromTo(panel, {clipPath: 'inset(0 0 100% 0)'}, {clipPath: 'inset(0 0 0% 0)', duration: R ? .01 : .5, clearProps: 'clipPath'})
            .fromTo(ui.hills, {y: R ? 0 : 14, opacity: 0}, {y: 0, opacity: 1, duration: .6, stagger: .08}, '<0.1')
            .fromTo(ui.brand, {y: R ? 0 : 8, opacity: 0}, {y: 0, opacity: 1, duration: .4}, '<0.1')
            .fromTo(ui.stations.map(t => t.rect), {scale: R ? 1 : 0, opacity: 0}, {scale: 1, opacity: 1, duration: .3, stagger: .025, ease: 'back.out(3)', transformOrigin: '50% 50%'}, '<0.1')
            .fromTo(ui.deco.line, {scaleY: R ? 1 : 0}, {scaleY: 1, duration: .55, ease: 'power2.inOut'}, '<');
        return reveal(tl, '<0.15');
    }
    function reveal(tl, at, from) {
        const R = still(), rows = [ui.cur, ui.gap, ...ui.cands].filter(Boolean), {line, hl, mark} = ui.deco;
        tl.addLabel('rows', at);
        if (from) tl.fromTo(line, {height: from}, {height: line.offsetHeight, duration: .5, ease: 'power2.inOut'}, 'rows');
        return tl.fromTo(rows, {y: R ? 0 : 14, opacity: 0}, {y: 0, opacity: 1, duration: .42, stagger: .07, ease: 'power3.out'}, 'rows')
            .call(() => ui.route.querySelectorAll('.num').forEach((num, i) => roll(num, .9 + i * .08)), null, 'rows')
            .fromTo([hl, mark], {opacity: 0}, {opacity: 1, duration: .3}, 'rows+=0.35')
            // GSAP re-parents hidden elements to read their transform, so only visible ones move.
            .fromTo([ui.go, ui.ft].filter(n => !n.hidden), {y: R ? 0 : 10, opacity: 0}, {y: 0, opacity: 1, duration: .35, stagger: .06, ease: 'power3.out'}, 'rows+=0.3');
    }
    function roll(num, duration) {
        const node = num.firstChild, to = Number(node.nodeValue), o = {v: 0}, g = G();
        if (g && Number.isFinite(to)) num.roll = g.to(o, {v: to, duration, ease: 'power2.out', onUpdate: () => { node.nodeValue = o.v.toFixed(1); }});
    }
    // GSAP 3.12 re-parents position:fixed elements to read their transform, so the capsule, the panel and
    // the buttons move through the separate CSS scale/translate properties via a proxy object instead.
    function nudge(target, prop, to, vars) {
        const box = target.nudge || (target.nudge = {scale: 1, translate: 0});
        return G().to(box, {[prop]: to, overwrite: 'auto', ...vars, onUpdate: () => { target.style[prop] = prop === 'scale' ? box.scale : '0 ' + box.translate + 'px'; }});
    }
    function press(target) {
        ui.pressed = target;
        if (target && G() && !still()) nudge(target, 'scale', .96, {duration: .08});
    }
    function release() {
        const target = ui.pressed; ui.pressed = null;
        if (target && G() && !still()) nudge(target, 'scale', 1, {duration: .5, ease: 'elastic.out(1,.45)'});
    }
    function toggleSettings(on) {
        const g = G(); settingsOpen = on; ui.set.hidden = !on; ui.cfg.setAttribute('aria-expanded', String(on));
        if (on) {
            fill(); if (state) links(state);
            if (g) g.fromTo(ui.set, {opacity: 0, y: still() ? 0 : -6}, {opacity: 1, y: 0, duration: .25, ease: 'power2.out'});
        }
        schedulePosition();
    }
    function fill() {
        const f = ui.set.elements; f.enabled.checked = config.enabled; f.stallDetection.checked = config.stallDetection;
        for (const key of ['everyVideos', 'maxPingMs', 'minMbps']) f[key].value = config[key];
        syncStall();
    }
    // Stall checks only run while automatic checks are on, so the switch is disabled with that reason.
    function syncStall() {
        const f = ui.set.elements; f.stallDetection.disabled = !f.enabled.checked; ui.set.querySelector('small').hidden = f.enabled.checked;
    }
    function links(s) {
        const [source, diagnose] = ui.set.querySelectorAll('a');
        source.textContent = `香港 / 海外 · ${pool.length} 节点`; source.href = repoUrl;
        source.title = poolSource + ' · ' + new Date(poolAt).toLocaleDateString(); diagnose.hidden = !s.meta;
        if (s.meta) diagnose.href = 'https://www.bilibili.com/blackboard/video-diagnostics.html?' + new URLSearchParams({bvid: s.bvid, cid: s.meta.cid});
    }
    // Required number fields block an empty save instead of silently restoring defaults.
    function save() {
        const s = state, f = ui.set.elements; if (!s) return;
        config = C.settings({...config, enabled: f.enabled.checked, stallDetection: f.stallDetection.checked,
            everyVideos: f.everyVideos.value, maxPingMs: f.maxPingMs.value, minMbps: f.minMbps.value});
        env.setValue(CONFIG, config);
        cancel();
        stallWatcher.reset();
        s.proposal = null; s.problem = null;
        s.required = s.meta ? C.threshold(s.meta.data, config.minMbps) : config.minMbps;
        message = '设置已保存'; fill(); render();
    }
    function tick() {
        syncContext(); const s = state, now = performance.now(), elapsed = Math.min(2, Math.max(0, (now - lastTick) / 1000)); lastTick = now;
        if (!s) return;
        if (s.proposal && C.since(s.proposal.at, Date.now()) > 120000) { s.proposal = null; message = '结果已过期，请重新测速'; }
        // Refresh stale signatures before a stall needs them; without metadata the stall window waits (L3, L18).
        if (s.meta && !running && C.since(s.meta.fetchedAt, Date.now()) > 20 * 60000) { s.meta = null; rawPlay = null; }
        // System clock moved back: readings dated in the future must not stay "fresh".
        if (s.createdAt > Date.now()) s.createdAt = Date.now();
        if (s.live && s.live.at > Date.now() + 1000) s.live = null;
        const video = videoElement();
        stallWatcher.update(video, s.key);
        if (video && !document.hidden) prepare(s);
        if (video && !video.paused && !video.seeking && video.readyState >= 2 && !document.hidden && !wasHidden) {
            s.watched += elapsed;
            if (!s.counted && s.watched >= config.watchedSeconds) {
                s.counted = true;
                if (session.lastCountedBvid !== s.bvid) { session.views++; session.lastCountedBvid = s.bvid; saveSession(); }
            }
            if (s.counted && s.meta && !running && !s.proposal && performance.now() >= (s.nextTry || 0) && C.due(session, config, Date.now())) {
                // Postpone while the player is still downloading, or the sample only sees spare bandwidth.
                if (stallWatcher.ahead() >= 5 && C.since(s.mediaAt, Date.now()) >= 2000) run();
            }
        }
        wasHidden = document.hidden; render();
    }
    document.addEventListener('visibilitychange', () => {
        // GM storage does not notify open tabs; pick up settings saved elsewhere on return.
        // An open form is refilled only when another tab really changed settings, so unsaved edits survive a tab switch (L9).
        if (!document.hidden) {
            const next = C.settings(env.getValue(CONFIG, {}));
            if (settingsOpen && JSON.stringify(next) !== JSON.stringify(config)) { config = next; fill(); } else config = next;
        }
        if (document.hidden && running) running.abort(); stallWatcher.reset(); lastTick = performance.now(); wasHidden = document.hidden; render(); });
    window.addEventListener('resize', schedulePosition); window.addEventListener('scroll', schedulePosition, {passive: true});
    document.addEventListener('fullscreenchange', schedulePosition);
    // A page restored from the back/forward cache must not write its stale counters back.
    window.addEventListener('pageshow', e => { if (e.persisted) Object.assign(session, safeRead(SKEY, {})); });
    window.addEventListener('pagehide', () => { stallWatcher.dispose(); if (running) running.abort(); if (state && state.metaAbort) state.metaAbort.abort(); });
    syncContext(); setInterval(tick, 1000);
    env.registerMenu('🌐 驿程：节点优选与网络状态', () => { open = true; render(); });
    return {observePlayInfo, ingestMetric,
        isVideoContext: () => !!C.identity(location.href),
        clearOverride: () => { try { sessionStorage.removeItem('CCB_AUTO_active_v1'); } catch (_) {} },
        // Used only by the local fixture tests through the returned lexical controller.
        inspect: () => ({state, session, config, pool, message, running: !!running}), run};
}
