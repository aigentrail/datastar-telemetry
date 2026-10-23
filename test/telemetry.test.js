import { test } from "node:test";
import assert from "node:assert/strict";
import { createTelemetry, anyValue } from "../src/telemetry.js";

function setup() {
    const requests = [];
    const beacons = [];
    const environment = {
        now: () => 1782518400123,
        timeout: () => new AbortController().signal,
        hidden: () => false,
        beacon: (url, data) => {
            beacons.push({ url, data });
            return true;
        },
        fetch: async (url, init) => {
            requests.push({ url, init });
            return new Response("{}", { status: 200 });
        },
    };
    const client = createTelemetry(
        {
            logsEndpoint: "/v1/logs",
            tracesEndpoint: "/v1/traces",
            resource: { "service.name": "example" },
        },
        environment,
    );
    return { client, environment, requests, beacons };
}

test("encodes OTLP log records with exact nanosecond strings and structured bodies", async () => {
    const { client, requests } = setup();
    assert.deepEqual(
        await client.event(
            "checkout",
            { count: 3, enabled: true },
            { nested: ["a", 2, null] },
        ),
        { kind: "accepted", status: 200 },
    );
    const request = requests[0];
    assert.equal(request.url, "/v1/logs");
    assert.equal(request.init.headers["content-type"], "application/json");
    assert.equal(request.init.keepalive, true);
    const resource = JSON.parse(request.init.body).resourceLogs[0];
    assert.deepEqual(resource.resource.attributes, [
        { key: "service.name", value: { stringValue: "example" } },
    ]);
    const record = resource.scopeLogs[0].logRecords[0];
    assert.equal(record.eventName, "checkout");
    assert.equal(record.timeUnixNano, "1782518400123000000");
    assert.equal(record.observedTimeUnixNano, record.timeUnixNano);
    assert.equal(record.severityNumber, 9);
    assert.deepEqual(record.attributes, [
        { key: "count", value: { intValue: "3" } },
        { key: "enabled", value: { boolValue: true } },
    ]);
    assert.deepEqual(record.body, anyValue({ nested: ["a", 2, null] }));
});

test("uses beacons only for hidden-page delivery and reports queuing separately", async () => {
    const { client, environment, requests, beacons } = setup();
    environment.hidden = () => true;
    assert.deepEqual(await client.event("leaving"), { kind: "queued" });
    assert.equal(requests.length, 0);
    assert.equal(beacons[0].data.type, "application/json");
    assert.equal(
        JSON.parse(await beacons[0].data.text()).resourceLogs[0].scopeLogs[0]
            .logRecords[0].eventName,
        "leaving",
    );
});

for (const failure of ["reject", "throw"])
    test(`falls back to fetch when the beacon ${failure}s`, async () => {
        const { client, environment, requests } = setup();
        environment.hidden = () => true;
        environment.beacon = () => {
            if (failure === "throw") throw new Error("unsupported");
            return false;
        };
        assert.equal((await client.event("leaving")).kind, "accepted");
        assert.equal(requests.length, 1);
    });

for (const status of [204, 400, 429, 500])
    test(`reports HTTP ${status} as rejected`, async () => {
        const { client, environment } = setup();
        environment.fetch = async () =>
            new Response(status === 204 ? null : "{}", { status });
        assert.deepEqual(await client.event("test"), {
            kind: "rejected",
            status,
        });
    });

test("reports partial acceptance without retrying accepted records", async () => {
    const { client, environment } = setup();
    environment.fetch = async () =>
        new Response(
            '{"partialSuccess":{"rejectedLogRecords":"1","errorMessage":"invalid"}}',
        );
    assert.equal((await client.event("test")).kind, "rejected");
    environment.fetch = async () =>
        new Response(
            '{"partialSuccess":{"rejectedLogRecords":"0","errorMessage":"warning"}}',
        );
    assert.equal((await client.event("test")).kind, "accepted");
});

