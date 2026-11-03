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
    return {update, reset, dispose, ahead: () => video ? ahead() : 0};
}
