/** @typedef {string | number | boolean | null | unknown[] | Record<string, unknown>} Value */
/** @typedef {{key: string, value: AnyValue}} KeyValue */
/** @typedef {{stringValue?: string, boolValue?: boolean, intValue?: string, doubleValue?: number, arrayValue?: {values: AnyValue[]}, kvlistValue?: {values: KeyValue[]}}} AnyValue */
/** @typedef {{now: () => number, fetch: typeof fetch, beacon: (url: string, data: Blob) => boolean, hidden: () => boolean, timeout: () => AbortSignal}} Environment */
/** @typedef {{logsEndpoint: string, tracesEndpoint?: string, resource?: Record<string, unknown>, scope?: {name: string, version?: string}}} Options */
/** @typedef {{kind: 'accepted' | 'queued' | 'rejected' | 'unavailable', status?: number}} Delivery */

const PAYLOAD_BYTES_MAX = 60 * 1024;

/**
 * Encodes bounded JSON values as OTLP AnyValue without recursive traversal.
 * @param {unknown} value
 * @returns {AnyValue}
 */
export function anyValue(value) {
    const result = /** @type {AnyValue} */ ({});
    const pending = [{ value, target: result, depth: 0 }];
    for (let index = 0; index < pending.length; index += 1) {
        if (pending.length > 4096)
            throw new RangeError("Too many telemetry values");
        const item = pending[index];
        const target = /** @type {AnyValue} */ (item.target);
        const value = item.value;
        if (item.depth > 8) throw new RangeError("Telemetry value is too deep");
        if (value === null || value === undefined) continue;
        if (typeof value === "string") {
            if (value.length > 8192)
                throw new RangeError("Telemetry string is too long");
            target.stringValue = value;
        } else if (typeof value === "boolean") target.boolValue = value;
        else if (typeof value === "number") {
            if (!Number.isFinite(value))
                throw new TypeError("Invalid telemetry number");
            if (Number.isSafeInteger(value)) target.intValue = String(value);
            else target.doubleValue = value;
        } else if (Array.isArray(value)) {
            if (value.length > 64)
                throw new RangeError("Telemetry array is too long");
            const values = value.map(() => ({}));
            target.arrayValue = { values };
            value.forEach((entry, index) =>
                pending.push({
                    value: entry,
                    target: values[index],
                    depth: item.depth + 1,
                }),
            );
        } else if (typeof value === "object") {
            const entries = Object.entries(value).filter(
                ([, entry]) => entry !== undefined,
            );
            if (entries.length > 64)
                throw new RangeError("Too many telemetry fields");
            const values = entries.map(([key]) => {
                if (key.length > 256)
                    throw new RangeError("Telemetry key is too long");
                return { key, value: {} };
            });
            target.kvlistValue = { values };
            entries.forEach(([, entry], index) =>
                pending.push({
                    value: entry,
                    target: values[index].value,
                    depth: item.depth + 1,
                }),
            );
        } else throw new TypeError("Unsupported telemetry value");
    }
    return result;
}

/** @param {Record<string, unknown>} values @returns {Array<{key: string, value: AnyValue}>} */
export function attributes(values) {
    const encoded = anyValue(values);
    if (!encoded.kvlistValue) throw new TypeError("Attributes must be a map");
    return encoded.kvlistValue.values;
}

/** @param {Window} browser @returns {Environment} */
export function browserEnvironment(browser) {
    return {
        now: () => Date.now(),
        timeout: () => AbortSignal.timeout(5000),
        fetch: (input, init) => browser.fetch(input, init),
        beacon: (url, data) =>
            browser.navigator.sendBeacon?.(url, data) ?? false,
        hidden: () => browser.document.visibilityState === "hidden",
    };
}

/**
 * Creates an OTLP/HTTP JSON client. It does not collect identity or Datastar signals.
 * Delivery is best effort. A queued beacon is not a server acknowledgement.
 * @param {Options} options
 * @param {Environment} environment
 */