test("contains network and serialization failures", async () => {
    const { client, environment } = setup();
    environment.fetch = async () => {
        throw new Error("offline");
    };
    assert.equal((await client.event("test")).kind, "unavailable");
    const cycle = {};
    cycle.self = cycle;
    assert.equal((await client.event("test", {}, cycle)).kind, "rejected");
});

test("bounds payload size, field counts, depth and concurrent requests", async () => {
    const { client, environment, requests } = setup();
    assert.equal(
        (
            await client.event(
                "test",
                {},
                Object.fromEntries(
                    Array.from({ length: 12 }, (_, i) => [i, "x".repeat(8192)]),
                ),
            )
        ).kind,
        "rejected",
    );
    assert.equal(
        (
            await client.event(
                "test",
                Object.fromEntries(
                    Array.from({ length: 65 }, (_, i) => [i, i]),
                ),
            )
        ).kind,
        "rejected",
    );
    assert.equal(requests.length, 0);
    const waiting = [];
    environment.fetch = () => new Promise((resolve) => waiting.push(resolve));
    const active = Array.from({ length: 8 }, () => client.event("test"));
    assert.equal((await client.event("excess")).kind, "rejected");
    assert.equal(waiting.length, 8);
    for (const resolve of waiting) resolve(new Response("{}"));
    assert.ok(
        (await Promise.all(active)).every(
            (result) => result.kind === "accepted",
        ),
    );
});

test("bounds response size and rejects invalid response envelopes", async () => {
    const { client, environment } = setup();
    environment.fetch = async () => new Response("x".repeat(70 * 1024));
    assert.equal((await client.event("test")).kind, "rejected");
    for (const value of ["null", "[]", "42", "broken"]) {
        environment.fetch = async () => new Response(value);
        assert.notEqual((await client.event("test")).kind, "accepted");
    }
});

const span = {
    name: "checkout",
    traceId: "0123456789abcdef0123456789abcdef",
    spanId: "0123456789abcdef",
    startTimeUnixNano: "1782518400000000000",
    endTimeUnixNano: "1782518400123000000",
    attributes: { success: true },
};
test("exports OTLP traces with hex IDs and integer span kinds", async () => {
    const { client, requests } = setup();
    assert.equal((await client.span(span)).kind, "accepted");
    assert.equal(requests[0].url, "/v1/traces");
    const record = JSON.parse(requests[0].init.body).resourceSpans[0]
        .scopeSpans[0].spans[0];
    assert.equal(record.traceId, span.traceId);
    assert.equal(record.spanId, span.spanId);
    assert.equal(record.kind, 1);
    assert.deepEqual(record.attributes, [
        { key: "success", value: { boolValue: true } },
    ]);
});
for (const invalid of [
    { traceId: "0".repeat(32) },
    { spanId: "bad" },
    { parentSpanId: "0".repeat(16) },
    { endTimeUnixNano: "1" },
    { kind: 6 },
])
    test(`rejects malformed spans ${JSON.stringify(invalid)}`, async () => {
        const { client, requests } = setup();
        assert.equal(
            (await client.span({ ...span, ...invalid })).kind,
            "rejected",
        );
        assert.equal(requests.length, 0);
    });

test("rejects malformed partial success responses", async () => {
    const { client, environment } = setup();
    for (const partialSuccess of [
        null,
        [],
        "bad",
        { rejectedLogRecords: "no" },
        { rejectedSpans: -1 },
    ]) {
        environment.fetch = async () =>
            new Response(JSON.stringify({ partialSuccess }));
        assert.equal((await client.event("test")).kind, "rejected");
    }
});

test("cancels unread rejected and oversized response bodies", async () => {
    const { client, environment } = setup();
    for (const options of [
        { status: 500 },
        { headers: { "content-length": "999999" } },
    ]) {
        let canceled = false;
        const body = new ReadableStream({
            cancel() {
                canceled = true;
            },
        });
        environment.fetch = async () => new Response(body, options);
        assert.equal((await client.event("test")).kind, "rejected");
        assert.equal(canceled, true);
    }
});
