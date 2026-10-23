# datastar-telemetry

A [Datastar](https://data-star.dev) action and attribute plugin for sending
[OpenTelemetry](https://opentelemetry.io/) events and manually instrumented
spans using OTLP/HTTP JSON. Uses the
[Beacon API](https://developer.mozilla.org/en-US/docs/Web/API/Beacon_API) for
hidden-page delivery, with a fetch fallback.

```html
<button data-on:click="@telemetry('signup_clicked', {placement: 'hero'})">
    Sign up
</button>
```

## Getting started

Copy `src/telemetry.js` and `src/datastar.js` into your static assets, keeping
both files in the same directory. The examples below use `/telemetry/`.

Register the plugin with your application's existing Datastar runtime. Here,
`/vendor/datastar.js` is your pinned, self-hosted Datastar bundle. The plugin
has no runtime dependencies and does not load another copy of Datastar.

```html
<script type="module">
    import { action, attribute } from "/vendor/datastar.js";
    import {
        browserEnvironment,
        createTelemetry,
    } from "/telemetry/telemetry.js";
    import {
        telemetryActions,
        telemetryAttribute,
    } from "/telemetry/datastar.js";

    const client = createTelemetry(
        {
            logsEndpoint: "/v1/logs",
            tracesEndpoint: "/v1/traces",
            resource: { "service.name": "example-web" },
        },
        browserEnvironment(window),
    );

    for (const plugin of telemetryActions(client)) action(plugin);
    attribute(telemetryAttribute(client));
</script>
```

Your server must accept OTLP/HTTP JSON at the configured endpoints. Cross-origin
collectors must support CORS for JSON requests. Collector secrets belong on the
server.

## Why use this plugin?

- Send named events from Datastar expressions in a standard telemetry format.
- Export manually instrumented spans through the same client.
- Optionally record page views and declared call-to-action clicks.
- Choose explicitly what to send. Signals, form fields, cookies, identity, and
  attribution are not collected automatically.
- Use the client independently of Datastar, with JSDoc types and injectable
  clock and transport dependencies.

## Documentation

### `@telemetry(name, attributes?, body?)`

Send a named event as an OTLP log record. Attributes default to `{}` and the
body defaults to `null`. Both support structured JSON values.

```html
<button
    data-on:click="@telemetry('plan_selected', {plan: 'team'}, {seats: 5})"
>
    Choose Team
</button>
```

Each record includes `eventName`, INFO severity, and nanosecond timestamps
encoded as decimal strings. Resource attributes and instrumentation scope come
from the client configuration.

### `data-telemetry`

Add this optional attribute to one root element to record an initial
`page_viewed` event and delegated `data-cta` clicks within that root.

```html
<body data-telemetry>
    <a href="/pricing" data-cta="pricing">Pricing</a>
</body>
```

Page views contain `{path}` in the log body. CTA events are named `cta_clicked`
and contain `{cta_id, text, href}`. Link text is limited to 80 characters.

By default, the attribute listens for `popstate`. For client-side navigation,
register your route event too, then dispatch it after navigation:

```js
attribute(telemetryAttribute(client, ["popstate", "app:routechange"]));
window.dispatchEvent(new Event("app:routechange"));
```

Only pathname changes create additional views. Query and hash changes do not.
Reapplying the attribute reuses its listeners; removing it disposes them.

### `@telemetrySpan(span)`

Export an explicitly supplied span. Configure `tracesEndpoint` to use this
operation. The equivalent JavaScript API is `client.span(span)`.

```js
const result = await client.span({
    traceId: "0123456789abcdef0123456789abcdef",
    spanId: "0123456789abcdef",
    name: "checkout",
    startTimeUnixNano: "1792627200000000000",
    endTimeUnixNano: "1792627200100000000",
    attributes: { plan: "team" },
});
```

Trace IDs are 32 hexadecimal characters; span IDs and optional `parentSpanId`
are 16. IDs must be nonzero. Timestamps are decimal nanosecond strings. Optional
`kind` uses the OTLP integer enum and defaults to `1` (internal).

Automatic browser tracing, context propagation, and metrics are not included.

### JavaScript API

`client.event(name, attributes?, body?)` and `client.span(span)` return a
promise with a delivery result. Datastar actions send without exposing this
result to the expression.

- `accepted`: OTLP HTTP 200 response with no rejected records.
- `queued`: Browser accepted a beacon; server receipt is unknown.
- `rejected`: Invalid input, capacity limit, HTTP rejection, or partial
  rejection.
- `unavailable`: Transport or response parsing failed.

## Delivery behavior

Visible-page events use `fetch` with `keepalive` and a five-second timeout.
Events emitted while the page is hidden attempt `sendBeacon` first, falling back
to fetch if it is unavailable or refuses the payload. The plugin does not queue
events until the page is hidden or install an unload listener.

Limits are 60 KiB per payload or response, eight concurrent deliveries, 64
fields or array entries per container, eight nested levels, and 4096 value
nodes. Excess data is rejected. There is no persistent queue or automatic retry;
delivery is best effort.

## Development

```sh
npm ci
npm test
npm run check
```

Tests use Node's built-in runner. Source types are documented with JSDoc. Format
JavaScript with Biome using four-space indentation.

## License

[MIT](LICENSE)
