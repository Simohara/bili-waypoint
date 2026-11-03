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
            // Overseas visitors are redirected to a locale prefix such as /zh-Hans/video/.
            const u = new URL(url), match = /^\/(?:[a-z]{2}(?:-[A-Za-z]+)?\/)?video\/(BV[a-zA-Z0-9]{10})\/?$/.exec(u.pathname);
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
        const videos = dash && dash.video || [], tracks = videos.filter(t => t.id === 120 || t.width >= 3840 || t.height >= 2160);
        const video = Math.max(0, ...(tracks.length ? tracks : videos).map(t => Number(t.bandwidth) || 0));
        const audio = Math.max(0, ...(dash && dash.audio || []).map(t => Number(t.bandwidth) || 0));
        const need = (video + (video ? audio : 0)) * 1.3 / 1e6;
        // Without a 4K track the target only caps what the best returned track needs.
        return tracks.length || !need ? Math.max(floor, need) : Math.min(floor, need);
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
        if (Number.isFinite(result.mbps) && result.mbps < requiredMbps) output.push(`速度 ${result.mbps.toFixed(1)} Mbps < 目标 ${requiredMbps.toFixed(1)} Mbps`);
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
    // A stored timestamp from the future (system clock moved back) counts as "never".
    const since = (at, now) => at > now ? now : now - (at || 0);
    function due(session, config, now) {
        const cooldown = config.cooldownMinutes * 60000;
        // A scan that found nothing postpones periodic checks to three cooldowns.
        if (!config.enabled || since(session.lastCheckAt, now) < cooldown || since(session.missAt, now) < 3 * cooldown) return false;
        return session.views - (session.lastCheckViews || 0) >= config.everyVideos;
    }
    return {defaults, settings, host, nodes, identity, median, threshold, healthy, reasons, validateRange, since, due};
}
if (typeof module !== 'undefined' && module.exports) module.exports = createCcbAutoCore();
