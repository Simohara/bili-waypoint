/* Runs inside a Worker started from a CCB blob: wrapper, before the page's own script, so relative URLs and
   self.location resolve against the script the page asked for instead of the wrapper's blob: URL.
   shortcut: base is the requested URL, so a redirected Worker script resolves against its pre-redirect path, and
   Response.redirect / Cache API calls are not rebased; add them if Bilibili ever needs either. */
function installCcbWorkerBase(base) {
    // Taken now: the page's script may declare its own global URL or replace Request later.
    const NativeURL = self.URL, NativeRequest = self.Request;
    const abs = url => {
        // Like the native USVString conversion (a Symbol still throws); only a Request passes through as is.
        if (typeof url !== 'string' && !(NativeRequest && url instanceof NativeRequest)) url = `${url}`;
        if (typeof url !== 'string' || /^[a-z][a-z\d+.-]*:/i.test(url)) return url;
        try { return new NativeURL(url, base).href; } catch (_) { return url; }
    };
    try {
        // Patch the getters, not the object, so location stays the native WorkerLocation (keys, JSON, cloning).
        // Each one calls the native getter first, which keeps its "Illegal invocation" check.
        const parsed = new NativeURL(base), proto = self.WorkerLocation.prototype;
        for (const key of ['href', 'origin', 'protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash']) {
            const desc = Object.getOwnPropertyDescriptor(proto, key), get = desc.get;
            Object.defineProperty(proto, key, {...desc, get: Object.getOwnPropertyDescriptor({get [key]() { get.call(this); return parsed[key]; }}, key).get});
        }
        const desc = Object.getOwnPropertyDescriptor(proto, 'toString'), toString = desc.value;
        Object.defineProperty(proto, 'toString', {...desc, value: {toString() { toString.call(this); return parsed.href; }}.toString});
    } catch (_) {}
    if (self.importScripts) { const load = self.importScripts; self.importScripts = function importScripts(...urls) { return load(...urls.map(abs)); }; }
    // Argument counts are kept: fetch() must still throw, and open(method, url, undefined) would turn the request synchronous.
    if (self.fetch) { const get = self.fetch; self.fetch = function fetch(...args) { if (args.length) args[0] = abs(args[0]); return get(...args); }; }
    if (self.XMLHttpRequest) {
        const proto = self.XMLHttpRequest.prototype, nativeOpen = proto.open;
        proto.open = function open(...args) { if (args.length > 1) args[1] = abs(args[1]); return nativeOpen.apply(this, args); };
    }
    for (const name of ['Request', 'Worker', 'EventSource', 'WebSocket']) {
        if (!self[name]) continue;
        self[name] = new Proxy(self[name], {construct: (target, args, newTarget) =>
            Reflect.construct(target, args.length ? [abs(args[0]), ...args.slice(1)] : args, newTarget)});
        Object.defineProperty(self[name].prototype, 'constructor', {value: self[name], writable: true, configurable: true});
    }
}
