const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
// vendor/ccb.js is CCB 2.1.0 (upstream commit 2534fd08) kept here as is; only its node data still comes from upstream (data/).
let source = read('vendor/ccb.js');
const upstreamHash = crypto.createHash('sha256').update(source).digest('hex');
source = source.replace(/\r\n/g, '\n');
function replace(before, after) {
    if (source.split(before).length !== 2) throw new Error('Expected exactly one anchor: ' + before.slice(0, 100));
    source = source.replace(before, after);
}
// Swaps everything from `start` up to (not including) `end` for `after`; both markers must be unique.
function replaceBlock(start, end, after) {
    const from = source.indexOf(start), to = source.indexOf(end, from);
    if (from < 0 || source.indexOf(start, from + 1) >= 0 || to < 0 || source.split(end).length !== 2) throw new Error('Expected one block: ' + start.slice(0, 100));
    source = source.slice(0, from) + after + source.slice(to);
}
replace('// @name         Custom CDN of Bilibili (CCB) - 修改哔哩哔哩的网页视频、直播、番剧的播放源', '// @name         驿程 - B 站香港／海外节点优选');
replace('// @description  Custom CDN of Bilibili (CCB)', '// @description  每几个视频检查延迟与吞吐，香港/海外节点优选，批准刷新后应用，标题旁显示加载状态');
replace('// @version      2.1.0', '// @version      2.4.1');
replace('// @author       鼠鼠今天吃嘉然', '// @author       Simohara');
replace('// @namespace    CCB', '// @namespace    bili-waypoint');
// Pasted installs update from the published copy too, not only installs made from the link.
replace('// @run-at       document-start', '// @run-at       document-start\n// @downloadURL  https://raw.githubusercontent.com/Simohara/bili-waypoint/main/dist/yicheng.user.js\n// @updateURL    https://raw.githubusercontent.com/Simohara/bili-waypoint/main/dist/yicheng.user.js');
replace('// @match        https://www.bilibili.com/video/*', '// @match        https://www.bilibili.com/video/*\n// @match        https://www.bilibili.com/*/video/*');
replace('// @connect      kanda-akihito-kun.github.io', '// @connect      kanda-akihito-kun.github.io\n// @connect      raw.githubusercontent.com');
replace('// @grant        GM_xmlhttpRequest', '// @require      https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js\n// @grant        GM_xmlhttpRequest');
replace("const api = 'https://kanda-akihito-kun.github.io/ccb/api'", "const api = 'https://raw.githubusercontent.com/Kanda-Akihito-Kun/ccb/main/data'");
const snapshot = JSON.parse(read('data/cdn.json'));
const snapshotAt = JSON.parse(read('data/info.json')).lastSuccessTime;
const regions = JSON.parse(read('data/region.json'));
const additions = ['auto-core.js', 'telemetry.js', 'stall-watcher.js', 'worker-base.js', 'auto-runtime.js'].map(file => read('src/' + file)).join('\n\n');
const early = `
    // Original author: 鼠鼠今天吃嘉然. CCB Auto additions: MIT, 2026.
    ${additions}
    const autoCore = createCcbAutoCore();
    const autoSnapshot = ${JSON.stringify(snapshot)};
    const autoSnapshotAt = ${JSON.stringify(snapshotAt)};
    const autoRegions = ${JSON.stringify(regions)};
    const autoCss = ${JSON.stringify(read('src/widget.css'))};
    const autoRawXHR = unsafeWindow.XMLHttpRequest;
    const autoRawFetch = unsafeWindow.fetch.bind(unsafeWindow);
    const autoMetricsToken = 'ccb-auto-' + Math.random().toString(36).slice(2);
    let autoController = null;
    // blob: URL -> its Blob until revoked, so a Worker can be started from the Blob after the page revokes the URL.
    const autoBlobUrls = new Map();
    const readAutoOverride = () => {
        if (!autoCore.identity(location.href)) return null;
        try {
            const selected = GM_getValue('CCB_AUTO_active_v1', null);
            if (!selected || Date.now() - selected.at > 86400000 || selected.at > Date.now()) return null;
            const cached = GM_getValue('CCB_AUTO_repo_v1', null);
            const list = cached && cached.url === api + '/cdn.json' && Date.now() - cached.at < 7 * 86400000
                ? autoCore.nodes(cached.data) : autoCore.nodes(autoSnapshot);
            return list.find(node => node.host === selected.host) || null;
        } catch (_) { return null; }
    };
    // GM storage spans tabs and origins: an approved node applies to every open tab, and a manual pick on any page (including live) clears it.
    const clearAutoOverride = () => { try { GM_setValue('CCB_AUTO_active_v1', null); } catch (_) {} };
    // Natives taken at document-start, so a page that later wraps postMessage never sees the private handshake.
    const AutoMessageChannel = unsafeWindow.MessageChannel, autoPostMessage = unsafeWindow.Worker && unsafeWindow.Worker.prototype.postMessage;
    // Module Workers get no metrics channel: with the default source they stay native, and Bilibili starts none.
    const connectAutoWorker = (worker, module) => {
        if (module || !autoController || !autoController.isVideoContext() || !AutoMessageChannel || !autoPostMessage) return worker;
        try {
            const channel = new AutoMessageChannel();
            channel.port1.onmessage = event => autoController.ingestMetric(event.data);
            channel.port1.start();
            worker.addEventListener('error', () => channel.port1.close(), {once: true});
            autoPostMessage.call(worker, {ccbAutoMetrics: autoMetricsToken}, [channel.port2]);
        } catch (_) {}
        return worker;
    };
`;
replace(';(() => {', ';(() => {\n' + early);
replace('if (self.__CCB_WORKER_PRELUDE__) return;', "if (typeof self === 'undefined' || self.__CCB_WORKER_PRELUDE__) return;");
replace("const stored = ctx === 'live' ? liveCdnNodeStored", "if (ctx === 'main') { const selected = readAutoOverride(); if (selected) return selected.host; }\n        const stored = ctx === 'live' ? liveCdnNodeStored");
replace("const stored = ctx === 'live' ? liveRegionStored", "if (ctx === 'main') { const selected = readAutoOverride(); if (selected) return selected.region; }\n        const stored = ctx === 'live' ? liveRegionStored");
replace('const setTargetCdnNode = (ctx, value) => {', "const setTargetCdnNode = (ctx, value) => {\n        if (ctx === 'main') { const selected = readAutoOverride(); if (selected) GM_setValue(mainRegionStored, selected.region); clearAutoOverride(); }");
// The panel shows the automatic node as saved; a region switch must fall back to the user's real saved node.
replace('const setRegion = (ctx, value) => {', "const setRegion = (ctx, value) => {\n        if (ctx === 'main') clearAutoOverride();");
// Without cache and with the data source unreachable, the manual panel lists the bundled repository snapshot.
replace('regionList = dataCache.region ? getRegionOptions(dataCache.region.data) : [manualRegionName]', 'regionList = dataCache.region ? getRegionOptions(dataCache.region.data) : getRegionOptions(autoRegions)');
replace('cdnDataCache = dataCache.cdn ? dataCache.cdn.data : null', 'cdnDataCache = dataCache.cdn ? dataCache.cdn.data : autoSnapshot');
replace('const shouldInstallWorkerHooks = () => {', 'const shouldInstallWorkerHooks = () => {\n        if (autoController && autoController.isVideoContext()) return true;');
// The listener stays inert until a handshake arrives, so a prelude cached before an SPA move back to /video/ still catches it.
replace('const runtime = `(${installCcbWorkerRuntime.toString()})(${JSON.stringify(cfg)});`', `const metrics = autoController ?
            \`let autoPort = null;
              self.addEventListener('message', event => {
                if (event.data && event.data.ccbAutoMetrics === \${JSON.stringify(autoMetricsToken)} && event.ports[0]) {
                  event.stopImmediatePropagation(); autoPort = event.ports[0]; autoPort.start();
                }
              });
              (\${installCcbAutoTelemetry.toString()})(self, metric => { if (autoPort) autoPort.postMessage(metric); });\` : '';
        const runtime = metrics + \`(\${installCcbWorkerRuntime.toString()})(\${JSON.stringify(cfg)});\`;`);