export function createTelemetry(options, environment) {
    if (!options.logsEndpoint)
        throw new TypeError("A logs endpoint is required");
    const resource = { attributes: attributes(options.resource ?? {}) };
    const scope = { ...(options.scope ?? { name: "datastar-telemetry" }) };
    let inFlight = 0;

    /** @param {string} endpoint @param {unknown} payload @returns {Promise<Delivery>} */
    async function deliver(endpoint, payload) {
        if (inFlight >= 8) return { kind: "rejected" };
        inFlight += 1;
        try {
            const body = JSON.stringify(payload);
            const blob = new Blob([body], { type: "application/json" });
            if (blob.size > PAYLOAD_BYTES_MAX) return { kind: "rejected" };
            if (environment.hidden()) {
                try {
                    if (environment.beacon(endpoint, blob))
                        return { kind: "queued" };
                } catch {}
            }
            const response = await environment.fetch(endpoint, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body,
                keepalive: true,
                signal: environment.timeout(),
            });
            if (response.status !== 200) {
                await response.body?.cancel().catch(() => {});
                return { kind: "rejected", status: response.status };
            }
            const declared = Number(
                response.headers.get("content-length") ?? 0,
            );
            if (declared > PAYLOAD_BYTES_MAX) {
                await response.body?.cancel().catch(() => {});
                return { kind: "rejected", status: response.status };
            }
            const reader = response.body?.getReader();
            if (!reader) return { kind: "rejected", status: response.status };
            const chunks = [];
            let length = 0;
            try {
                for (let count = 0; count < 1024; count += 1) {
                    const chunk = await reader.read();
                    if (chunk.done) break;
                    length += chunk.value.byteLength;
                    if (length > PAYLOAD_BYTES_MAX)
                        return { kind: "rejected", status: response.status };
                    chunks.push(chunk.value);
                    if (count === 1023)
                        return { kind: "rejected", status: response.status };
                }
            } finally {
                await reader.cancel().catch(() => {});
            }
            const bytes = new Uint8Array(length);
            let offset = 0;
            for (const chunk of chunks) {
                bytes.set(chunk, offset);
                offset += chunk.byteLength;
            }
            const result = JSON.parse(new TextDecoder().decode(bytes));
            if (!result || typeof result !== "object" || Array.isArray(result))
                return { kind: "rejected", status: response.status };
            const partial = result.partialSuccess;
            if (partial !== undefined) {
                if (
                    !partial ||
                    typeof partial !== "object" ||
                    Array.isArray(partial)
                )
                    return { kind: "rejected", status: response.status };
                const rejected =
                    partial.rejectedLogRecords ?? partial.rejectedSpans ?? 0;
                if (
                    !/^[0-9]{1,20}$/.test(String(rejected)) ||
                    BigInt(rejected) !== 0n
                )
                    return { kind: "rejected", status: response.status };
            }
            return { kind: "accepted", status: response.status };
        } catch {
            return { kind: "unavailable" };
        } finally {
            inFlight -= 1;
        }
    }

    /**
     * Emits a named event as an OTLP log record, retaining structured attributes and body.
     * @param {string} name
     * @param {Record<string, unknown>} [fields]
     * @param {unknown} [body]
     * @returns {Promise<Delivery>}
     */
    function event(name, fields = {}, body = null) {
        try {
            if (!name || name.length > 256)
                throw new TypeError("Invalid event name");
            const now = environment.now();
            if (!Number.isSafeInteger(now) || now < 0)
                throw new TypeError("Invalid timestamp");
            const time = String(BigInt(now) * 1000000n);
            if (BigInt(time) > 18446744073709551615n)
                throw new TypeError("Timestamp is out of range");
            return deliver(options.logsEndpoint, {
                resourceLogs: [
                    {
                        resource,
                        scopeLogs: [
                            {
                                scope,
                                logRecords: [
                                    {
                                        eventName: name,
                                        timeUnixNano: time,
                                        observedTimeUnixNano: time,
                                        severityNumber: 9,
                                        severityText: "INFO",
                                        attributes: attributes(fields),
                                        body: anyValue(body),
                                    },
                                ],
                            },
                        ],
                    },
                ],
            });
        } catch {
            return Promise.resolve(
                /** @type {Delivery} */ ({ kind: "rejected" }),
            );
        }
    }

    /**
     * Exports a manually instrumented OTLP span. Automatic browser instrumentation is not installed.
     * @param {{traceId: string, spanId: string, parentSpanId?: string, name: string, startTimeUnixNano: string, endTimeUnixNano: string, attributes?: Record<string, unknown>, kind?: number}} span
     * @returns {Promise<Delivery>}
     */
    function span(span) {
        try {
            if (!options.tracesEndpoint)
                throw new TypeError("A traces endpoint is required");
            if (
                !/^[a-f\d]{32}$/i.test(span.traceId) ||
                /^0+$/.test(span.traceId)
            )
                throw new TypeError("Invalid trace ID");
            if (!/^[a-f\d]{16}$/i.test(span.spanId) || /^0+$/.test(span.spanId))
                throw new TypeError("Invalid span ID");
            if (
                span.parentSpanId &&
                (!/^[a-f\d]{16}$/i.test(span.parentSpanId) ||
                    /^0+$/.test(span.parentSpanId))
            )
                throw new TypeError("Invalid parent span ID");
            if (!span.name || span.name.length > 256)
                throw new TypeError("Invalid span name");
            if (
                !/^\d{1,20}$/.test(span.startTimeUnixNano) ||
                !/^\d{1,20}$/.test(span.endTimeUnixNano)
            )
                throw new TypeError("Invalid span time");
            if (BigInt(span.endTimeUnixNano) < BigInt(span.startTimeUnixNano))
                throw new TypeError("Invalid span duration");
            if (BigInt(span.endTimeUnixNano) > 18446744073709551615n)
                throw new TypeError("Span time is out of range");
            const kind = span.kind ?? 1;
            if (!Number.isInteger(kind) || kind < 0 || kind > 5)
                throw new TypeError("Invalid span kind");
            return deliver(options.tracesEndpoint, {
                resourceSpans: [
                    {
                        resource,
                        scopeSpans: [
                            {
                                scope,
                                spans: [
                                    {
                                        ...span,
                                        kind,
                                        attributes: attributes(
                                            span.attributes ?? {},
                                        ),
                                    },
                                ],
                            },
                        ],
                    },
                ],
            });
        } catch {
            return Promise.resolve(
                /** @type {Delivery} */ ({ kind: "rejected" }),
            );
        }
    }
    return { event, span };
}
