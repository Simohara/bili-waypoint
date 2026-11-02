// ==UserScript==
// @name         CCB Auto - 香港海外节点优选与网络状态
// @description  每几个视频检查延迟与吞吐，香港/海外节点优选，批准刷新后应用，标题旁显示加载状态
// @namespace    CCB-Auto
// @license      MIT
// @version      2.2.0-auto.3
// @author       鼠鼠今天吃嘉然
// @run-at       document-start
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/bangumi/play/*
// @match        https://www.bilibili.com/cheese/play/*
// @match        https://www.bilibili.com/festival/*
// @match        https://www.bilibili.com/list/*
// @match        https://live.bilibili.com/*
// @match        https://www.bilibili.com/blackboard/*
// @match        https://player.bilibili.com/*
// @connect      kanda-akihito-kun.github.io
// @connect      raw.githubusercontent.com
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// ==/UserScript==

;(() => {

    // Original author: 鼠鼠今天吃嘉然. CCB Auto additions: MIT, 2026.
    /* CCB Auto additions, MIT. Pure policy shared by the userscript and tests. */
function createCcbAutoCore() {
    const defaults = Object.freeze({enabled: true, stallDetection: true, everyVideos: 3, watchedSeconds: 20,
        maxPingMs: 350, minMbps: 35, cooldownMinutes: 10});
    function settings(value = {}) {
        const number = (key, lo, hi) => Math.min(hi, Math.max(lo, Number(value[key]) || defaults[key]));
        return {enabled: value.enabled !== false, stallDetection: value.stallDetection !== false,
            everyVideos: Math.round(number('everyVideos', 1, 30)),
            watchedSeconds: number('watchedSeconds', 5, 300), maxPingMs: number('maxPingMs', 50, 3000),
            minMbps: number('minMbps', 5, 200), cooldownMinutes: number('cooldownMinutes', 1, 120)};
    }
    function host(value) {
        try {
            const u = new URL(value.includes('://') ? value : 'https://' + value);
            if (u.protocol !== 'https:' || u.username || u.password || u.port || u.pathname !== '/' || u.search || u.hash) return '';
            return /(?:^|\.)(?:bilivideo\.(?:com|cn)|acgvideo\.(?:com|cn)|akamaized\.net)$/.test(u.hostname) ? u.hostname : '';
        } catch (_) { return ''; }
    }
    function nodes(data) {
        const result = [], seen = new Set();
        for (const region of ['香港', '海外']) {
            for (const raw of Array.isArray(data && data[region]) ? data[region] : []) {
                const name = typeof raw === 'string' ? host(raw) : '';
                if (!name || seen.has(name)) continue;
                seen.add(name); result.push({host: name, region});
            }
        }
        return result;
    }
    function identity(url) {
        try {
            const u = new URL(url), match = /^\/video\/(BV[a-zA-Z0-9]{10})\/?$/.exec(u.pathname);
            if (u.hostname !== 'www.bilibili.com' || !match) return null;
            const rawPage = u.searchParams.get('p') || '1';
            const page = /^\d+$/.test(rawPage) ? Number(rawPage) : 1;
            return {bvid: match[1], page: Number.isSafeInteger(page) && page > 0 ? page : 1};
        } catch (_) { return null; }
    }
    function median(values) {
        const v = values.filter(Number.isFinite).sort((a, b) => a - b);
        return v.length ? (v[Math.floor((v.length - 1) / 2)] + v[Math.floor(v.length / 2)]) / 2 : null;
    }
    function threshold(data, floor) {
        const dash = data && data.dash;
        const tracks = (dash && dash.video || []).filter(t => t.id === 120 || t.width >= 3840 || t.height >= 2160);
        const video = Math.max(0, ...tracks.map(t => Number(t.bandwidth) || 0));
        const audio = Math.max(0, ...(dash && dash.audio || []).map(t => Number(t.bandwidth) || 0));
        return Math.max(floor, (video + (video ? audio : 0)) * 1.3 / 1e6);
    }
    function healthy(result, config, requiredMbps) {
        return !!result && !result.error && Number.isFinite(result.pingMs) && Number.isFinite(result.mbps)
            && result.pingMs <= config.maxPingMs && result.mbps >= requiredMbps;
    }
    function reasons(result, config, requiredMbps) {
        if (!result) return ['未取得有效样本'];
        const output = [];
        if (result.error) output.push(result.error);
        if (Number.isFinite(result.pingMs) && result.pingMs > config.maxPingMs) output.push(`HTTP 延迟 ${Math.round(result.pingMs)} ms > ${config.maxPingMs} ms`);
        if (Number.isFinite(result.mbps) && result.mbps < requiredMbps) output.push(`速度 ${result.mbps.toFixed(1)} Mbps < 4K 目标 ${requiredMbps.toFixed(1)} Mbps`);
        return output;
    }
    function validateRange({status, range, size, expected, type, sample, finalUrl, expectedHost}) {
        if (status !== 206) throw new Error(`HTTP ${status}，未返回有效分段`);
        if (new URL(finalUrl).hostname !== expectedHost) throw new Error('响应跳转到了其他节点');
        const m = /^bytes 0-(\d+)\/(\d+)$/.exec(range || '');
        if (!m || Number(m[1]) + 1 !== expected || Number(m[2]) < expected || size !== expected) throw new Error('分段长度校验失败');
        if (/html|json|xml|text\//i.test(type || '')) throw new Error('节点返回了错误页');
        if (sample && /^\s*(?:<!doctype|<html|<\?xml|\{\s*"(?:code|error)")/i.test(sample)) throw new Error('节点返回了错误内容');
    }
    function due(session, config, now) {
        if (!config.enabled || now - (session.lastCheckAt || 0) < config.cooldownMinutes * 60000) return false;
        return session.views - (session.lastCheckViews || 0) >= config.everyVideos;
    }
    return {defaults, settings, host, nodes, identity, median, threshold, healthy, reasons, validateRange, due};
}
if (typeof module !== 'undefined' && module.exports) module.exports = createCcbAutoCore();


/* Observes the player's own downloads; never clones or downloads an extra body. */
function installCcbAutoTelemetry(scope, emit) {
    if (scope.__CCB_AUTO_METRICS__) return;
    scope.__CCB_AUTO_METRICS__ = true;
    const media = value => { try { return /(?:^|\.)(?:bilivideo\.(?:com|cn)|acgvideo\.(?:com|cn)|akamaized\.net)$/.test(new URL(value).hostname); } catch (_) { return false; } };
    const now = () => scope.performance.now();
    const publish = (url, start, bytes, ping, final, status) => {
        try { emit({url, duration: now() - start, bytes, ping, final, status, at: Date.now()}); } catch (_) {}
    };
    const BaseXHR = scope.XMLHttpRequest;
    if (BaseXHR) {
        scope.XMLHttpRequest = class extends BaseXHR {
            open(method, url, ...rest) {
                this.__ccbMetricUrl = typeof url === 'string' && media(url) ? url : '';
                this.__ccbMetricStart = null;
                if (!this.__ccbMetricBound) {
                    this.__ccbMetricBound = true;
                    this.addEventListener('readystatechange', () => {
                        if (this.readyState === 2 && this.__ccbMetricStart !== null) this.__ccbMetricPing = now() - this.__ccbMetricStart;
                    });
                    this.addEventListener('progress', event => {
                        if (!this.__ccbMetricUrl || this.__ccbMetricStart === null) return;
                        this.__ccbMetricBytes = event.loaded;
                        if (now() - this.__ccbMetricLast >= 250) {
                            this.__ccbMetricLast = now();
                            publish(this.responseURL || this.__ccbMetricUrl, this.__ccbMetricStart, event.loaded, this.__ccbMetricPing, false, this.status);
                        }
                    });
                    this.addEventListener('loadend', () => {
                        if (this.__ccbMetricUrl && this.__ccbMetricStart !== null) publish(this.responseURL || this.__ccbMetricUrl,
                            this.__ccbMetricStart, this.__ccbMetricBytes, this.__ccbMetricPing, true, this.status);
                    });
                }
                return super.open(method, url, ...rest);
            }
            send(...args) {
                this.__ccbMetricStart = this.__ccbMetricUrl ? now() : null;
                this.__ccbMetricLast = now(); this.__ccbMetricBytes = 0; this.__ccbMetricPing = null;
                return super.send(...args);
            }
        };
    }
    const baseFetch = scope.fetch;
    if (baseFetch && scope.ReadableStream && scope.Response) {
        scope.fetch = async function (input, init) {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            if (!media(url)) return baseFetch.call(scope, input, init);
            const start = now(), response = await baseFetch.call(scope, input, init), ping = now() - start;
            if (!response.ok || !response.body) return response;
            let bytes = 0, last = now(), reader;
            const body = new scope.ReadableStream({
                // Acquire the reader lazily; no eager read or additional fetch.
                async pull(controller) {
                    try {
                        if (!reader) reader = response.body.getReader();
                        const chunk = await reader.read();
                        if (chunk.done) {
                            publish(response.url || url, start, bytes, ping, true, response.status);
                            controller.close(); return;
                        }
                        bytes += chunk.value.byteLength;
                        if (now() - last >= 250) { last = now(); publish(response.url || url, start, bytes, ping, false, response.status); }
                        controller.enqueue(chunk.value);
                    } catch (error) { controller.error(error); }
                },
                cancel(reason) { return reader ? reader.cancel(reason) : response.body.cancel(reason); },
            }, {highWaterMark: 0});
            const observed = new scope.Response(body, {status: response.status, statusText: response.statusText, headers: response.headers});
            for (const key of ['url', 'redirected', 'type']) {
                try { Object.defineProperty(observed, key, {value: response[key]}); } catch (_) {}
            }
            return observed;
        };
    }
}


/* Playback-aware stall detection; no network activity until onStall fires. MIT. */
function createCcbStallWatcher(options) {
    const delay = 2500, cooldown = 90000;
    let video = null, context = '', listeners = null, timer = null;
    let since = null, waiting = false, handled = false, seekUntil = 0, position = 0;
    const now = () => performance.now();
    function clearWindow() { clearTimeout(timer); timer = null; since = null; }
    function reset() { clearWindow(); waiting = false; handled = false; }
    function ahead() {
        try {
            const time = video.currentTime;
            for (let i = 0; i < video.buffered.length; i++) {
                if (video.buffered.start(i) <= time + 0.05 && video.buffered.end(i) > time) return video.buffered.end(i) - time;
            }
        } catch (_) {}
        return 0;
    }
    function poll() {
        if (!video || !options.active(context) || !options.enabled()) { reset(); return; }
        const time = Number(video.currentTime) || 0;
        if (Math.abs(time - position) > 0.05) { position = time; clearWindow(); handled = false; }
        if (video.paused || video.ended || video.seeking || now() < seekUntil || ahead() > 0.75 ||
            (Number.isFinite(video.duration) && video.duration - time < 0.75)) { reset(); return; }
        if (options.busy() || (!waiting && video.readyState >= 3)) { clearWindow(); return; }
        if (handled || Date.now() - options.lastRunAt() < cooldown) { clearWindow(); return; }
        if (since === null) since = now();
        const remaining = delay - (now() - since);
        if (remaining > 0) {
            if (!timer) timer = setTimeout(() => { timer = null; poll(); }, remaining + 5);
            return;
        }
        clearWindow(); handled = true; options.onStall();
    }
    function update(nextVideo, nextContext) {
        if (video !== nextVideo || context !== nextContext) {
            if (listeners) listeners.abort();
            reset(); seekUntil = 0; video = nextVideo; context = nextContext;
            if (video) {
                position = Number(video.currentTime) || 0;
                listeners = new AbortController();
                const on = (type, handler) => video.addEventListener(type, handler, {signal: listeners.signal});
                for (const type of ['waiting', 'stalled']) on(type, () => { waiting = true; poll(); });
                for (const type of ['playing', 'pause', 'ended', 'emptied', 'loadstart']) on(type, reset);
                for (const type of ['seeking', 'seeked']) on(type, () => { reset(); seekUntil = now() + delay; });
                on('timeupdate', poll);
            }
        }
        poll();
    }
    function dispose() { reset(); if (listeners) listeners.abort(); video = null; context = ''; }
    return {update, reset, dispose};
}


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

    const autoCore = createCcbAutoCore();
    const autoSnapshot = {"上海":["cn-sh-ct-01-01.bilivideo.com","cn-sh-ct-01-06.bilivideo.com","cn-sh-ct-01-13.bilivideo.com","cn-sh-ct-01-15.bilivideo.com","cn-sh-ct-01-23.bilivideo.com","cn-sh-ct-01-24.bilivideo.com","cn-sh-ct-01-35.bilivideo.com","cn-sh-ct-01-36.bilivideo.com","cn-sh-office-bcache-01.bilivideo.com"],"内蒙":["cn-nmghhht-cm-01-11.bilivideo.com","cn-nmghhht-cu-01-01.bilivideo.com","cn-nmghhht-cu-01-07.bilivideo.com","cn-nmghhht-cu-01-08.bilivideo.com","cn-nmghhht-cu-01-09.bilivideo.com","cn-nmghhht-cu-01-10.bilivideo.com","cn-nmghhht-cu-01-12.bilivideo.com","cn-nmghhht-cu-01-13.bilivideo.com","cn-nmghhht-cu-01-14.bilivideo.com","cn-nmghhht-cu-01-15.bilivideo.com"],"北京":["cn-bj-cc-03-14.bilivideo.com","cn-bj-cc-03-17.bilivideo.com","cn-bj-fx-01-04.bilivideo.com","cn-bj-fx-01-05.bilivideo.com","cn-bj-se-01-03.bilivideo.com","cn-bj-se-01-04.bilivideo.com","cn-bj-se-01-05.bilivideo.com","cn-bj-se-01-06.bilivideo.com"],"四川":["cn-sccd-cm-03-01.bilivideo.com","cn-sccd-cm-03-02.bilivideo.com","cn-sccd-cm-03-05.bilivideo.com","cn-sccd-cm-03-07.bilivideo.com","cn-sccd-ct-01-02.bilivideo.com","cn-sccd-ct-01-08.bilivideo.com","cn-sccd-ct-01-10.bilivideo.com","cn-sccd-ct-01-17.bilivideo.com","cn-sccd-ct-01-18.bilivideo.com","cn-sccd-ct-01-19.bilivideo.com","cn-sccd-ct-01-20.bilivideo.com","cn-sccd-ct-01-21.bilivideo.com","cn-sccd-ct-01-22.bilivideo.com","cn-sccd-ct-01-23.bilivideo.com","cn-sccd-ct-01-24.bilivideo.com","cn-sccd-ct-01-25.bilivideo.com","cn-sccd-ct-01-26.bilivideo.com","cn-sccd-ct-01-27.bilivideo.com","cn-sccd-ct-01-29.bilivideo.com","cn-sccd-cu-01-01.bilivideo.com","cn-sccd-cu-01-02.bilivideo.com","cn-sccd-cu-01-03.bilivideo.com","cn-sccd-cu-01-04.bilivideo.com","cn-sccd-cu-01-05.bilivideo.com","cn-sccd-cu-01-06.bilivideo.com","cn-sccd-cu-01-07.bilivideo.com","cn-sccd-cu-01-08.bilivideo.com","cn-sccd-cu-01-09.bilivideo.com","cn-sccd-fx-01-01.bilivideo.com","cn-sccd-fx-01-06.bilivideo.com","cn-scdy-ct-01-05.bilivideo.com"],"外建":["c0--cn-gotcha01.bilivideo.com","c1--cn-gotcha09.bilivideo.com","c1--cn-gotcha208.bilivideo.com","d0--cn-gotcha01.bilivideo.com","d0--cn-gotcha09.bilivideo.com","d0--cn-gotcha208-01.bilivideo.com","d1--cn-gotcha04.bilivideo.com","d1--cn-gotcha04b.bilivideo.com","d1--cn-gotcha07.bilivideo.com","d1--cn-gotcha07b.bilivideo.com","d1--cn-gotcha09.bilivideo.com","d1--cn-gotcha101.bilivideo.com","d1--cn-gotcha102.bilivideo.com","d1--cn-gotcha204-1.bilivideo.com","d1--cn-gotcha204-2.bilivideo.com","d1--cn-gotcha204-3.bilivideo.com","d1--cn-gotcha204-4.bilivideo.com","d1--cn-gotcha204.bilivideo.com","d1--cn-gotcha207.bilivideo.com","d1--cn-gotcha208.bilivideo.com","d1--cn-gotcha208b.bilivideo.com","d1--cn-gotcha209.bilivideo.com","d1--cn-gotcha209b.bilivideo.com","d1--cn-gotcha211.bilivideo.com","d1--cn-gotcha308.bilivideo.com","d1--ov-gotcha01.bilivideo.com","d1--ov-gotcha03.bilivideo.com","d1--ov-gotcha05.bilivideo.com","d1--ov-gotcha07.bilivideo.com","d1--ov-gotcha207.bilivideo.com","d1--ov-gotcha207b.bilivideo.com","d1--ov-gotcha208.bilivideo.com","d1--ov-gotcha209.bilivideo.com","d1--ov-gotcha210.bilivideo.com","d1--p1--cn-gotcha04.bilivideo.com","d1--p2--cn-gotcha04.bilivideo.com","d1--tf-gotcha01-loc.bilivideo.com","d1--tf-gotcha01.bilivideo.com","d1--tf-gotcha04.bilivideo.com","d1--tf-gotcha08.bilivideo.com","d1-cn-gotcha210.bilivideo.com"],"天津":["cn-tj-cm-02-01.bilivideo.com","cn-tj-cm-02-02.bilivideo.com","cn-tj-cm-02-03.bilivideo.com","cn-tj-cm-02-04.bilivideo.com","cn-tj-cm-02-05.bilivideo.com","cn-tj-cm-02-06.bilivideo.com","cn-tj-cm-02-07.bilivideo.com","cn-tj-cu-01-01.bilivideo.com","cn-tj-cu-01-02.bilivideo.com","cn-tj-cu-01-03.bilivideo.com","cn-tj-cu-01-04.bilivideo.com","cn-tj-cu-01-05.bilivideo.com","cn-tj-cu-01-06.bilivideo.com","cn-tj-cu-01-07.bilivideo.com","cn-tj-cu-01-08.bilivideo.com","cn-tj-cu-01-09.bilivideo.com","cn-tj-cu-01-10.bilivideo.com","cn-tj-cu-01-11.bilivideo.com","cn-tj-cu-01-12.bilivideo.com","cn-tj-cu-01-13.bilivideo.com","cn-tj-cu-01-16.bilivideo.com","cn-tj-cu-01-17.bilivideo.com","cn-tj-fx-01-01.bilivideo.com","cn-tj-fx-01-05.bilivideo.com"],"山东":["cn-sdjn-cm-02-01.bilivideo.com","cn-sdjn-cm-02-02.bilivideo.com","cn-sdjn-cm-02-03.bilivideo.com","cn-sdjn-cm-02-04.bilivideo.com","cn-sdjn-cm-02-05.bilivideo.com","cn-sdjn-cm-02-06.bilivideo.com","cn-sdjn-cm-02-07.bilivideo.com","cn-sdjn-cm-02-08.bilivideo.com","cn-sdjn-cm-02-09.bilivideo.com","cn-sdjn-cm-02-10.bilivideo.com","cn-sdjn-cm-02-11.bilivideo.com","cn-sdjn-cm-02-12.bilivideo.com","cn-sdjn-cm-02-13.bilivideo.com","cn-sdjn-fx-01-01.bilivideo.com","cn-sdjn-fx-01-02.bilivideo.com","cn-sdqd-ccc-01-01.bilivideo.com","cn-sdqd-cu-01-01.bilivideo.com","cn-sdqd-cu-01-08.bilivideo.com","cn-sdqd-cu-01-09.bilivideo.com","cn-sdqd-cu-01-11.bilivideo.com","cn-sdqd-cu-01-16.bilivideo.com","cn-sdqd-cu-01-17.bilivideo.com","cn-sdqd-cu-01-21.bilivideo.com","cn-sdqd-cu-01-22.bilivideo.com","cn-sdqd-cu-01-23.bilivideo.com","cn-sdqd-cu-01-24.bilivideo.com","cn-sdqd-cu-01-25.bilivideo.com"],"山西":["cn-sxty-cm-02-04.bilivideo.com","cn-sxty-cm-02-09.bilivideo.com","cn-sxty-cm-02-10.bilivideo.com","cn-sxty-cu-03-01.bilivideo.com","cn-sxty-cu-03-02.bilivideo.com","cn-sxty-cu-03-03.bilivideo.com","cn-sxty-cu-03-04.bilivideo.com","cn-sxty-cu-03-05.bilivideo.com","cn-sxty-cu-03-06.bilivideo.com","cn-sxty-cu-03-07.bilivideo.com","cn-sxty-cu-03-08.bilivideo.com","cn-sxty-cu-03-09.bilivideo.com"],"广东":["cn-gddg-ccc-01-01.bilivideo.com","cn-gddg-cm-01-02.bilivideo.com","cn-gddg-cm-01-03.bilivideo.com","cn-gddg-cm-01-04.bilivideo.com","cn-gddg-cm-01-05.bilivideo.com","cn-gddg-cm-01-06.bilivideo.com","cn-gddg-cm-01-13.bilivideo.com","cn-gddg-cm-01-14.bilivideo.com","cn-gddg-cm-01-18.bilivideo.com","cn-gddg-ct-01-10.bilivideo.com","cn-gddg-ct-01-11.bilivideo.com","cn-gddg-ct-01-12.bilivideo.com","cn-gddg-ct-01-13.bilivideo.com","cn-gddg-ct-01-15.bilivideo.com","cn-gddg-ct-01-17.bilivideo.com","cn-gddg-ct-01-18.bilivideo.com","cn-gddg-ct-01-21.bilivideo.com","cn-gddg-ct-01-24.bilivideo.com","cn-gddg-cu-01-04.bilivideo.com","cn-gddg-cu-01-06.bilivideo.com","cn-gddg-cu-01-07.bilivideo.com","cn-gdfs-cc-02-02.bilivideo.com","cn-gdfs-cc-02-06.bilivideo.com","cn-gdfs-cc-02-07.bilivideo.com","cn-gdfs-cc-02-18.bilivideo.com","cn-gdfs-ct-01-01.bilivideo.com","cn-gdfs-ct-01-03.bilivideo.com","cn-gdfs-ct-01-04.bilivideo.com","cn-gdfs-ct-01-05.bilivideo.com","cn-gdfs-ct-01-06.bilivideo.com","cn-gdfs-ct-01-07.bilivideo.com","cn-gdfs-ct-01-08.bilivideo.com","cn-gdfs-ct-01-09.bilivideo.com","cn-gdfs-ct-01-10.bilivideo.com","cn-gdfs-ct-01-12.bilivideo.com","cn-gdfs-ct-01-13.bilivideo.com","cn-gdfs-ct-01-14.bilivideo.com","cn-gdfs-ct-01-16.bilivideo.com","cn-gdfs-ct-01-17.bilivideo.com","cn-gdfs-ct-01-18.bilivideo.com","cn-gdfs-ct-01-19.bilivideo.com","cn-gdfs-ct-01-21.bilivideo.com","cn-gdfs-ct-01-22.bilivideo.com","cn-gdgz-cm-01-02.bilivideo.com","cn-gdgz-cm-01-10.bilivideo.com","cn-gdgz-fx-01-01.bilivideo.com","cn-gdgz-fx-01-02.bilivideo.com","cn-gdgz-fx-01-03.bilivideo.com","cn-gdgz-fx-01-04.bilivideo.com","cn-gdgz-fx-01-05.bilivideo.com","cn-gdgz-fx-01-06.bilivideo.com","cn-gdgz-fx-01-07.bilivideo.com","cn-gdgz-fx-01-08.bilivideo.com","cn-gdgz-fx-01-09.bilivideo.com","cn-gdgz-fx-01-10.bilivideo.com","cn-gdgz-gd-01-01.bilivideo.com","cn-gdjm-cm-01-01.bilivideo.com","cn-gdjm-cm-01-02.bilivideo.com","cn-gdjm-cm-01-03.bilivideo.com","cn-gdjm-cm-01-04.bilivideo.com","cn-gdjm-cm-01-05.bilivideo.com","cn-gdjm-cm-01-06.bilivideo.com","cn-gdjm-cm-01-07.bilivideo.com","cn-gdjm-cm-01-08.bilivideo.com","cn-gdst-cm-01-01.bilivideo.com","cn-gdst-cm-01-02.bilivideo.com","cn-gdst-cm-01-03.bilivideo.com","cn-gdst-cm-01-04.bilivideo.com","cn-gdst-cm-01-05.bilivideo.com","cn-gdst-cm-01-06.bilivideo.com","cn-gdst-cm-01-07.bilivideo.com","cn-gdst-cm-01-10.bilivideo.com","cn-gdst-cm-01-12.bilivideo.com","cn-gdst-cm-01-15.bilivideo.com","cn-gdst-cm-01-17.bilivideo.com"],"新疆":["cn-xj-cm-02-01.bilivideo.com","cn-xj-cm-02-03.bilivideo.com","cn-xj-cm-02-04.bilivideo.com","cn-xj-cm-02-06.bilivideo.com","cn-xj-ct-01-01.bilivideo.com","cn-xj-ct-01-02.bilivideo.com","cn-xj-ct-01-03.bilivideo.com","cn-xj-ct-01-04.bilivideo.com","cn-xj-ct-01-05.bilivideo.com","cn-xj-ct-02-02.bilivideo.com"],"江苏":["cn-jsnj-fx-02-05.bilivideo.com","cn-jsnj-fx-02-07.bilivideo.com","cn-jsnj-fx-02-10.bilivideo.com","cn-jsnj-gd-01-02.bilivideo.com","cn-jssz-cm-02-07.bilivideo.com","cn-jssz-cm-02-08.bilivideo.com","cn-jssz-cm-02-18.bilivideo.com","cn-jssz-cm-02-20.bilivideo.com","cn-jssz-cm-02-25.bilivideo.com","cn-jssz-cm-02-31.bilivideo.com","cn-jssz-cm-02-34.bilivideo.com","cn-jssz-cm-02-35.bilivideo.com","cn-jssz-cm-02-40.bilivideo.com","cn-jssz-cm-02-42.bilivideo.com","ec-jssz-ct-01-02.bilivideo.com"],"江西":["cn-jxjj-ct-01-01.bilivideo.com","cn-jxjj-ct-01-02.bilivideo.com","cn-jxjj-ct-01-05.bilivideo.com","cn-jxjj-ct-01-14.bilivideo.com","cn-jxnc-cm-01-04.bilivideo.com","cn-jxnc-cm-01-09.bilivideo.com","cn-jxnc-cm-01-12.bilivideo.com","cn-jxnc-cm-01-19.bilivideo.com","cn-jxnc-cm-01-42.bilivideo.com","cn-jxnc-cmcc-bcache-06.bilivideo.com"],"河北":["cn-hblf-ct-01-06.bilivideo.com","cn-hblf-ct-01-19.bilivideo.com","cn-hbsjz-cm-02-01.bilivideo.com","cn-hbsjz-cm-02-02.bilivideo.com","cn-hbsjz-cm-02-03.bilivideo.com","cn-hbsjz-cm-02-04.bilivideo.com","cn-hbsjz-cm-02-05.bilivideo.com","cn-hbsjz-cm-02-07.bilivideo.com","cn-hbsjz-cm-02-08.bilivideo.com","cn-hbsjz-cm-02-09.bilivideo.com","cn-hbsjz-cm-02-10.bilivideo.com","cn-hbsjz-cm-02-11.bilivideo.com","cn-hbsjz-cm-02-12.bilivideo.com","cn-hbsjz-cm-02-13.bilivideo.com","cn-hbsjz-cm-02-14.bilivideo.com"],"河南":["cn-hnzz-cm-01-01.bilivideo.com","cn-hnzz-cm-01-02.bilivideo.com","cn-hnzz-cm-01-03.bilivideo.com","cn-hnzz-cm-01-04.bilivideo.com","cn-hnzz-cm-01-05.bilivideo.com","cn-hnzz-cm-01-06.bilivideo.com","cn-hnzz-cm-01-09.bilivideo.com","cn-hnzz-cm-01-10.bilivideo.com","cn-hnzz-cm-01-11.bilivideo.com","cn-hnzz-cm-01-13.bilivideo.com","cn-hnzz-cm-01-14.bilivideo.com","cn-hnzz-cm-01-15.bilivideo.com","cn-hnzz-cm-01-16.bilivideo.com","cn-hnzz-fx-01-01.bilivideo.com","cn-hnzz-fx-01-08.bilivideo.com"],"浙江":["cn-zjhz-cm-01-01.bilivideo.com","cn-zjhz-cm-01-04.bilivideo.com","cn-zjhz-cm-01-07.bilivideo.com","cn-zjhz-cm-01-08.bilivideo.com","cn-zjhz-cm-01-11.bilivideo.com","cn-zjhz-cm-01-12.bilivideo.com","cn-zjhz-cm-01-16.bilivideo.com","cn-zjhz-cm-01-17.bilivideo.com","cn-zjhz-cm-01-19.bilivideo.com","cn-zjhz-cm-01-28.bilivideo.com","cn-zjhz-cu-01-01.bilivideo.com","cn-zjhz-cu-01-02.bilivideo.com","cn-zjhz-cu-01-04.bilivideo.com","cn-zjhz-cu-01-05.bilivideo.com","cn-zjhz-cu-01-06.bilivideo.com","cn-zjhz-cu-v-02.bilivideo.com","cn-zjhz3-wasu-bcache-05.bilivideo.com","cn-zjhz3-wasu-bcache-11.bilivideo.com","cn-zjhz3-wasu-bcache-15.bilivideo.com","cn-zjhz3-wasu-bcache-20.bilivideo.com","cn-zjjh-ct-04-03.bilivideo.com","cn-zjjh-ct-04-06.bilivideo.com","cn-zjjh-ct-04-12.bilivideo.com","cn-zjjh-ct-04-13.bilivideo.com","cn-zjjh-ct-04-14.bilivideo.com","cn-zjjh-ct-04-15.bilivideo.com","cn-zjjh-ct-04-16.bilivideo.com","cn-zjjh-ct-04-24.bilivideo.com","cn-zjjh-ct-04-26.bilivideo.com","cn-zjjh-ct-04-27.bilivideo.com","cn-zjjh-ct-04-28.bilivideo.com","cn-zjjh-ct-04-29.bilivideo.com","cn-zjjh-ct-04-30.bilivideo.com","cn-zjjh-ct-04-33.bilivideo.com","cn-zjjh-ct-04-34.bilivideo.com"],"海外":["upos-hz-mirrorakam.akamaized.net","upos-sz-mirror08h.bilivideo.com","upos-sz-mirroraliov.bilivideo.com","upos-sz-mirrorcosov.bilivideo.com"],"深圳":["upos-sz-302kodo.bilivideo.com","upos-sz-302ppio.bilivideo.com","upos-sz-dynqn.bilivideo.com","upos-sz-estgcos.bilivideo.com","upos-sz-estghw.bilivideo.com","upos-sz-estgoss.bilivideo.com","upos-sz-mirror08c.bilivideo.com","upos-sz-mirror08ct.bilivideo.com","upos-sz-mirror08disp.bilivideo.com","upos-sz-mirrorali.bilivideo.com","upos-sz-mirroralib.bilivideo.com","upos-sz-mirroralibstar1.bilivideo.com","upos-sz-mirrorasiaov.bilivideo.com","upos-sz-mirrorawsov.bilivideo.com","upos-sz-mirrorbd.bilivideo.com","upos-sz-mirrorbdb.bilivideo.com","upos-sz-mirrorcf1ov.bilivideo.com","upos-sz-mirrorcos.bilivideo.com","upos-sz-mirrorcosb.bilivideo.com","upos-sz-mirrorcosbstar.bilivideo.com","upos-sz-mirrorcosdisp.bilivideo.com","upos-sz-mirrorcoso1.bilivideo.com","upos-sz-mirrorctos.bilivideo.com","upos-sz-mirrorhw.bilivideo.com","upos-sz-mirrorhwb.bilivideo.com","upos-sz-mirrorhwdisp.bilivideo.com","upos-sz-mirrorhwo1.bilivideo.com","upos-sz-mirrorzos.bilivideo.com","upos-sz-static.bilivideo.com","upos-sz-staticcos-cmask.bilivideo.com","upos-sz-staticcos.bilivideo.com"],"湖北":["cn-hbwh-cm-01-01.bilivideo.com","cn-hbwh-cm-01-02.bilivideo.com","cn-hbwh-cm-01-03.bilivideo.com","cn-hbwh-cm-01-04.bilivideo.com","cn-hbwh-cm-01-05.bilivideo.com","cn-hbwh-cm-01-06.bilivideo.com","cn-hbwh-cm-01-07.bilivideo.com","cn-hbwh-cm-01-08.bilivideo.com","cn-hbwh-cm-01-09.bilivideo.com","cn-hbwh-cm-01-10.bilivideo.com","cn-hbwh-cm-01-11.bilivideo.com","cn-hbwh-cm-01-12.bilivideo.com","cn-hbwh-cm-01-13.bilivideo.com","cn-hbwh-cm-01-14.bilivideo.com","cn-hbwh-cm-01-15.bilivideo.com","cn-hbwh-cm-01-16.bilivideo.com","cn-hbwh-cm-01-17.bilivideo.com","cn-hbwh-cm-01-18.bilivideo.com","cn-hbwh-cm-01-19.bilivideo.com","cn-hbwh-cm-01-20.bilivideo.com","cn-hbwh-fx-01-01.bilivideo.com","cn-hbwh-fx-01-02.bilivideo.com","cn-hbwh-fx-01-12.bilivideo.com","cn-hbwh-fx-01-13.bilivideo.com","cn-hbyc-ct-01-13.bilivideo.com","cn-hbyc-ct-02-02.bilivideo.com","cn-hbyc-ct-02-04.bilivideo.com","cn-hbyc-ct-02-06.bilivideo.com","cn-hbyc-ct-02-10.bilivideo.com","cn-hbyc-ct-02-11.bilivideo.com","cn-hbyc-ct-02-12.bilivideo.com","cn-hbyc-ct-02-19.bilivideo.com","cn-hbyc-ct-02-23.bilivideo.com"],"湖南":["cn-hncs-cm-03-01.bilivideo.com","cn-hncs-cm-03-04.bilivideo.com","cn-hncs-cm-03-05.bilivideo.com","cn-hncs-cm-03-08.bilivideo.com","cn-hncs-cm-03-09.bilivideo.com","cn-hncs-cm-03-11.bilivideo.com","cn-hncs-cm-03-12.bilivideo.com","cn-hncs-cu-01-01.bilivideo.com","cn-hncs-cu-01-02.bilivideo.com","cn-hncs-cu-01-03.bilivideo.com","cn-hncs-cu-01-04.bilivideo.com","cn-hncs-cu-01-05.bilivideo.com","cn-hncs-cu-01-06.bilivideo.com","cn-hncs-cu-01-07.bilivideo.com","cn-hncs-cu-01-09.bilivideo.com","cn-hncs-cu-01-10.bilivideo.com","cn-hncs-cu-v-01.bilivideo.com","cn-hncs-cu-v-03.bilivideo.com","cn-hncs-fx-01-01.bilivideo.com"],"福建":["cn-fjfz-fx-01-01.bilivideo.com","cn-fjfz-fx-01-02.bilivideo.com","cn-fjfz-fx-01-03.bilivideo.com","cn-fjfz-fx-01-04.bilivideo.com","cn-fjfz-fx-01-05.bilivideo.com","cn-fjfz-fx-01-06.bilivideo.com","cn-fjqz-cm-01-01.bilivideo.com","cn-fjqz-cm-01-02.bilivideo.com","cn-fjqz-cm-01-03.bilivideo.com","cn-fjqz-cm-01-04.bilivideo.com","cn-fjqz-cm-01-05.bilivideo.com","cn-fjqz-cm-01-06.bilivideo.com","cn-fjqz-cm-01-07.bilivideo.com","cn-fjqz-cm-01-08.bilivideo.com","cn-fjqz-cm-01-09.bilivideo.com"],"辽宁":["cn-lndl-ct-01-01.bilivideo.com","cn-lndl-ct-01-04.bilivideo.com","cn-lnsy-cm-01-01.bilivideo.com","cn-lnsy-cm-01-02.bilivideo.com","cn-lnsy-cm-01-03.bilivideo.com","cn-lnsy-cm-01-04.bilivideo.com","cn-lnsy-cm-01-05.bilivideo.com","cn-lnsy-cm-01-06.bilivideo.com","cn-lnsy-cm-01-07.bilivideo.com","cn-lnsy-cm-01-08.bilivideo.com","cn-lnsy-cm-01-09.bilivideo.com","cn-lnsy-cu-01-01.bilivideo.com","cn-lnsy-cu-01-03.bilivideo.com","cn-lnsy-cu-01-04.bilivideo.com","cn-lnsy-cu-01-06.bilivideo.com","cn-lnsy-cu-01-07.bilivideo.com"],"重庆":["cn-cq-cm-01-01.bilivideo.com","cn-cq-cm-01-02.bilivideo.com","cn-cq-cm-01-04.bilivideo.com","cn-cq-ct-01-05.bilivideo.com","cn-cq-ct-01-16.bilivideo.com","cn-cq-ct-01-20.bilivideo.com","cn-cq-ct-01-24.bilivideo.com"],"陕西":["cn-sxxa-cm-01-01.bilivideo.com","cn-sxxa-cm-01-02.bilivideo.com","cn-sxxa-cm-01-03.bilivideo.com","cn-sxxa-cm-01-04.bilivideo.com","cn-sxxa-cm-01-05.bilivideo.com","cn-sxxa-cm-01-06.bilivideo.com","cn-sxxa-cm-01-08.bilivideo.com","cn-sxxa-cm-01-09.bilivideo.com","cn-sxxa-cm-01-11.bilivideo.com","cn-sxxa-cm-01-12.bilivideo.com","cn-sxxa-ct-03-01.bilivideo.com","cn-sxxa-ct-03-02.bilivideo.com","cn-sxxa-ct-03-03.bilivideo.com","cn-sxxa-ct-03-04.bilivideo.com","cn-sxxa-cu-02-01.bilivideo.com","cn-sxxa-cu-02-02.bilivideo.com"],"香港":["cn-hk-eq-01-01.bilivideo.com","cn-hk-eq-01-03.bilivideo.com","cn-hk-eq-01-06.bilivideo.com","cn-hk-eq-01-07.bilivideo.com","cn-hk-eq-01-08.bilivideo.com","cn-hk-eq-01-09.bilivideo.com","cn-hk-eq-01-10.bilivideo.com","cn-hk-eq-01-11.bilivideo.com","cn-hk-eq-01-12.bilivideo.com","cn-hk-eq-01-13.bilivideo.com","cn-hk-eq-01-14.bilivideo.com","cn-hk-eq-bcache-13.bilivideo.com"],"黑省":["cn-hljheb-cm-01-01.bilivideo.com","cn-hljheb-cm-01-03.bilivideo.com","cn-hljheb-ct-01-02.bilivideo.com","cn-hljheb-ct-01-03.bilivideo.com","cn-hljheb-ct-01-04.bilivideo.com","cn-hljheb-ct-01-07.bilivideo.com"]};
    const autoSnapshotAt = "2026-10-17T22:01:33Z";
    const autoCss = ":host{all:initial;font-family:Inter,-apple-system,BlinkMacSystemFont,\"Segoe UI\",\"Microsoft YaHei\",sans-serif;color-scheme:light;--bg:rgba(255,255,255,.97);--fg:#26333b;--muted:#87949e;--line:#e9edf1;--soft:#f4f7f9;--accent:#00a3b4;--shadow:0 14px 42px #152e4220}\n:host([data-theme=dark]){color-scheme:dark;--bg:rgba(31,34,38,.98);--fg:#e0e7ed;--muted:#8c97a2;--line:#ffffff12;--soft:#ffffff06;--accent:#65c7c9;--shadow:0 14px 42px #0005}\n.metrics{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:15px 0 12px}.metric{padding:11px 12px;background:var(--soft);border:1px solid var(--line);border-radius:10px}.metric>span{display:block;font-size:10px;letter-spacing:.3px;margin-bottom:3px}.metric strong{font-size:22px;font-weight:550;font-variant-numeric:tabular-nums;letter-spacing:-.6px}.metric small{color:var(--muted);font-size:10px;margin-left:5px}.settings-links{display:flex;justify-content:space-between;gap:10px;margin:12px 0 2px}.settings-links a{font-size:10px;color:var(--muted);text-decoration:none}.settings-links a:hover{color:var(--accent)}\n.node-choices{display:grid;gap:7px;margin-top:10px}.node-option{display:flex;align-items:center;gap:8px;border:1px solid var(--line);border-radius:8px;padding:9px 8px;cursor:pointer;transition:border-color .15s}.node-option:hover,.node-option:has(input:checked){border-color:var(--accent)}.node-option:has(input:checked){background:color-mix(in srgb,var(--accent) 7%,transparent)}.node-option input{margin:0;accent-color:var(--accent);flex:none}.node-rank{font-size:10px;color:var(--muted);font-variant-numeric:tabular-nums}.node-details{display:grid;min-width:0;gap:3px}.node-details strong{font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.node-metrics{color:var(--muted);font-size:10px;font-variant-numeric:tabular-nums}\n*{box-sizing:border-box}button,input,a{font:inherit}button{cursor:pointer;border:1px solid var(--line);background:var(--soft);color:var(--fg);border-radius:8px;padding:7px 10px;font-size:12px}button:hover{border-color:var(--accent)}button:focus-visible,a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:3px}[hidden]{display:none!important}\n.badge{position:fixed;z-index:10001;display:flex;align-items:center;gap:9px;height:26px;width:196px;justify-content:center;padding:0 9px;background:var(--soft);border:1px solid var(--line);border-radius:8px;color:var(--muted);font-size:11px;font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap;backdrop-filter:blur(12px);transition:color .2s,border-color .2s}.badge:hover{color:var(--fg)}.ping{border-left:1px solid var(--line);padding-left:9px}.dot{width:5px;height:5px;flex:none;border-radius:50%;background:#56afaa}.warning{background:#d8a557}.working{animation:breathe 1.5s infinite}.panel{position:fixed;z-index:10002;width:352px;max-width:calc(100vw - 16px);max-height:calc(100vh - 32px);overflow:auto;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:15px;box-shadow:var(--shadow);font-size:12px;line-height:1.6;backdrop-filter:blur(20px)}.header{display:flex;justify-content:space-between;align-items:center;padding:13px 17px;border-bottom:1px solid var(--line);letter-spacing:.2px}.header strong{font-size:13px;font-weight:600}.close{border:0;background:none;font-size:19px;color:var(--muted);padding:0 4px}.content{padding:13px 17px 15px}.row{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:7px 0}.value{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:205px;font-variant-numeric:tabular-nums;text-align:right}.muted{color:var(--muted)}p{margin:8px 0}.status{font-size:12px;color:var(--accent);margin-top:14px}.reason{color:#bf9757;font-size:11px}.proposal{border:1px solid var(--line);border-radius:11px;background:var(--soft);padding:12px;margin:12px 0}.eyebrow{display:block;font-size:10px;color:var(--accent);letter-spacing:1px;margin-bottom:6px}.proposal strong{font-size:12px;overflow-wrap:anywhere}.proposal p{font-size:11px}.actions{display:flex;gap:7px;align-items:center;flex-wrap:wrap;margin-top:12px}.primary{background:var(--accent);color:#fff;border-color:transparent}.actions a{color:var(--muted);text-decoration:none;font-size:11px;margin-left:auto}.actions a:hover{color:var(--accent)}details{border-top:1px solid var(--line);margin-top:16px;padding-top:12px}summary{cursor:pointer;color:var(--muted);font-size:11px}form{display:grid;gap:9px;padding:13px 0 3px}form label{display:flex;align-items:center;justify-content:space-between;color:var(--muted)}input[type=number]{width:83px;padding:5px 7px;background:var(--soft);color:var(--fg);border:1px solid var(--line);border-radius:6px}input[type=checkbox]{accent-color:var(--accent)}.footnote{font-size:10px;color:var(--muted);white-space:pre-line;margin-top:13px;line-height:1.7}@keyframes breathe{50%{opacity:.3}}@media(prefers-reduced-motion:reduce){.working{animation:none}}\n";
    const autoRawXHR = unsafeWindow.XMLHttpRequest;
    const autoRawFetch = unsafeWindow.fetch.bind(unsafeWindow);
    const autoMetricsToken = 'ccb-auto-' + Math.random().toString(36).slice(2);
    let autoController = null;
    const readAutoOverride = () => {
        if (!autoCore.identity(location.href)) return null;
        try {
            const selected = JSON.parse(sessionStorage.getItem('CCB_AUTO_active_v1'));
            if (!selected || Date.now() - selected.at > 86400000 || selected.at > Date.now()) return null;
            const cached = GM_getValue('CCB_AUTO_repo_v1', null);
            const list = cached && cached.url === api + '/cdn.json' && Date.now() - cached.at < 7 * 86400000
                ? autoCore.nodes(cached.data) : autoCore.nodes(autoSnapshot);
            return list.find(node => node.host === selected.host) || null;
        } catch (_) { return null; }
    };
    const connectAutoWorker = worker => {
        if (!autoController || !autoController.isVideoContext() || !unsafeWindow.MessageChannel) return worker;
        try {
            const channel = new unsafeWindow.MessageChannel();
            channel.port1.onmessage = event => autoController.ingestMetric(event.data);
            channel.port1.start();
            worker.addEventListener('error', () => channel.port1.close(), {once: true});
            worker.postMessage({ccbAutoMetrics: autoMetricsToken}, [channel.port2]);
        } catch (_) {}
        return worker;
    };

    const api = 'https://raw.githubusercontent.com/Kanda-Akihito-Kun/ccb/main/data'
    const defaultCdnNode = '使用默认源'
    const manualRegionName = '手动输入'
    const mainHost = 'www.bilibili.com'
    const liveHost = 'live.bilibili.com'

    const oldCdnNodeStored = 'CCB'
    const oldRegionStored = 'region'
    const mainCdnNodeStored = 'CCB_main'
    const mainRegionStored = 'region_main'
    const diagnosticsCdnNodeStored = 'CCB_diagnostics'
    const diagnosticsRegionStored = 'region_diagnostics'
    const liveCdnNodeStored = 'CCB_live'
    const liveRegionStored = 'region_live'
    const powerModeStored = 'powerMode'
    const liveModeStored = 'liveMode'
    // 两份缓存分开存,避免多标签页同时写同一个键时互相覆盖
    const regionCacheStored = 'CCB_datacache_region'
    const cdnCacheStored = 'CCB_datacache_cdn'
    // 多标签页共用同一份统计,靠 frameId 分键和 60 秒新鲜度窗口限制串扰
    const statsStored = 'CCB_stats'

    const logger = ((...args) => {
        console.warn('[CCB]', ...args)
    })

    const UNSET = '__CCB_UNSET__'
    const normalizeRegion = (v) => {
        if (!v) return manualRegionName
        if (v === '编辑') return manualRegionName
        return v
    }
    const migrateStoredValues = () => {
        const oldNode = GM_getValue(oldCdnNodeStored, UNSET)
        const oldRegion = GM_getValue(oldRegionStored, UNSET)
        if (oldNode !== UNSET) {
            if (GM_getValue(mainCdnNodeStored, UNSET) === UNSET) GM_setValue(mainCdnNodeStored, oldNode)
            if (GM_getValue(diagnosticsCdnNodeStored, UNSET) === UNSET) GM_setValue(diagnosticsCdnNodeStored, oldNode)
            if (GM_getValue(liveCdnNodeStored, UNSET) === UNSET) GM_setValue(liveCdnNodeStored, oldNode)
        }
        if (oldRegion !== UNSET) {
            const normalized = normalizeRegion(oldRegion)
            if (GM_getValue(mainRegionStored, UNSET) === UNSET) GM_setValue(mainRegionStored, normalized)
            if (GM_getValue(diagnosticsRegionStored, UNSET) === UNSET) GM_setValue(diagnosticsRegionStored, normalized)
            if (GM_getValue(liveRegionStored, UNSET) === UNSET) GM_setValue(liveRegionStored, normalized)
        }
    }
    migrateStoredValues()

    const isLiveContext = () => location.host === liveHost
    const isDiagnosticsContext = () => location.host === mainHost && (location.pathname || '').startsWith('/blackboard/video-diagnostics.html')
    const getContextKey = () => {
        if (isLiveContext()) return 'live'
        if (isDiagnosticsContext()) return 'diagnostics'
        return 'main'
    }

    let ccbConfigCache = null
    let workerPreludeCache = null
    let workerPreludeContextKey = null

    const invalidateCcbCaches = () => {
        ccbConfigCache = null
        workerPreludeCache = null
        workerPreludeContextKey = null
    }
    // 别的标签页改设置不会通知本文档,切回本页或前进后退时丢弃缓存,下次取值重新读存储
    try {
        document.addEventListener('visibilitychange', invalidateCcbCaches)
        window.addEventListener('pageshow', invalidateCcbCaches)
    } catch (_) {}

    const getTargetCdnNode = (ctx) => {
        if (ctx === void 0) return getCcbConfig().node
        if (ctx === 'main') { const selected = readAutoOverride(); if (selected) return selected.host; }
        const stored = ctx === 'live' ? liveCdnNodeStored : (ctx === 'diagnostics' ? diagnosticsCdnNodeStored : mainCdnNodeStored)
        const value = GM_getValue(stored, UNSET)
        return value === UNSET ? GM_getValue(oldCdnNodeStored, defaultCdnNode) : value
    }
    const getRegion = (ctx) => {
        if (ctx === void 0) return getCcbConfig().region
        if (ctx === 'main') { const selected = readAutoOverride(); if (selected) return selected.region; }
        const stored = ctx === 'live' ? liveRegionStored : (ctx === 'diagnostics' ? diagnosticsRegionStored : mainRegionStored)
        const value = GM_getValue(stored, UNSET)
        return normalizeRegion(value === UNSET ? GM_getValue(oldRegionStored, manualRegionName) : value)
    }
    const setTargetCdnNode = (ctx, value) => {
        if (ctx === 'main') { try { sessionStorage.removeItem('CCB_AUTO_active_v1'); } catch (_) {} }
        const result = GM_setValue(
            ctx === 'live' ? liveCdnNodeStored : (ctx === 'diagnostics' ? diagnosticsCdnNodeStored : mainCdnNodeStored),
            value,
        )
        invalidateCcbCaches()
        return result
    }
    const setRegion = (ctx, value) => {
        const result = GM_setValue(
            ctx === 'live' ? liveRegionStored : (ctx === 'diagnostics' ? diagnosticsRegionStored : mainRegionStored),
            value,
        )
        invalidateCcbCaches()
        return result
    }
    const getPowerMode = () => getCcbConfig().powerMode
    const getLiveMode = () => getCcbConfig().liveMode

    function getCcbConfig() {
        const contextKey = getContextKey()
        if (ccbConfigCache && ccbConfigCache.contextKey === contextKey) return ccbConfigCache

        const storedNode = getTargetCdnNode(contextKey)
        // 存储被写坏时退回默认源，避免后续字符串操作抛错
        const node = typeof storedNode === 'string' ? storedNode : defaultCdnNode
        const region = getRegion(contextKey)
        const powerMode = GM_getValue(powerModeStored, true)
        const liveMode = GM_getValue(liveModeStored, false)
        let replacement = node
        if (replacement.indexOf('://') === -1) replacement = 'https://' + replacement
        if (!replacement.endsWith('/')) replacement = replacement + '/'
        const replacementNoSlash = replacement.endsWith('/') ? replacement.slice(0, -1) : replacement
        let replacementHost
        try {
            replacementHost = new URL(replacement).host
        } catch (_) {
            replacementHost = ''
        }
        ccbConfigCache = { contextKey, node, region, powerMode, liveMode, replacement, replacementNoSlash, replacementHost }
        return ccbConfigCache
    }

    const isCcbEnabled = () => getCcbConfig().node !== defaultCdnNode
    const hasMediaDomain = (s) => typeof s === 'string' && (
        s.indexOf('bilivideo.') !== -1
        || s.indexOf('acgvideo.') !== -1
        || s.indexOf('edge.mountaintoys.cn') !== -1
        || s.indexOf('akamaized.net') !== -1
    )

    const isLiveRoomPage = () => {
        if (location.host !== liveHost) return false
        const p = location.pathname || '/'
        return /^\/\d+\/?$/.test(p) || /^\/blanc\/\d+\/?$/.test(p)
    }

    const shouldApplyReplacement = () => {
        const config = getCcbConfig()
        if (config.node === defaultCdnNode) return false
        if (location.host === liveHost) {
            if (!isLiveRoomPage()) return false
            if (!config.liveMode) return false
        }
        return true
    }

    const shouldInstallWorkerHooks = () => {
        if (autoController && autoController.isVideoContext()) return true;
        if (!shouldApplyReplacement()) return false
        const host = location.host
        const pathname = location.pathname || '/'
        if (host === mainHost) {
            return pathname.startsWith('/bangumi/play/')
                || pathname.startsWith('/video/')
                || pathname.startsWith('/cheese/play/')
        }
        if (host === liveHost) return isLiveRoomPage()
        return false
    }

    const getReplacement = () => getCcbConfig().replacement

    const getReplacementNoSlash = () => getCcbConfig().replacementNoSlash

    const getReplacementHost = () => getCcbConfig().replacementHost

    const statsFreshMs = 60000
    const statsFlushMs = 2000
    const isTopFrame = window.top === window
    const ccbFrameId = Math.random().toString(36).slice(2)
    // 只统计页面框架内的改写,Worker 运行时内部的改写没有回传通道,不计入
    const ccbRewriteStats = { host: null, count: 0 }
    let statsFlushTimer = null

    // malformed 表示存储里是坏值,调用方负责把重置后的空对象写回
    const readStatsStore = () => {
        let store
        try {
            store = GM_getValue(statsStored, {})
            if (typeof store === 'string') store = JSON.parse(store)
        } catch (_) {
            return { store: {}, malformed: true }
        }
        if (!store || typeof store !== 'object' || Array.isArray(store)) return { store: {}, malformed: true }
        return { store, malformed: false }
    }

    // 删掉坏值、过期以及时间戳来自未来的条目,返回是否改动过 store
    const pruneStatsStore = (store, now) => {
        let pruned = false
        for (const key in store) {
            if (!Object.prototype.hasOwnProperty.call(store, key)) continue
            const entry = store[key]
            const ts = entry && typeof entry === 'object' ? entry.ts : NaN
            if (!Number.isFinite(ts) || now - ts > statsFreshMs || now - ts < 0) {
                delete store[key]
                pruned = true
            }
        }
        return pruned
    }

    const flushRewriteStats = () => {
        statsFlushTimer = null
        try {
            const now = Date.now()
            const { store } = readStatsStore()
            // 每次回写都顺手清理,否则关掉的框架会一直留在存储里
            pruneStatsStore(store, now)
            store[ccbFrameId] = { host: ccbRewriteStats.host, count: ccbRewriteStats.count, ts: now }
            GM_setValue(statsStored, store)
        } catch (_) {}
    }

    // 改写路径上只累加内存计数,写存储由一次性定时器合并
    const countRewrite = (before, after) => {
        if (after === before) return after
        ccbRewriteStats.count++
        ccbRewriteStats.host = getReplacementHost() || ccbRewriteStats.host
        if (!isTopFrame && !statsFlushTimer) statsFlushTimer = setTimeout(flushRewriteStats, statsFlushMs)
        return after
    }

    const readAggregateStats = () => {
        const now = Date.now()
        const { store, malformed } = readStatsStore()
        const pruned = pruneStatsStore(store, now) || malformed
        let count = ccbRewriteStats.count
        let freshestTs = 0
        let freshestHost = ''
        for (const key in store) {
            if (!Object.prototype.hasOwnProperty.call(store, key)) continue
            const entry = store[key]
            if (Number.isFinite(entry.count)) count += entry.count
            if (entry.ts >= freshestTs && typeof entry.host === 'string' && entry.host) {
                freshestTs = entry.ts
                freshestHost = entry.host
            }
        }
        if (pruned) {
            try { GM_setValue(statsStored, store) } catch (_) {}
        }
        return { count, host: ccbRewriteStats.host || freshestHost }
    }

    const IGNORE_HOST_RE = /^(?:bvc|data|pbp|api|api\w+)\./
    const HOST_EXTRACT_RE = /^(?:https?:)?\/\/([\w.-]+)|^([\w.-]+)(?:\/|$)/i
    function isIgnoredHost(s) {
        const m = HOST_EXTRACT_RE.exec(s)
        const host = m && (m[1] || m[2])
        return !!host && IGNORE_HOST_RE.test(host.toLowerCase())
    }

    const replaceMediaUrlCore = (s) => {
        let out = s
        if (s.startsWith('http://') || s.startsWith('https://')) out = s.replace(/^https?:\/\/.*?\//, getReplacement())
        else if (s.startsWith('//')) out = s.replace(/^\/\/.*?\//, getReplacement().replace(/^https?:/, ''))
        else if (/^[^/]+\//.test(s)) out = s.replace(/^[^/]+\//, `${getReplacementHost()}/`)
        return countRewrite(s, out)
    }

    const replaceMediaUrlUnchecked = (s) => {
        if (isIgnoredHost(s)) return s
        return replaceMediaUrlCore(s)
    }

    const replaceMediaUrl = (s) => {
        if (typeof s !== 'string') return s
        if (!shouldApplyReplacement()) return s
        if (!hasMediaDomain(s)) return s

        if (isIgnoredHost(s)) return s
        return replaceMediaUrlCore(s)
    }

    const replaceMediaHostValueCore = (s) => {
        let out = s
        if (s.startsWith('http://') || s.startsWith('https://')) out = getReplacementNoSlash()
        else if (s.startsWith('//')) out = getReplacementNoSlash().replace(/^https?:/, '')
        else if (/^[^/]+$/.test(s)) out = getReplacementHost()
        return countRewrite(s, out)
    }

    const replaceMediaHostValueUnchecked = (s) => {
        if (isIgnoredHost(s)) return s
        return replaceMediaHostValueCore(s)
    }

    const replaceMediaHostValue = (s) => {
        if (typeof s !== 'string') return s
        if (!shouldApplyReplacement()) return s
        if (!hasMediaDomain(s)) return s

        if (isIgnoredHost(s)) return s
        return replaceMediaHostValueCore(s)
    }

    const deepReplacePlayInfo = (obj) => {
        if (!obj || typeof obj !== 'object') return
        if (Array.isArray(obj)) {
            for (let i = 0; i < obj.length; i++) {
                const item = obj[i]
                if (typeof item === 'string') {
                    const out = hasMediaDomain(item) ? replaceMediaUrlUnchecked(item) : item
                    if (out !== item) obj[i] = out
                } else {
                    deepReplacePlayInfo(item)
                }
            }
            return
        }
        for (const k in obj) {
            if (!Object.prototype.hasOwnProperty.call(obj, k)) continue
            const v = obj[k]
            if (typeof v === 'string') {
                if (k === 'host') {
                    if (hasMediaDomain(v)) obj[k] = replaceMediaHostValueUnchecked(v)
                } else {
                    if (hasMediaDomain(v)) obj[k] = replaceMediaUrlUnchecked(v)
                }
            } else if (Array.isArray(v) && k === 'backup_url') {
                if (!getPowerMode()) continue
                for (let i = 0; i < v.length; i++) {
                    const s = v[i]
                    if (typeof s === 'string') {
                        if (hasMediaDomain(s)) v[i] = replaceMediaUrlUnchecked(s)
                    }
                    else deepReplacePlayInfo(s)
                }
            } else if (typeof v === 'object') {
                deepReplacePlayInfo(v)
            }
        }
    }

    const transformPlayUrlResponse = (playInfo) => {
        if (!shouldApplyReplacement()) return
        if (!playInfo || typeof playInfo !== 'object') return
        if (playInfo.code !== (void 0) && playInfo.code !== 0) return
        deepReplacePlayInfo(playInfo)
    }

    const transformLiveNeptune = (obj) => {
        if (!obj || typeof obj !== 'object') return
        if (!getReplacementHost()) return

        const playurl =
            (obj && obj.roomInitRes && obj.roomInitRes.data && obj.roomInitRes.data.playurl_info && obj.roomInitRes.data.playurl_info.playurl) ||
            (obj && obj.data && obj.data.playurl_info && obj.data.playurl_info.playurl) ||
            (obj && obj.result && obj.result.playurl_info && obj.result.playurl_info.playurl) ||
            (obj && obj.playurl_info && obj.playurl_info.playurl)
        if (!playurl || typeof playurl !== 'object') return

        const streams = playurl.stream
        if (!Array.isArray(streams)) return
        for (let si = 0; si < streams.length; si++) {
            const s = streams[si]
            const formats = s && s.format
            if (!Array.isArray(formats)) continue
            for (let fi = 0; fi < formats.length; fi++) {
                const f = formats[fi]
                const codecs = f && f.codec
                if (!Array.isArray(codecs)) continue
                for (let ci = 0; ci < codecs.length; ci++) {
                    const c = codecs[ci]
                    const infos = c && c.url_info
                    if (!Array.isArray(infos)) continue
                    for (let ii = 0; ii < infos.length; ii++) {
                        const info = infos[ii]
                        if (info && typeof info.host === 'string') info.host = replaceMediaHostValue(info.host)
                    }
                }
            }
        }
    }

    const replaceBilivideoInText = (text) => {
        if (!shouldApplyReplacement()) return text
        if (typeof text !== 'string') return text
        if (text.indexOf('bilivideo.') === -1
            && text.indexOf('acgvideo.') === -1
            && text.indexOf('edge.mountaintoys.cn') === -1
            && text.indexOf('akamaized.net') === -1
        ) return text
        const out = text.replace(/https?:\/\/[^"'\s]*?\.(?:(?:bilivideo|acgvideo)\.(?:com|cn)|edge\.mountaintoys\.cn|akamaized\.net)\//g, getReplacement())
        const host = getReplacementHost()
        if (!host) return out
        return out.replace(/\b[\w.-]+\.(?:(?:bilivideo|acgvideo)\.(?:com|cn)|edge\.mountaintoys\.cn|akamaized\.net)\b/g, host)
    }

    const installCcbWorkerRuntime = (cfg) => {
        const forceReplace = !!(cfg && cfg.forceReplace)
        const shouldApply = () => forceReplace
        const Replacement = (cfg && typeof cfg.replacement === 'string') ? cfg.replacement : ''
        const replacementHost = (cfg && typeof cfg.replacementHost === 'string') ? cfg.replacementHost : ''
        const getHost = () => replacementHost
        const IGNORE_HOST_RE = /^(?:bvc|data|pbp|api|api\w+)\./
        const HOST_EXTRACT_RE = /^(?:https?:)?\/\/([\w.-]+)|^([\w.-]+)(?:\/|$)/i
        function isIgnoredHost(s) {
            const m = HOST_EXTRACT_RE.exec(s)
            const host = m && (m[1] || m[2])
            return !!host && IGNORE_HOST_RE.test(host.toLowerCase())
        }
        const hasMedia = (s) => typeof s === 'string' && (
            s.indexOf('bilivideo.') !== -1
            || s.indexOf('acgvideo.') !== -1
            || s.indexOf('edge.mountaintoys.cn') !== -1
            || s.indexOf('akamaized.net') !== -1
        )

        const replaceUrl = (s) => {
            if (typeof s !== 'string') return s
            if (!shouldApply()) return s
            if (!hasMedia(s)) return s
            if (isIgnoredHost(s)) return s
            if (s.startsWith('http://') || s.startsWith('https://')) return s.replace(/^https?:\/\/.*?\//, Replacement)
            if (s.startsWith('//')) return s.replace(/^\/\/.*?\//, Replacement.replace(/^https?:/, ''))
            if (/^[^/]+\//.test(s)) return s.replace(/^[^/]+\//, `${getHost()}/`)
            return s
        }

        const Ofetch = self.fetch
        if (Ofetch) {
            self.fetch = (input, init) => {
                try {
                    const s = typeof input === 'string' ? input : (input && input.url)
                    if (typeof s === 'string') {
                        const r = replaceUrl(s)
                        if (r !== s) {
                            if (typeof input === 'string') input = r
                            else {
                                const Req = self.Request || Request
                                if (Req) input = new Req(r, input)
                            }
                        }
                    }
                } catch (_) {}
                return Ofetch(input, init)
            }
        }

        if (self.XMLHttpRequest) {
            const OX = self.XMLHttpRequest
            class X extends OX {
                open(...args) {
                    try {
                        if (typeof args[1] === 'string') args[1] = replaceUrl(args[1])
                    } catch (_) {}
                    return super.open(...args)
                }
            }
            self.XMLHttpRequest = X
        }
    }

    const buildWorkerPrelude = () => {
        const contextKey = getContextKey()
        if (workerPreludeCache && workerPreludeContextKey === contextKey) return workerPreludeCache

        const cfg = {
            forceReplace: shouldApplyReplacement(),
            replacement: getReplacement(),
            replacementHost: getReplacementHost(),
        }
        const metrics = autoController && autoController.isVideoContext() ?
            `let autoPort = null;
              self.addEventListener('message', event => {
                if (event.data && event.data.ccbAutoMetrics === ${JSON.stringify(autoMetricsToken)} && event.ports[0]) {
                  event.stopImmediatePropagation(); autoPort = event.ports[0]; autoPort.start();
                }
              });
              (${installCcbAutoTelemetry.toString()})(self, metric => { if (autoPort) autoPort.postMessage(metric); });` : '';
        const runtime = metrics + `(${installCcbWorkerRuntime.toString()})(${JSON.stringify(cfg)});`;
        workerPreludeContextKey = contextKey
        workerPreludeCache = `(() => {\n` +
            `  if (self.__CCB_WORKER_PRELUDE__) return;\n` +
            `  self.__CCB_WORKER_PRELUDE__ = true;\n` +
            `  try { ${runtime} } catch (_) {}\n` +
            `})();\n`
        return workerPreludeCache
    }

    const xhrMemoUnset = {}

    if (window.top === window && autoCore.identity(location.href)) {
        autoController = createCcbAuto({core: autoCore, snapshot: autoSnapshot, snapshotAt: autoSnapshotAt,
            css: autoCss, RawXHR: autoRawXHR, rawFetch: autoRawFetch, gmRequest: GM_xmlhttpRequest,
            getValue: GM_getValue, setValue: GM_setValue, registerMenu: GM_registerMenuCommand,
            getNode: () => getTargetCdnNode('main')});
        installCcbAutoTelemetry(unsafeWindow, metric => autoController.ingestMetric(metric));
    }
    const interceptNetResponse = (theWindow => {
        const interceptors = []
        const register = (handler) => interceptors.push(handler)

        const handle = (response, url, meta) => interceptors.reduce((modified, h) => {
            const ret = h(modified, url, meta)
            return ret ? ret : modified
        }, response)

        const hookWindow = (w) => {
            try {
                if (!w || !w.XMLHttpRequest || !w.fetch) return false
                const hooked = w.__CCB_NET_HOOKED__
                if (hooked && hooked.xhr === w.XMLHttpRequest && hooked.fetch === w.fetch) return true

                const OX = w.XMLHttpRequest
                class XHR extends OX {
                    open(...args) {
                        this._ccbIntercept = false
                        this._ccbResponseMemo = xhrMemoUnset
                        this._ccbResponseTextMemo = xhrMemoUnset
                        try {
                            if (typeof args[1] === 'string') args[1] = replaceMediaUrl(args[1])
                            this._ccbIntercept = !!handle(null, args[1], { type: 'xhr', xhr: this })
                        } catch (_) {}
                        return super.open(...args)
                    }
                    get responseText() {
                        if (!this._ccbIntercept || this.readyState !== this.DONE) return super.responseText
                        if (this._ccbResponseTextMemo !== xhrMemoUnset) return this._ccbResponseTextMemo
                        const value = handle(super.responseText, this.responseURL, { type: 'xhr', xhr: this })
                        this._ccbResponseTextMemo = value
                        return value
                    }
                    get response() {
                        if (!this._ccbIntercept || this.readyState !== this.DONE) return super.response
                        // responseType 为 '' 或 'text' 时 response 就是 responseText,复用同一份缓存避免重复处理
                        const rt = this.responseType
                        if (rt === '' || rt === 'text') return this.responseText
                        if (this._ccbResponseMemo !== xhrMemoUnset) return this._ccbResponseMemo
                        const value = handle(super.response, this.responseURL, { type: 'xhr', xhr: this })
                        this._ccbResponseMemo = value
                        return value
                    }
                }
                w.XMLHttpRequest = XHR

                const Ofetch = w.fetch
                w.fetch = (input, init) => {
                    const s0 = typeof input === 'string' ? input : (input && input.url)
                    if (typeof s0 === 'string') {
                        const r = replaceMediaUrl(s0)
                        if (r !== s0) {
                            if (typeof input === 'string') input = r
                            else input = new (w.Request || Request)(r, input)
                        }
                    }

                    const s = typeof input === 'string' ? input : (input && input.url)
                    const shouldIntercept = handle(null, s, { type: 'fetch', input, init })
                    if (!shouldIntercept) return Ofetch(input, init)
                    return Ofetch(input, init).then(resp => {
                        // 老引擎没有 Response.body 属性,不能把"属性缺失"当成"空响应体"
                        if (('body' in resp && !resp.body) || resp.status === 204 || resp.status === 205 || resp.status === 304) return resp
                        return resp.text().then(text => {
                            let out = text
                            try {
                                out = handle(text, s, { type: 'fetch', input, init, response: resp })
                            } catch (e) {
                                logger('处理响应失败:', e)
                            }
                            // 重建响应会让原来的 content-length 失真,url/redirected 也会丢失,尽量补回
                            let headers = resp.headers
                            try { headers = new (w.Headers || Headers)(resp.headers); headers.delete('content-length') } catch (_) {}
                            const next = new (w.Response || Response)(out, { status: resp.status, statusText: resp.statusText, headers })
                            try {
                                Object.defineProperty(next, 'url', { value: resp.url, configurable: true })
                                Object.defineProperty(next, 'redirected', { value: resp.redirected, configurable: true })
                            } catch (_) {}
                            return next
                        })
                    })
                }

                try {
                    const bHooked = w.__CCB_BLOB_HOOKED__
                    if (w.Blob && (!bHooked || bHooked !== w.Blob)) {
                        const OBlob = w.Blob
                        w.Blob = function (parts, options) {
                            if (!shouldInstallWorkerHooks()) return new OBlob(parts, options)
                            const type = options && options.type ? String(options.type) : ''
                            const looksJs = /javascript/i.test(type)
                                || (Array.isArray(parts) && parts.some(p => typeof p === 'string' && /importScripts|WorkerGlobalScope|bili/i.test(p)))
                            if (looksJs) {
                                const injected = [buildWorkerPrelude(), ...(Array.isArray(parts) ? parts : [parts])]
                                return new OBlob(injected, options)
                            }

                            return new OBlob(parts, options)
                        }
                        w.__CCB_BLOB_HOOKED__ = w.Blob
                    }
                } catch (_) {}

                try {
                    const wHooked = w.__CCB_WORKER_WRAPPED__
                    if (w.Worker && (!wHooked || wHooked !== w.Worker)) {
                        const OWorker = w.Worker
                        w.Worker = function (scriptURL, options) {
                            try {
                                if (!shouldInstallWorkerHooks()) return new OWorker(scriptURL, options)
                                const raw = (typeof scriptURL === 'string') ? scriptURL : String(scriptURL)
                                const isModule = options && options.type === 'module'
                                const wrapperCode = isModule
                                    ? `${buildWorkerPrelude()}\nimport ${JSON.stringify(raw)};\n`
                                    : `${buildWorkerPrelude()}\nimportScripts(${JSON.stringify(raw)});\n`
                                const blob = new w.Blob([wrapperCode], { type: 'application/javascript' })
                                const url = w.URL.createObjectURL(blob)
                                return connectAutoWorker(new OWorker(url, options))
                            } catch (_) {
                                return new OWorker(scriptURL, options)
                            }
                        }
                        w.__CCB_WORKER_WRAPPED__ = w.Worker
                    }
                } catch (_) {}

                w.__CCB_NET_HOOKED__ = { xhr: w.XMLHttpRequest, fetch: w.fetch }
                return true
            } catch (_) {
                return false
            }
        }

        hookWindow(theWindow)
        register._hookWindow = hookWindow
        return register
    })(unsafeWindow)

    const PLAYURL_PATH_RE = /(?:\/x\/player\/wbi\/playurl|\/x\/player\/playurl|\/pgc\/player\/web\/playurl|\/pgc\/player\/web\/v2\/playurl|\/pgc\/player\/api\/playurl|\/pugv\/player\/web\/playurl|\/ogv\/player\/playview)/

    interceptNetResponse((response, url) => {
        const u = typeof url === 'string' ? url : (url && url.url) || String(url)
        if (!PLAYURL_PATH_RE.test(u)) return
        if (!isCcbEnabled() && !autoController) return
        if (response === null) return true

        try {
            if (typeof response === 'string') {
                const obj = JSON.parse(response)
                if (autoController) autoController.observePlayInfo(obj, u)
                transformPlayUrlResponse(obj)
                return JSON.stringify(obj)
            }
            if (response && typeof response === 'object') {
                if (autoController) autoController.observePlayInfo(response, u)
                transformPlayUrlResponse(response)
                return response
            }
        } catch (e) {
            logger('处理 playurl 失败:', e)
        }
    })

    interceptNetResponse((response, url) => {
        if (!isCcbEnabled()) return
        const config = getCcbConfig()
        if (!config.liveMode) return
        const raw = typeof url === 'string' ? url : (url && url.url) || ''
        let u
        try { u = new URL(raw || String(url), location.href) } catch (_) { return }
        const p = u.pathname || ''
        if (!(/\/xlive\/web-room\/v\d+\/index\/getRoomPlayInfo\/?$/.test(p) || /\/room\/v1\/Room\/playUrl\/?$/.test(p))) return
        if (response === null) return true
        if (!isLiveRoomPage()) return
        try {
            const obj = typeof response === 'string' ? JSON.parse(response) : response
            transformLiveNeptune(obj)
            return (typeof response === 'string') ? JSON.stringify(obj) : obj
        } catch (e) {
            logger('处理直播 playurl 失败:', e)
        }
    })

    interceptNetResponse((response, url) => {
        if (!isCcbEnabled()) return
        const config = getCcbConfig()
        if (!config.liveMode) return
        const u = typeof url === 'string' ? url : (url && url.url) || String(url)
        if (!u.includes('/xlive/play-gateway/master/url')) return
        if (response === null) return true
        return replaceBilivideoInText(response)
    })

    const installLiveBootstrapHooks = () => {
        if (!getLiveMode() || !isLiveRoomPage() || !isCcbEnabled()) return
        const seen = new WeakSet()
        const tryRewrite = (obj) => {
            if (!obj || typeof obj !== 'object') return
            if (seen.has(obj)) return
            seen.add(obj)
            transformLiveNeptune(obj)
        }
        try {
            const propName = '__NEPTUNE_IS_MY_WAIFU__'
            let internal = unsafeWindow[propName]
            if (internal && typeof internal === 'object') tryRewrite(internal)
            Object.defineProperty(unsafeWindow, propName, {
                configurable: true,
                get: () => internal,
                set: (v) => {
                    internal = v
                    if (v && typeof v === 'object') tryRewrite(v)
                }
            })
        } catch (e) {
            logger('直播首播 Hook 安装失败:', String(e))
        }
    }

    installLiveBootstrapHooks()

    const watchGlobal = (name, handler) => {
        try {
            if (unsafeWindow[name] && typeof unsafeWindow[name] === 'object') handler(unsafeWindow[name])
            let internal = unsafeWindow[name]
            Object.defineProperty(unsafeWindow, name, {
                configurable: true,
                get: () => internal,
                set: (v) => {
                    internal = v
                    if (v && typeof v === 'object') handler(v)
                }
            })
        } catch (_) {}
    }

    watchGlobal('__playinfo__', (obj) => {
        if (autoController) autoController.observePlayInfo(obj)
        if (!isCcbEnabled()) return
        try { transformPlayUrlResponse(obj) } catch (_) {}
    })
    watchGlobal('__INITIAL_STATE__', (obj) => {
        if (!isCcbEnabled()) return
        try { transformPlayUrlResponse(obj) } catch (_) {}
    })

    const createButton = (text, primary, second) => {
        const btn = document.createElement('button')
        btn.textContent = text
        btn.style.cssText = [
            'border:0',
            'border-radius:8px',
            'padding:8px 10px',
            'cursor:pointer',
            'color:#fff',
            `background:${primary ? '#2b74ff' : (second ? '#1bc543ff' : '#444')}`,
        ].join(';')
        return btn
    }

    let regionList = [manualRegionName]
    let cdnDataCache = null

    // CDN 数据必须是 { 地区: 节点数组 },任一地区值不是数组就整体作废
    const isCdnData = (data) => !!data
        && typeof data === 'object'
        && !Array.isArray(data)
        && Object.values(data).every(Array.isArray)

    const readStoredEntry = (key, isData) => {
        let entry
        try {
            entry = GM_getValue(key, null)
            if (typeof entry === 'string') entry = JSON.parse(entry)
        } catch (_) {
            return null
        }
        const ok = entry
            && typeof entry === 'object'
            && !Array.isArray(entry)
            && Number.isFinite(entry.fetchedAt)
            && isData(entry.data)
        return ok ? entry : null
    }

    const getStoredDataCache = () => ({
        region: readStoredEntry(regionCacheStored, data => Array.isArray(data) && data.every(v => typeof v === 'string')),
        cdn: readStoredEntry(cdnCacheStored, isCdnData),
    })

    const getRegionOptions = (regions) => [manualRegionName, ...regions.filter(v => v && v !== manualRegionName && v !== '编辑')]

    const loadDataCache = () => {
        const dataCache = getStoredDataCache()
        regionList = dataCache.region ? getRegionOptions(dataCache.region.data) : [manualRegionName]
        cdnDataCache = dataCache.cdn ? dataCache.cdn.data : null
        return dataCache
    }

    const storeRegionData = (data) => {
        GM_setValue(regionCacheStored, { data, fetchedAt: Date.now() })
    }

    const storeCdnData = (data) => {
        GM_setValue(cdnCacheStored, { data, fetchedAt: Date.now() })
    }

    const requestText = (url) => new Promise((resolve, reject) => {
        const fetchFallback = () => fetch(url).then(r => r.text()).then(resolve, reject)
        try {
            if (typeof GM_xmlhttpRequest === 'function') {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url,
                    onload: (res) => {
                        const ok = res && typeof res.status === 'number' ? (res.status >= 200 && res.status < 300) : true
                        if (!ok) fetchFallback()
                        else resolve(res.responseText || '')
                    },
                    onerror: fetchFallback,
                    ontimeout: fetchFallback,
                })
                return
            }
        } catch (_) {}
        fetchFallback()
    })

    const requestJson = async (url) => JSON.parse(await requestText(url))

    const appendOption = (parent, value) => {
        const opt = document.createElement('option')
        opt.value = value
        opt.textContent = value
        parent.appendChild(opt)
    }

    // 优先恢复已保存的选择,其次沿用当前选中项,都不在列表里时显式回落,不依赖浏览器的隐式首项
    const applySelectValue = (selectEl, values, preferred, current, fallback) => {
        if (!values.length) return
        if (values.includes(preferred)) selectEl.value = preferred
        else if (values.includes(current)) selectEl.value = current
        else selectEl.value = values.includes(fallback) ? fallback : values[0]
    }

    const renderRegionOptions = (selectEl, regions, preferred) => {
        const current = selectEl.value
        selectEl.textContent = ''
        for (const v of regions) appendOption(selectEl, v)
        applySelectValue(selectEl, regions, preferred, current)
    }

    const CDN_NODE_RE = /^cn-([a-z0-9]+)-([a-z0-9]+)-/
    // 只有这三个是运营商缩写,其余 token 原样展示
    const ispLabelMap = { cm: '移动', ct: '电信', cu: '联通' }

    // 仅用于下拉框展示分组,不改变节点列表本身
    const groupCdnNodes = (list) => {
        const groups = []
        const byLabel = new Map()
        const ungrouped = []
        for (const node of list) {
            const m = typeof node === 'string' ? CDN_NODE_RE.exec(node) : null
            if (!m) {
                ungrouped.push(node)
                continue
            }
            const label = `${m[1]} · ${ispLabelMap[m[2]] || m[2]}`
            let group = byLabel.get(label)
            if (!group) {
                group = { label, nodes: [] }
                byLabel.set(label, group)
                groups.push(group)
            }
            group.nodes.push(node)
        }
        // 未分组项含列表首项(使用默认源)时置顶,否则置尾
        if (ungrouped.length) {
            const bucket = { label: null, nodes: ungrouped }
            if (ungrouped[0] === list[0]) groups.unshift(bucket)
            else groups.push(bucket)
        }
        return groups
    }

    const renderNodeOptions = (selectEl, nodes, preferred) => {
        const current = selectEl.value
        selectEl.textContent = ''
        for (const group of groupCdnNodes(nodes)) {
            if (!group.label) {
                for (const v of group.nodes) appendOption(selectEl, v)
                continue
            }
            const optgroup = document.createElement('optgroup')
            optgroup.label = group.label
            for (const v of group.nodes) appendOption(optgroup, v)
            selectEl.appendChild(optgroup)
        }
        applySelectValue(selectEl, nodes, preferred, current, defaultCdnNode)
    }

    // onSuccess 放在 try 外,避免重绘异常被当成请求失败吞掉
    const getRegionList = async (onSuccess) => {
        let ok = false
        try {
            const data = await requestJson(`${api}/region.json`)
            if (!Array.isArray(data)) return
            const regions = data.filter(v => typeof v === 'string')
            regionList = getRegionOptions(regions)
            storeRegionData(regions)
            ok = true
        } catch (_) {}
        if (ok && onSuccess) onSuccess()
    }

    const getCdnData = async (onSuccess) => {
        let ok = false
        try {
            const data = await requestJson(`${api}/cdn.json`)
            if (!isCdnData(data)) throw new TypeError('无效 CDN 数据')
            cdnDataCache = data
            storeCdnData(data)
            ok = true
        } catch (_) {
            if (!cdnDataCache) cdnDataCache = {}
        }
        if (ok && onSuccess) onSuccess()
    }

    const getCdnListByRegion = (region) => {
        if (region === manualRegionName || region === '编辑') return [defaultCdnNode]
        const data = cdnDataCache || {}
        const regionData = Array.isArray(data[region]) ? data[region].filter(v => typeof v === 'string') : []
        return [defaultCdnNode, ...regionData]
    }

    // 首次打开需要等待网络,期间再次触发菜单会重复插入面板,用标记挡住并发调用
    let panelOpening = false
    // 请求可能一直不回调,等待设上限,超时后先渲染,迟到的响应仍由后台重绘补上
    const panelDataWaitMs = 8000

    const openPanel = async () => {
        const existing = document.querySelector('#ccb-settings-panel')
        if (existing) {
            existing.remove()
            return
        }
        if (panelOpening) return
        panelOpening = true

        let root = null
        const panelControls = []
        try {
            const dataCache = loadDataCache()
            const isPanelOpen = () => root && root.isConnected
            const rerenderRegions = () => {
                if (!isPanelOpen()) return
                for (const controls of panelControls) controls.renderRegions()
            }
            const rerenderNodes = () => {
                if (!isPanelOpen()) return
                for (const controls of panelControls) controls.renderNodes()
            }
            const regionRequest = getRegionList(rerenderRegions)
            const cdnRequest = getCdnData(rerenderNodes)
            // 只等待本地没有存档的资源,已有存档的先渲染再后台刷新
            const pending = []
            if (!dataCache.region) pending.push(regionRequest)
            if (!dataCache.cdn) pending.push(cdnRequest)
            if (pending.length) await Promise.race([
                Promise.all(pending),
                new Promise(resolve => setTimeout(resolve, panelDataWaitMs)),
            ])
        } finally {
            panelOpening = false
        }

        root = document.createElement('div')
        root.id = 'ccb-settings-panel'
        root.style.cssText = [
            'position:fixed',
            'z-index:2147483647',
            'right:18px',
            'top:18px',
            'width:360px',
            'max-width:calc(100vw - 36px)',
            'max-height:calc(100vh - 36px)',
            'overflow:auto',
            'background:rgba(20,20,20,.96)',
            'border:1px solid #333',
            'border-radius:10px',
            'box-shadow:0 8px 24px rgba(0,0,0,.35)',
            'color:#fff',
            'font-size:12px',
            'font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,"PingFang SC","Microsoft YaHei",sans-serif',
        ].join(';')

        const header = document.createElement('div')
        header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border-bottom:1px solid #2f2f2f'
        const title = document.createElement('div')
        title.textContent = 'CCB 设置'
        title.style.cssText = 'font-weight:700;font-size:13px'
        const closeBtn = createButton('关闭', false, false)
        closeBtn.addEventListener('click', () => { try { root.remove() } catch (_) {} })
        header.appendChild(title)
        header.appendChild(closeBtn)
        root.appendChild(header)

        const body = document.createElement('div')
        body.style.cssText = 'padding:12px'
        root.appendChild(body)

        const mkRow = (labelText) => {
            const row = document.createElement('div')
            row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;margin:10px 0'
            const label = document.createElement('div')
            label.textContent = labelText
            label.style.cssText = 'color:#bbb'
            row.appendChild(label)
            return { row, label }
        }

        const mkSectionTitle = (text) => {
            const t = document.createElement('div')
            t.textContent = text
            t.style.cssText = 'font-weight:700;font-size:12px;margin:2px 0 8px;color:#e5e5e5'
            return t
        }

        const mkSectionBox = () => {
            const box = document.createElement('div')
            box.style.cssText = 'border:1px solid #2f2f2f;border-radius:10px;padding:10px;margin:10px 0;background:rgba(0,0,0,.12)'
            return box
        }

        const mkSelect = (options, value, renderOptions) => {
            const sel = document.createElement('select')
            sel.style.cssText = 'flex:1;background:#111;color:#fff;border:1px solid #333;border-radius:8px;padding:8px'
            renderOptions(sel, options, value)
            return sel
        }

        const mkInput = (value) => {
            const inp = document.createElement('input')
            inp.type = 'text'
            inp.placeholder = '输入节点域名或URL'
            inp.style.cssText = 'flex:1;background:#111;color:#fff;border:1px solid #333;border-radius:8px;padding:8px;outline:none'
            inp.value = value || ''
            return inp
        }

        const mountRegionAndNode = (ctx, hostBox) => {
            const region = getRegion(ctx)
            let nodeValue = getTargetCdnNode(ctx)
            let nodeSelect = null
            let nodeInput = null

            const { row: regionRow } = mkRow('地区')
            const regionSelect = mkSelect(regionList, region, renderRegionOptions)
            regionRow.appendChild(regionSelect)
            hostBox.appendChild(regionRow)

            const { row: nodeRow } = mkRow('节点')
            hostBox.appendChild(nodeRow)

            const clearRowControl = () => {
                if (nodeSelect) nodeValue = nodeSelect.value
                while (nodeRow.childNodes.length > 1) nodeRow.removeChild(nodeRow.lastChild)
                nodeSelect = null
                nodeInput = null
            }

            // 已保存的节点不在列表里时补进选项,保证显示与存储一致(不写入存储)
            const withStoredNode = (list, stored) => (stored && typeof stored === 'string' && !list.includes(stored))
                ? [...list, stored]
                : list

            // persist 仅在用户操作时为 true,后台刷新重绘不写入存储
            const renderNodeControl = (regionValue, persist) => {
                const stored = getTargetCdnNode(ctx)
                if (regionValue === manualRegionName) {
                    if (nodeInput) return
                    clearRowControl()
                    const inp = mkInput(stored === defaultCdnNode ? '' : stored)
                    nodeInput = inp
                    nodeRow.appendChild(inp)
                    inp.addEventListener('input', () => {
                        const v = inp.value.trim()
                        nodeValue = v ? v : defaultCdnNode
                        setTargetCdnNode(ctx, nodeValue)
                    })
                    return
                }

                const list = getCdnListByRegion(regionValue)
                // 用户切换地区时按列表回落并写入,其余场景只如实展示已保存的节点
                const options = persist ? list : withStoredNode(list, stored)
                if (nodeSelect) {
                    renderNodeOptions(nodeSelect, options, stored)
                    nodeValue = nodeSelect.value
                    if (persist) setTargetCdnNode(ctx, nodeValue)
                    return
                }
                clearRowControl()
                const sel = mkSelect(options, options.includes(stored) ? stored : defaultCdnNode, renderNodeOptions)
                nodeSelect = sel
                nodeValue = sel.value
                nodeRow.appendChild(sel)
                sel.addEventListener('change', () => {
                    nodeValue = sel.value
                    setTargetCdnNode(ctx, nodeValue)
                })
                if (persist) setTargetCdnNode(ctx, nodeValue)
            }

            renderNodeControl(regionSelect.value, false)
            regionSelect.addEventListener('change', () => {
                const next = regionSelect.value
                setRegion(ctx, next)
                renderNodeControl(next, true)
            })
            panelControls.push({
                renderRegions: () => {
                    renderRegionOptions(regionSelect, regionList, getRegion(ctx))
                    renderNodeControl(regionSelect.value, false)
                },
                renderNodes: () => { renderNodeControl(regionSelect.value, false) },
            })
        }

        const stats = readAggregateStats()
        const statsLine = document.createElement('div')
        statsLine.style.cssText = 'color:#9c9;margin:0 0 8px'
        statsLine.textContent = stats.host
            ? `已改写 ${stats.count} 个媒体请求 → ${stats.host}`
            : `已改写 ${stats.count} 个媒体请求`
        body.appendChild(statsLine)

        const mainBox = mkSectionBox()
        mainBox.appendChild(mkSectionTitle('视频 | 课堂 | 番剧(需特殊设置)'))
        body.appendChild(mainBox)
        mountRegionAndNode('main', mainBox)

        const liveBox = mkSectionBox()
        liveBox.appendChild(mkSectionTitle('直播'))
        body.appendChild(liveBox)
        mountRegionAndNode('live', liveBox)

        const diagnosticsBox = mkSectionBox()
        diagnosticsBox.appendChild(mkSectionTitle('测速'))
        body.appendChild(diagnosticsBox)
        mountRegionAndNode('diagnostics', diagnosticsBox)

        const actions = document.createElement('div')
        actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:12px'
        const powerBtn = createButton(getPowerMode() ? '强力替换模式：ON' : '强力替换模式：OFF', true, false)
        powerBtn.addEventListener('click', () => {
            const next = !getPowerMode()
            GM_setValue(powerModeStored, next)
            invalidateCcbCaches()
            powerBtn.textContent = next ? '强力替换模式：ON' : '强力替换模式：OFF'
        })
        const liveBtn = createButton(getLiveMode() ? '适用直播和番剧：ON' : '适用直播和番剧：OFF', true, false)
        liveBtn.addEventListener('click', () => {
            const next = !getLiveMode()
            GM_setValue(liveModeStored, next)
            invalidateCcbCaches()
            liveBtn.textContent = next ? '适用直播和番剧：ON' : '适用直播和番剧：OFF'
        })
        const applyBtn = createButton('应用并刷新', false, true)
        applyBtn.addEventListener('click', () => { location.reload() })
        actions.appendChild(powerBtn)
        actions.appendChild(liveBtn)
        actions.appendChild(applyBtn)
        body.appendChild(actions)

        document.documentElement.appendChild(root)
    }

    if (window.top === window) {
        const stripNodeSuffix = (s) => String(s).replace(/(?:\.bilivideo\.(?:com|cn)|\.edge\.mountaintoys\.cn)$/i, '')
        const mainNodeName = stripNodeSuffix(getTargetCdnNode('main'))
        const diagnosticsNodeName = stripNodeSuffix(getTargetCdnNode('diagnostics'))
        const liveNodeName = stripNodeSuffix(getTargetCdnNode('live'))
        GM_registerMenuCommand(`📺CCB (${mainNodeName} | ${liveNodeName} | ${diagnosticsNodeName})`, () => { openPanel() })
        GM_registerMenuCommand('阅读文档 | 建议反馈 | 版本回退', () => { window.open('https://github.com/Kanda-Akihito-Kun/ccb') })
    }

    logger('CCB 加载完成', { host: location.host, path: location.pathname })
})()
