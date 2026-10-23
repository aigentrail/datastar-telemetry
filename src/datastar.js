/** @typedef {ReturnType<import('./telemetry.js').createTelemetry>} Client */

/**
 * Creates Datastar actions without importing or pinning a second Datastar runtime.
 * Register the returned actions with the application's existing runtime.
 * @param {Client} client
 */
export function telemetryActions(client) {
    return [
        {
            name: "telemetry",
            /** @param {unknown} _context @param {string} name @param {Record<string, unknown>} [fields] @param {unknown} [body] */
            apply(_context, name, fields = {}, body = null) {
                void client.event(name, fields, body);
            },
        },
        {
            name: "telemetrySpan",
            /** @param {unknown} _context @param {Parameters<Client['span']>[0]} span */
            apply(_context, span) {
                void client.span(span);
            },
        },
    ];
}

/**
 * Adds pathname views and delegated data-cta clicks to one root element.
 * Reapplication reuses listeners; removing the root disposes its scope.
 * @param {Client} client
 * @param {string[]} [pageEvents]
 */
export function telemetryAttribute(client, pageEvents = ["popstate"]) {
    /** @type {WeakMap<Element, {owners: number, dispose: () => void}>} */
    const scopes = new WeakMap();
    /** @param {Element} element @param {{owners: number, dispose: () => void}} scope */
    function release(element, scope) {
        if (scopes.get(element) !== scope) return;
        scope.owners -= 1;
        if (scope.owners !== 0) return;
        scopes.delete(element);
        scope.dispose();
    }
    return {
        name: "telemetry",
        requirement: "denied",
        /** @param {{el: Element}} context */
        apply({ el }) {
            const previous = scopes.get(el);
            if (previous) {
                previous.owners += 1;
                return () => release(el, previous);
            }
            const scope = {
                owners: 1,
                dispose: installTelemetryScope(el, client, pageEvents),
            };
            scopes.set(el, scope);
            return () => release(el, scope);
        },
    };
}

/** @param {Element} root @param {Client} client @param {string[]} pageEvents */
export function installTelemetryScope(root, client, pageEvents) {
    const view = root.ownerDocument.defaultView;
    if (!view) throw new TypeError("A browser document is required");
    const browser = view;
    if (pageEvents.length > 16) throw new RangeError("Too many page events");
    let path = "";
    function page() {
        const next = browser.location.pathname;
        if (next === path) return;
        path = next;
        void client.event("page_viewed", {}, { path });
    }
    /** @param {Event} event */
    function click(event) {
        if (!(event instanceof browser.MouseEvent) || event.button !== 0)
            return;
        if (!(event.target instanceof browser.Element)) return;
        const element = event.target.closest("[data-cta]");
        const id = element?.getAttribute("data-cta");
        if (!element || !id || !root.contains(element)) return;
        void client.event(
            "cta_clicked",
            {},
            {
                cta_id: id,
                text: (element.textContent ?? "").trim().slice(0, 80),
                href: element.getAttribute("href"),
            },
        );
    }
    for (const name of pageEvents) browser.addEventListener(name, page);
    root.addEventListener("click", click);
    page();
    return () => {
        for (const name of pageEvents) browser.removeEventListener(name, page);
        root.removeEventListener("click", click);
    };
}
