const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
let source = read('upstream/script/ccb.js');
const upstreamHash = crypto.createHash('sha256').update(source).digest('hex');
if (upstreamHash !== '7f45705f0ca079777fc87668b2b6c29f0a66f33be8bf007806796fc3e1aa7057') throw new Error('Upstream changed: review integration anchors before rebuilding');
source = source.replace(/\r\n/g, '\n');
function replace(before, after) {
    if (source.split(before).length !== 2) throw new Error('Expected exactly one anchor: ' + before.slice(0, 100));
    source = source.replace(before, after);
}
replace('// @name         Custom CDN of Bilibili (CCB) - 修改哔哩哔哩的网页视频、直播、番剧的播放源', '// @name         CCB Auto - 香港海外节点优选与网络状态');
replace('// @description  Custom CDN of Bilibili (CCB)', '// @description  每几个视频检查延迟与吞吐，香港/海外节点优选，批准刷新后应用，标题旁显示加载状态');
replace('// @version      2.1.0', '// @version      2.2.0-auto.3');
replace('// @namespace    CCB', '// @namespace    CCB-Auto');
replace('// @connect      kanda-akihito-kun.github.io', '// @connect      kanda-akihito-kun.github.io\n// @connect      raw.githubusercontent.com');
replace("const api = 'https://kanda-akihito-kun.github.io/ccb/api'", "const api = 'https://raw.githubusercontent.com/Kanda-Akihito-Kun/ccb/main/data'");
const snapshot = JSON.parse(read('upstream/data/cdn.json'));
const snapshotAt = JSON.parse(read('upstream/data/info.json')).lastSuccessTime;
const additions = ['auto-core.js', 'telemetry.js', 'stall-watcher.js', 'auto-runtime.js'].map(file => read('src/' + file)).join('\n\n');
const early = `
    // Original author: 鼠鼠今天吃嘉然. CCB Auto additions: MIT, 2026.
    ${additions}
    const autoCore = createCcbAutoCore();
    const autoSnapshot = ${JSON.stringify(snapshot)};
    const autoSnapshotAt = ${JSON.stringify(snapshotAt)};
    const autoCss = ${JSON.stringify(read('src/widget.css'))};
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
`;
replace(';(() => {', ';(() => {\n' + early);
replace("const stored = ctx === 'live' ? liveCdnNodeStored", "if (ctx === 'main') { const selected = readAutoOverride(); if (selected) return selected.host; }\n        const stored = ctx === 'live' ? liveCdnNodeStored");
replace("const stored = ctx === 'live' ? liveRegionStored", "if (ctx === 'main') { const selected = readAutoOverride(); if (selected) return selected.region; }\n        const stored = ctx === 'live' ? liveRegionStored");
replace('const setTargetCdnNode = (ctx, value) => {', "const setTargetCdnNode = (ctx, value) => {\n        if (ctx === 'main') { try { sessionStorage.removeItem('CCB_AUTO_active_v1'); } catch (_) {} }");
replace('const shouldInstallWorkerHooks = () => {', 'const shouldInstallWorkerHooks = () => {\n        if (autoController && autoController.isVideoContext()) return true;');
replace('const runtime = `(${installCcbWorkerRuntime.toString()})(${JSON.stringify(cfg)});`', `const metrics = autoController && autoController.isVideoContext() ?
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
replace("                                if (raw.startsWith('blob:') || raw.startsWith('data:')) return new OWorker(scriptURL, options)\n", '');
replace('return new OWorker(url, options)', 'return connectAutoWorker(new OWorker(url, options))');
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
fs.writeFileSync(path.join(out, 'ccb-auto.user.js'), source);
fs.copyFileSync(path.join(root, 'upstream/LICENSE'), path.join(out, 'LICENSE'));
fs.writeFileSync(path.join(out, 'build-info.json'), JSON.stringify({upstreamCommit: '2534fd087338047a5938d12c9fe0448b4a9b2bf7', upstreamSha256: upstreamHash,
    snapshotAt, allowedRegions: ['香港', '海外'], scriptSha256: crypto.createHash('sha256').update(source).digest('hex')}, null, 2));
console.log('Built dist/ccb-auto.user.js (' + Buffer.byteLength(source) + ' bytes)');