replace('    const interceptNetResponse = (theWindow => {', `    if (window.top === window && autoCore.identity(location.href)) {
        autoController = createCcbAuto({core: autoCore, snapshot: autoSnapshot, snapshotAt: autoSnapshotAt,
            css: autoCss, RawXHR: autoRawXHR, rawFetch: autoRawFetch, gmRequest: GM_xmlhttpRequest,
            getValue: GM_getValue, setValue: GM_setValue, registerMenu: GM_registerMenuCommand,
            getNode: () => getTargetCdnNode('main')});
        installCcbAutoTelemetry(unsafeWindow, metric => autoController.ingestMetric(metric));
    }
    const interceptNetResponse = (theWindow => {`);
// Upstream rewrites the danmaku mask (upos-sz-staticcos-cmask) to the chosen node, where it 403s or 959s; keep it on its own host.
for (const pad of ['\n    ', '\n        ']) replace(pad + String.raw`const IGNORE_HOST_RE = /^(?:bvc|data|pbp|api|api\w+)\./`, pad + String.raw`const IGNORE_HOST_RE = /^(?:bvc|data|pbp|api|api\w+|upos-sz-staticcos-cmask)\./`);
// Upstream prepends the prelude to any new Blob that looks like JS (type or the words importScripts/bili), which
// corrupts data Blobs, and its Blob/Worker stand-ins break instanceof and subclassing. The prelude now goes in only
// when a Worker starts. A blob: Worker is rebuilt from its Blob (the page may revoke the URL right after new Worker());
// the page's code still runs as its own script, so "use strict", #!, line numbers and the file name survive. A URL
// Worker is wrapped with installCcbWorkerBase so its relative URLs and self.location still point at the script.
// shortcut: SharedWorker, Workers started inside Workers, and URL Worker scripts served with a non-JS MIME type (importScripts
// rejects them) get no prelude or fail; revokes made from Workers or iframes are not seen; a SyntaxError in a page blob reads
// "Failed to execute 'importScripts' …: <message>"; Function.prototype.toString(Worker) has no name. Bilibili hits none today.
replaceBlock('                try {\n                    const bHooked = w.__CCB_BLOB_HOOKED__', '\n                w.__CCB_NET_HOOKED__ = ', String.raw`                try {
                    if (w.URL && w.URL.createObjectURL && !w.__CCB_AUTO_URL_HOOKED__) {
                        const createUrl = w.URL.createObjectURL, revokeUrl = w.URL.revokeObjectURL
                        w.URL.createObjectURL = function createObjectURL(object) {
                            const url = createUrl.apply(w.URL, arguments)
                            if (w.Blob && object instanceof w.Blob) autoBlobUrls.set(url, object)
                            return url
                        }
                        w.URL.revokeObjectURL = function revokeObjectURL(url) {
                            if (arguments.length) autoBlobUrls.delete(String(url))
                            return revokeUrl.apply(w.URL, arguments)
                        }
                        // CCB's own Blobs and URLs use these, never whatever the page has wrapped since.
                        w.__CCB_AUTO_URL_HOOKED__ = { createUrl, revokeUrl, Blob: w.Blob }
                    }
                } catch (_) {}

                try {
                    const wHooked = w.__CCB_WORKER_WRAPPED__
                    if (w.Worker && (!wHooked || wHooked !== w.Worker)) {
                        const OWorker = w.Worker
                        // A Proxy keeps new.target (subclasses), name, length and the TypeError for a call without new.
                        w.Worker = new Proxy(OWorker, { construct(target, args, newTarget) {
                            const make = url => Reflect.construct(target, url === undefined ? args : [url, ...args.slice(1)], newTarget)
                            const native = w.__CCB_AUTO_URL_HOOKED__, made = [], quote = value => JSON.stringify(value)
                            const own = blob => { const url = native.createUrl.call(w.URL, blob); made.push(url); return url }
                            const drop = urls => urls.forEach(url => native.revokeUrl.call(w.URL, url))
                            let worker = null, module = false
                            try {
                                const options = args[1], replacing = shouldApplyReplacement()
                                module = !!(options && options.type === 'module')
                                const raw = native && args.length && shouldInstallWorkerHooks() ? new URL(String(args[0]), w.document.baseURI).href : 'data:'
                                const source = raw.startsWith('blob:') ? autoBlobUrls.get(raw.split('#')[0]) : null
                                // data: Workers keep their opaque origin, cross-origin URLs keep the native SecurityError, and
                                // default-source module Workers gain nothing (no metrics channel), so all of these stay native.
                                const wrap = raw.startsWith('blob:') ? !!source && (!module || replacing)
                                    : !raw.startsWith('data:') && replacing && new URL(raw).origin === w.location.origin
                                if (wrap) {
                                    const head = buildWorkerPrelude() + 'try { (' + installCcbWorkerBase.toString() + ')(' + quote(raw) + ') } catch (_) {}\n'
                                    // sourceURL keeps the page's own URL in error events and stacks of a classic copy.
                                    const entry = !source ? raw : own(module ? source : new native.Blob([source, '\n//# sourceURL=' + raw], { type: source.type }))
                                    let code
                                    if (module) {
                                        // Static imports run before the importing module's body, so the prelude has to be the first import.
                                        // shortcut: import.meta.url of a rebuilt blob: module is the revoked copy, so it cannot respawn itself.
                                        const first = own(new native.Blob([head, 'URL.revokeObjectURL(import.meta.url);' + (source ? 'URL.revokeObjectURL(' + quote(entry) + ');' : '') + '\n'], { type: 'text/javascript' }))
                                        code = 'import ' + quote(first) + ';\nimport ' + quote(entry) + ';\n'
                                    } else code = head + (source
                                        // revoke is bound before the page's script runs, which may declare its own global URL.
                                        ? '(revoke => { try { importScripts(' + quote(entry) + ') } finally { revoke(' + quote(entry) + ') } })(URL.revokeObjectURL.bind(URL));\n'
                                        : 'importScripts(' + quote(entry) + ');\n')
                                    worker = make(own(new native.Blob([code], { type: 'text/javascript' })))
                                }
                            } catch (_) {}
                            // The wrapper URL goes at once and a failed start drops every copy. The Worker revokes its copies once
                            // loaded; the timer covers one terminated early or a module graph that failed to load.
                            drop(made.slice(worker ? -1 : 0))
                            if (worker && made.length > 1) setTimeout(() => drop(made), 60000)
                            return worker ? connectAutoWorker(worker, module) : make()
                        } })
                        Object.defineProperty(OWorker.prototype, 'constructor', { value: w.Worker, writable: true, configurable: true })
                        w.__CCB_WORKER_WRAPPED__ = w.Worker
                    }
                } catch (_) {}
`);
// fetch() with no argument must reject as natively, not request the relative URL "undefined".
replace('            self.fetch = (input, init) => {', '            self.fetch = function (input, init) {\n                if (!arguments.length) return Ofetch()');
replace('                w.fetch = (input, init) => {', '                w.fetch = function (input, init) {\n                    if (!arguments.length) return Ofetch()');
replace(`    interceptNetResponse((response, url) => {
        if (!isCcbEnabled()) return
        const u = typeof url === 'string' ? url : (url && url.url) || String(url)
        if (!PLAYURL_PATH_RE.test(u)) return`, `    interceptNetResponse((response, url) => {
        const u = typeof url === 'string' ? url : (url && url.url) || String(url)
        if (!PLAYURL_PATH_RE.test(u)) return
        if (!isCcbEnabled() && !autoController) return`);
