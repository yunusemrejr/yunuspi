import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { inspectPageState } from "./render-page-state.mjs";
import { createBrowserLease } from "./browser-session-lease.mjs";
import {
  browserFailure,
  createBrowserEvents,
  diagnosticText,
  inspectBrowserElement,
  verifyBrowserText,
  safeBrowserUrl,
} from "./browser-diagnostics.mjs";
import {
  MARKER_LIMIT,
  buildCollectScript,
  capEvaluateResult,
  clearMarkers,
  paintMarkers,
  resolveMarker,
} from "./browser-markers.mjs";
export { safeBrowserUrl } from "./browser-diagnostics.mjs";
const require = createRequire(new URL("../npm/package.json", import.meta.url));
const { chromium } = require("playwright");

export function browserUrl(raw) {
  const url = new URL(raw);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw Error(
      "Browser navigation requires HTTP(S) without embedded credentials",
    );
  return url.href;
}
export async function runBrowserSession(input, output) {
  let browser,
    context,
    page,
    closing = false,
    requestId = 0;
  const lease = createBrowserLease();
  const logs = createBrowserEvents(),
    network = createBrowserEvents();
  let markerStore = { url: null, markers: [] };
  const requests = new WeakMap();
  const record = (kind, extra) => logs.record(kind, extra);
  const close = async () => {
    if (closing) return;
    closing = true;
    await browser?.close().catch(() => {});
  };
  let lifetime;
  const armExpiry = () => {
    clearTimeout(lifetime);
    lifetime = setTimeout(() => {
      close().finally(() => process.exit(0));
    }, lease.receipt().remainingMs);
    lifetime.unref();
  };
  armExpiry();
  const terminate = () => close().finally(() => process.exit(0));
  process.on("SIGTERM", terminate);
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.length > 32_768) throw Error("Browser request exceeds limit");
      let id,
        action,
        stage = "validation";
      try {
        const request = JSON.parse(line);
        id = request.id;
        ({ action } = request);
        const p = request;
        lease.consume(action);
        const timeout = p.timeoutMs ?? 5000;
        if (!Number.isInteger(timeout) || timeout < 100 || timeout > 15000)
          throw Error("Invalid timeoutMs: use 100–15000");
        if (action === "close") {
          await close();
          output.write(
            JSON.stringify({ id, result: { ok: true, closed: true } }) + "\n",
          );
          break;
        }
        if (!browser) {
          if (action !== "open") throw Error("Open the browser session first");
          browserUrl(p.url);
          stage = "launch";
          browser = await chromium.launch({
            channel: process.env.PI_RENDER_BROWSER_CHANNEL ?? "chrome",
            headless: true,
            chromiumSandbox: true,
            timeout: 15_000,
          });
          context = await browser.newContext({
            viewport: { width: 1280, height: 800 },
            acceptDownloads: false,
            serviceWorkers: "block",
            permissions: [],
          });
          context.on("page", (child) => {
            if (page && child !== page) {
              record("popup-blocked");
              child.close().catch(() => {});
            }
          });
          await context.route("**/*", (route) => {
            try {
              browserUrl(route.request().url());
              return route.continue();
            } catch {
              record("unsupported-protocol-blocked");
              return route.abort();
            }
          });
          page = await context.newPage();
          page.setDefaultTimeout(5000);
          page.setDefaultNavigationTimeout(15_000);
          page.on("dialog", (dialog) => {
            record("dialog-dismissed", { type: dialog.type() });
            dialog.dismiss().catch(() => {});
          });
          page.on("download", (download) => {
            record("download-cancelled");
            download.cancel().catch(() => {});
          });
          page.on("console", (message) => {
            const location = message.location();
            record(`console-${message.type()}`, {
              message: diagnosticText(message.text()),
              location: {
                url: safeBrowserUrl(location.url),
                line: location.lineNumber,
                column: location.columnNumber,
              },
            });
          });
          page.on("pageerror", (error) =>
            record("page-script-error", {
              message: diagnosticText(error.stack ?? error.message, 1200),
            }),
          );
          page.on("request", (request) => {
            const entry = {
              requestId: ++requestId,
              url: safeBrowserUrl(request.url()),
              method: request.method(),
              resourceType: request.resourceType(),
            };
            requests.set(request, entry);
            network.record("request", entry);
          });
          page.on("response", (response) => {
            const entry = requests.get(response.request());
            network.record("response", {
              ...entry,
              status: response.status(),
              contentType: diagnosticText(
                response.headers()["content-type"] ?? "",
                100,
              ),
            });
            if (response.status() >= 400)
              record("http-error", {
                status: response.status(),
                url: safeBrowserUrl(response.url()),
              });
          });
          page.on("requestfinished", (request) => {
            const timing = request.timing();
            network.record("finished", {
              ...requests.get(request),
              durationMs: Math.max(0, Math.round(timing.responseEnd)),
              responseStartMs: Math.max(0, Math.round(timing.responseStart)),
            });
          });
          page.on("requestfailed", (request) => {
            const failure = {
              ...requests.get(request),
              failure: diagnosticText(request.failure()?.errorText, 120),
            };
            network.record("failed", failure);
            record("request-failed", failure);
          });
        }
        const surface = p.frame ? page.frameLocator(p.frame) : page;
        const hasLocatorTarget = () =>
          Number.isInteger(p.marker) ||
          (typeof p.selector === "string" && p.selector.length > 0) ||
          typeof p.role === "string";
        const locate = () => {
          if (Number.isInteger(p.marker)) {
            if (p.frame)
              throw Error("Markers address the main frame; omit frame or use a selector");
            const marker = resolveMarker(markerStore, p.marker, page.url());
            return page.locator(marker.path);
          }
          if (
            typeof p.selector === "string" &&
            p.selector.length > 0 &&
            p.selector.length <= 256
          )
            return surface.locator(p.selector);
          if (
            typeof p.role === "string" &&
            typeof p.name === "string" &&
            p.name.length <= 256
          )
            return surface.getByRole(p.role, { name: p.name, exact: true });
          throw Error(
            "Use a marker id, selector or exact role/name observed in this browser session",
          );
        };
        const readCoords = () => {
          if (!Number.isInteger(p.x) || !Number.isInteger(p.y) || p.x < 0 || p.y < 0)
            throw Error("Coordinate actions need integer x/y of at least 0 (CSS pixels)");
          return { x: p.x, y: p.y };
        };
        const snapshot = async () =>
          (p.selector || p.role ? locate() : surface.locator(":root")).evaluate(
            inspectPageState,
            { selector: p.selector ?? null },
            { timeout },
          );
        const frameList = () =>
          page
            .frames()
            .slice(0, 6)
            .map((frame) => ({
              url: safeBrowserUrl(frame.url()),
              name: diagnosticText(frame.name(), 120),
            }));
        let result;
        stage = action;
        if (action === "open" || action === "navigate") {
          stage = "navigation";
          const response = await page.goto(browserUrl(p.url), {
            waitUntil: "domcontentloaded",
            timeout: 15000,
          });
          markerStore = { url: null, markers: [] };
          record("navigation", {
            url: safeBrowserUrl(page.url()),
            status: response?.status(),
          });
        } else if (action === "click") {
          if (!hasLocatorTarget() && Number.isInteger(p.x) && Number.isInteger(p.y)) {
            const { x, y } = readCoords();
            await page.mouse.click(x, y);
          } else {
            await locate().click({ timeout });
          }
          record("click");
        } else if (action === "hover") {
          if (hasLocatorTarget()) {
            await locate().hover({ timeout });
          } else {
            const { x, y } = readCoords();
            await page.mouse.move(x, y);
          }
          record("hover");
        } else if (action === "scroll") {
          if (hasLocatorTarget()) {
            await locate().scrollIntoViewIfNeeded({ timeout });
          } else {
            const dx = p.dx ?? 0;
            const dy = p.dy ?? page.viewportSize()?.height ?? 800;
            if (!Number.isInteger(dx) || !Number.isInteger(dy))
              throw Error("Page scroll needs integer dx/dy wheel deltas");
            await page.mouse.wheel(dx, dy);
          }
          record("scroll");
        } else if (action === "drag") {
          if (!Number.isInteger(p.toX) || !Number.isInteger(p.toY) || p.toX < 0 || p.toY < 0)
            throw Error("drag needs integer toX/toY of at least 0 (CSS pixels)");
          let from;
          if (hasLocatorTarget()) {
            const box = await locate().boundingBox({ timeout });
            if (!box) throw Error("Drag source has no visible bounds");
            from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
          } else {
            from = readCoords();
          }
          await page.mouse.move(from.x, from.y);
          await page.mouse.down();
          try {
            await page.mouse.move(p.toX, p.toY, { steps: 12 });
          } finally {
            await page.mouse.up();
          }
          record("drag");
        } else if (action === "fill") {
          if (typeof p.text !== "string" || p.text.length > 8000)
            throw Error("fill text limit is 8000 characters");
          await locate().fill(p.text, { timeout });
          record("fill");
        } else if (action === "press") {
          if (typeof p.key !== "string" || p.key.length > 80)
            throw Error("Invalid key");
          await locate().press(p.key, { timeout });
          record("press");
        } else if (action === "select") {
          if (typeof p.option !== "string" || p.option.length > 256)
            throw Error("select requires an observed option label, at most 256 characters");
          await locate().evaluate((element, label) => {
            if (element.tagName !== "SELECT") throw Error("select requires a native select control");
            const options = Array.from(element.options).filter(option => option.label === label);
            if (options.length !== 1) throw Error("select requires one unique option label; inspect the control");
            if (options[0].disabled || options[0].closest("optgroup[disabled]")) throw Error("Selected option is disabled");
          }, p.option, { timeout });
          await locate().selectOption({ label: p.option }, { timeout });
          record("select");
        } else if (action === "check") {
          if (typeof p.checked !== "boolean") throw Error("check requires a boolean checked state");
          await locate().setChecked(p.checked, { timeout });
          record("check");
        } else if (action === "verify") {
          if (typeof p.text !== "string" || p.text.length > 8000)
            throw Error("verify requires text of at most 8000 characters");
          result = { verification: await locate().evaluate(verifyBrowserText, { text: p.text }, { timeout }) };
        } else if (action === "wait") {
          if (
            !["attached", "detached", "visible", "hidden"].includes(
              p.state ?? "visible",
            )
          )
            throw Error("Invalid wait state");
          await locate().waitFor({ state: p.state ?? "visible", timeout });
        } else if (action === "viewport") {
          if (
            ![p.width, p.height].every(
              (n) => Number.isInteger(n) && n >= 240 && n <= 2560,
            )
          )
            throw Error("Viewport dimensions must be 240–2560 pixels");
          await page.setViewportSize({ width: p.width, height: p.height });
        } else if (action === "inspect") {
          result = {
            inspection: await locate().evaluate(
              inspectBrowserElement,
              { properties: p.properties ?? [] },
              { timeout },
            ),
          };
        } else if (action === "evaluate") {
          if (typeof p.script !== "string" || p.script.length === 0 || p.script.length > 8000)
            throw Error("evaluate requires a script of 1–8000 characters");
          const maxChars = p.maxChars ?? 8000;
          if (!Number.isInteger(maxChars) || maxChars < 100 || maxChars > 64000)
            throw Error("Invalid maxChars: use 100–64000");
          const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
          const value = await surface
            .locator(":root")
            .evaluate(new AsyncFunction(p.script), null, { timeout });
          result = { evaluation: capEvaluateResult(value, maxChars) };
          record("evaluate");
        } else if (action === "html") {
          const maxChars = p.maxChars ?? 8000;
          if (!Number.isInteger(maxChars) || maxChars < 100 || maxChars > 64000)
            throw Error("Invalid maxChars: use 100–64000");
          const markup = await locate().evaluate((el) => el.outerHTML, null, { timeout });
          result = {
            html: markup.slice(0, maxChars),
            truncated: markup.length > maxChars,
            chars: markup.length,
          };
        } else if (action === "markers") {
          if (p.frame)
            throw Error("markers captures the main frame; omit frame");
          const collected = await page
            .locator(":root")
            .evaluate(new Function(buildCollectScript(MARKER_LIMIT)), null, { timeout });
          markerStore = { url: page.url(), markers: collected.rows };
          try {
            await page.evaluate(paintMarkers, collected.rows);
            const png = await page.screenshot({ type: "png", timeout: 10000 });
            if (png.length > 1_100_000)
              throw Error("Screenshot exceeds attachment limit");
            result = {
              png: png.toString("base64"),
              mimeType: "image/png",
              markers: collected.rows.map((row, index) => ({ id: index + 1, ...row })),
              markerCount: collected.rows.length,
              candidates: collected.candidates,
              limit: collected.limit,
              truncated: collected.truncated,
            };
          } finally {
            await page.evaluate(clearMarkers).catch(() => {});
          }
          record("markers");
        } else if (action === "observe") {
          const state = await page
            .locator(":root")
            .evaluate(inspectPageState, {}, { timeout });
          const png = await page.screenshot({ type: "png", timeout: 10000 });
          if (png.length > 1_100_000)
            throw Error("Screenshot exceeds attachment limit");
          const cursor = logs.summary().cursor;
          const recent = logs.read({
            since: Math.max(0, cursor - 30),
            limit: 30,
            includeText: true,
          });
          result = {
            pageState: state,
            frames: frameList(),
            png: png.toString("base64"),
            mimeType: "image/png",
            consoleErrors: recent.events.filter(
              (event) =>
                event.kind === "console-error" ||
                event.kind === "page-script-error",
            ),
            diagnosticsNote:
              "Latest console/page errors only; use logs/network for full bounded history.",
          };
        } else if (action === "logs" || action === "network") {
          const data = (action === "logs" ? logs : network).read(p);
          result = {
            [action]: data.events,
            ...Object.fromEntries(
              Object.entries(data).filter(([key]) => key !== "events"),
            ),
            limitations:
              "Bounded event history; bodies, cookies, authorization headers and URL parameters omitted. includeText enables best-effort minimized console/script messages; application prose can still contain private data.",
          };
        } else if (action === "screenshot") {
          const png = await (
            p.marker || p.selector || p.role ? locate() : page
          ).screenshot({ type: "png", timeout: 10000 });
          if (png.length > 1_100_000)
            throw Error("Screenshot exceeds attachment limit");
          result = { png: png.toString("base64"), mimeType: "image/png" };
        } else if (!["snapshot", "renew"].includes(action))
          throw Error("Unsupported browser action");
        if (!result) {
          stage = "observation";
          // Observe the whole document after mutations; a target may have disappeared.
          const state =
            action === "snapshot"
              ? await snapshot()
              : await surface
                  .locator(":root")
                  .evaluate(inspectPageState, {}, { timeout });
          result = {
            pageState: state,
            frames: frameList(),
          };
        }
        if (action === "renew") {
          // Renew only after a successful observation, without navigation or replay.
          lease.renew();
          armExpiry();
        }
        result = {
          ok: true,
          url: safeBrowserUrl(page.url()),
          diagnostics: { logs: logs.summary(), network: network.summary() },
          untrusted: true,
          lease: lease.receipt(),
          ...result,
        };
        output.write(JSON.stringify({ id, result }) + "\n");
      } catch (error) {
        const failure = browserFailure(error, stage, action);
        if (
          stage === "observation" &&
          ["click", "fill", "press", "select", "check", "hover", "scroll", "drag"].includes(
            action,
          )
        )
          failure.outcome = "action completed; subsequent observation failed";
        record("action-error", { failure });
        output.write(
          JSON.stringify({
            id,
            result: {
              ok: false,
              failure,
              url: page ? safeBrowserUrl(page.url()) : undefined,
              untrusted: true,
              lease: lease.receipt(),
            },
          }) + "\n",
        );
      }
    }
  } finally {
    clearTimeout(lifetime);
    process.removeListener("SIGTERM", terminate);
    await close();
  }
}
if (process.argv[1] === new URL(import.meta.url).pathname)
  await runBrowserSession(process.stdin, process.stdout);
