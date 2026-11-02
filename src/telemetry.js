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