replace('                const obj = JSON.parse(response)\n                transformPlayUrlResponse(obj)', '                const obj = JSON.parse(response)\n                if (autoController) autoController.observePlayInfo(obj, u)\n                transformPlayUrlResponse(obj)');
replace("            if (response && typeof response === 'object') {\n                transformPlayUrlResponse(response)", "            if (response && typeof response === 'object') {\n                if (autoController) autoController.observePlayInfo(response, u)\n                transformPlayUrlResponse(response)");
replace("    watchGlobal('__playinfo__', (obj) => {", "    watchGlobal('__playinfo__', (obj) => {\n        if (autoController) autoController.observePlayInfo(obj)");
const out = path.join(root, 'dist'); fs.mkdirSync(out, {recursive: true});
fs.writeFileSync(path.join(out, 'yicheng.user.js'), source);
fs.writeFileSync(path.join(out, 'build-info.json'), JSON.stringify({forkedFrom: 'Kanda-Akihito-kun/ccb 2.1.0', upstreamCommit: '2534fd087338047a5938d12c9fe0448b4a9b2bf7', upstreamSha256: upstreamHash,
    snapshotAt, allowedRegions: ['香港', '海外'], scriptSha256: crypto.createHash('sha256').update(source).digest('hex')}, null, 2));
console.log('Built dist/yicheng.user.js (' + Buffer.byteLength(source) + ' bytes)');
