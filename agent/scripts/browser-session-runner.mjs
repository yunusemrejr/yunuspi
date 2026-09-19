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
  capEvaluateResult,
  clearMarkers,
  paintMarkers,
} from "./browser-markers.mjs";
import { collectBrowserTargets, readBrowserPage, browserHumanHelp } from "./browser-page-tools.mjs";
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
  const tabs = new Map(), frameIds = new WeakMap();
  let tabSequence = 0, refSequence = 0, frameSequence = 0;
  let logs, network;
  const disposeTargets = async (tab) => {
    const old = [...tab.refs.values(), ...tab.markers.values()];
    tab.refs.clear(); tab.markers.clear();
    await Promise.all(old.map(({ handle }) => handle.dispose().catch(() => {})));
  };
  const activeTab = () => [...tabs.values()].find(tab => tab.page === page);
  const selectTab = tab => { page = tab.page; logs = tab.logs; network = tab.network; };
  const tabList = () => [...tabs.values()].map(tab => ({ tab: tab.id, active: tab.page === page, url: safeBrowserUrl(tab.page.url()), ...(tab.title ? { title: tab.title } : {}) }));
  const requests = new WeakMap();
  const record = (kind, extra) => logs?.record(kind, extra);
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
          if (p.visible && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) throw Error("Visible browser requires a desktop display; omit visible for screenshots and text-based human help");
          stage = "launch";
          browser = await chromium.launch({
            channel: process.env.PI_RENDER_BROWSER_CHANNEL ?? "chrome",
            headless: p.visible !== true,
            chromiumSandbox: true,
            timeout: 15_000,
          });
          context = await browser.newContext({
            viewport: { width: 1280, height: 800 },
            acceptDownloads: false,
            serviceWorkers: "block",
            permissions: [],
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
          context.on("page", child => {
            if (tabs.size >= 8) {
              record("tab-limit", { limit: 8 });
              child.close().catch(() => {});
              return;
            }
            const tab = { id: `tab-${++tabSequence}`, page: child, logs: createBrowserEvents(), network: createBrowserEvents(), refs: new Map(), markers: new Map(), dialog: null };
            tabs.set(tab.id, tab);
            const { logs, network } = tab;
            const record = (kind, extra) => logs.record(kind, extra);
            child.on("framenavigated", frame => {
              if (frame === child.mainFrame()) void disposeTargets(tab);
            });
            child.on("domcontentloaded", () => { child.title().then(title => tab.title = diagnosticText(title, 120)).catch(() => {}); });
            child.on("close", () => {
              tabs.delete(tab.id);
              void disposeTargets(tab);
              if (page === child) {
                const next = tabs.values().next().value;
                if (next) selectTab(next);
                else page = undefined;
              }
            });
            child.setDefaultTimeout(5000);
            child.setDefaultNavigationTimeout(15_000);
            child.on("dialog", (dialog) => {
              const decision = tab.dialog;
              tab.dialog = null; // One dialog response, never a persistent auto-accept policy.
              const accept = decision?.mode === "accept";
              record(accept ? "dialog-accepted" : "dialog-dismissed", { type: dialog.type(), message: diagnosticText(dialog.message()) });
              (accept ? dialog.accept(decision.text) : dialog.dismiss()).catch(() => {});
            });
            child.on("download", (download) => {
              record("download-cancelled");
              download.cancel().catch(() => {});
            });
            child.on("console", (message) => {
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
            child.on("pageerror", (error) =>
              record("page-script-error", {
                message: diagnosticText(error.stack ?? error.message, 1200),
              }),
            );
            child.on("request", (request) => {
              const entry = {
                requestId: ++requestId,
                url: safeBrowserUrl(request.url()),
                method: request.method(),
                resourceType: request.resourceType(),
              };
              requests.set(request, entry);
              network.record("request", entry);
            });
            child.on("response", (response) => {
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
            child.on("requestfinished", (request) => {
              const timing = request.timing();
              network.record("finished", {
                ...requests.get(request),
                durationMs: Math.max(0, Math.round(timing.responseEnd)),
                responseStartMs: Math.max(0, Math.round(timing.responseStart)),
              });
            });
            child.on("requestfailed", (request) => {
              const failure = {
                ...requests.get(request),
                failure: diagnosticText(request.failure()?.errorText, 120),
              };
              network.record("failed", failure);
              record("request-failed", failure);
            });
          });
          await context.newPage();
          selectTab(tabs.values().next().value);
        }
        if (p.tab) {
          const selected = tabs.get(p.tab);
          if (!selected) throw Error("Unknown tab; use tabs to inspect live tab ids");
          selectTab(selected);
        }
        if (action === "new_tab") {
          if (tabs.size >= 8) throw Error("Browser tab limit is 8; close a tab first");
          browserUrl(p.url); // Validate before allocating a page.
          const child = await context.newPage();
          selectTab([...tabs.values()].find(tab => tab.page === child));
        }
        if (!page && action !== "tabs") throw Error("No open tab; use new_tab with an HTTP(S) URL");
        let surface = page;
        if (p.frame) {
          surface = page.frames().find(frame => frameIds.get(frame) === p.frame);
          if (!surface) {
            const element = await page.locator(p.frame).elementHandle({ timeout });
            try { surface = await element?.contentFrame(); } finally { await element?.dispose(); }
          }
          if (!surface) throw Error("Unknown frame; inspect frames before selecting one");
        }
        const hasLocatorTarget = () =>
          typeof p.ref === "string" || Number.isInteger(p.marker) ||
          (typeof p.selector === "string" && p.selector.length > 0) ||
          typeof p.role === "string";
        const locate = async () => {
          if (p.ref || Number.isInteger(p.marker)) {
            const tab = activeTab();
            const target = p.ref ? tab.refs.get(p.ref) : tab.markers.get(p.marker);
            const validate = new Function("el", "expected", `const collect = ${collectBrowserTargets.toString()}; if (!el.isConnected) return false; const row = collect(el, { limit: 1 }).rows[0]; return !!row && row.tag === expected.tag && row.name === expected.name && row.role === expected.role;`);
            if (!target || !await target.handle.evaluate(validate, target.identity).catch(() => false))
              throw Error("Stale browser reference; capture snapshot or markers again");
            if (p.frame) throw Error("References already identify their frame; omit frame");
            return target.handle;
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
          if (p.frame) throw Error("Coordinates address the main viewport; omit frame");
          if (!Number.isInteger(p.x) || !Number.isInteger(p.y) || p.x < 0 || p.y < 0)
            throw Error("Coordinate actions need integer x/y of at least 0 (CSS pixels)");
          return { x: p.x, y: p.y };
        };
        const snapshot = async () =>
          (hasLocatorTarget() ? await locate() : surface.locator(":root")).evaluate(
            inspectPageState,
            { selector: p.selector ?? null },
            { timeout },
          );
        const frameList = () =>
          page
            .frames()
            .slice(0, 20)
            .map((frame) => ({
              frame: frameIds.get(frame) ?? (frameIds.set(frame, `frame-${++frameSequence}`), frameIds.get(frame)),
              url: safeBrowserUrl(frame.url()),
              name: diagnosticText(frame.name(), 120),
            }));
        const targets = async (markers = false) => {
          const tab = activeTab();
          const store = markers ? tab.markers : tab.refs;
          const root = action === "snapshot" && hasLocatorTarget() ? await locate() : surface.locator(":root");
          const set = await root.evaluateHandle(collectBrowserTargets, { limit: MARKER_LIMIT, viewportOnly: markers });
          const old = [...store.values()]; store.clear();
          await Promise.all(old.map(({ handle }) => handle.dispose().catch(() => {})));
          const elements = await set.getProperty("elements");
          try {
            const data = await set.evaluate(({ rows, truncated, visited }) => ({ rows, truncated, visited }));
            const handles = await elements.getProperties();
            const rows = data.rows.map((row, index) => {
              const ref = markers ? index + 1 : `ref-${++refSequence}`;
              store.set(ref, { handle: handles.get(String(index)).asElement(), identity: { tag: row.tag, name: row.name, role: row.role } });
              const { bounds, inViewport, role, disabled, ...compact } = row;
              return { [markers ? "id" : "ref"]: ref, ...compact, ...(role ? { role } : {}), ...(disabled ? { disabled: true } : {}), ...(markers ? { bounds } : inViewport ? {} : { inViewport: false }) };
            });
            return { rows, truncated: data.truncated, visited: data.visited };
          } finally { await elements.dispose(); await set.dispose(); }
        };
        let result;
        stage = action;
        if (["open", "navigate", "new_tab"].includes(action)) {
          stage = "navigation";
          const response = await page.goto(browserUrl(p.url), {
            waitUntil: "domcontentloaded",
            timeout: 15000,
          });
          record("navigation", {
            url: safeBrowserUrl(page.url()),
            status: response?.status(),
          });
        } else if (action === "tabs") {
          result = { tabs: tabList(), limit: 8 };
        } else if (action === "switch_tab") {
          if (!p.tab) throw Error("switch_tab requires tab from tabs");
          await page.bringToFront();
        } else if (action === "close_tab") {
          await page.close({ runBeforeUnload: false });
          result = { tabs: tabList(), closed: true };
        } else if (["back", "forward", "reload"].includes(action)) {
          const method = { back: "goBack", forward: "goForward", reload: "reload" }[action];
          await page[method]({ waitUntil: "domcontentloaded", timeout });
        } else if (action === "dialog") {
          if (!["accept", "dismiss", "clear"].includes(p.mode)) throw Error("dialog requires mode accept, dismiss or clear");
          activeTab().dialog = p.mode === "clear" ? null : { mode: p.mode, text: p.text };
          result = { dialog: { mode: p.mode, scope: "Next dialog in this tab; consumed once. Default is dismiss. Use clear to disarm." } };
        } else if (action === "click") {
          if (!hasLocatorTarget() && Number.isInteger(p.x) && Number.isInteger(p.y)) {
            const { x, y } = readCoords();
            await page.mouse.click(x, y, { button: p.button ?? "left", clickCount: p.clickCount ?? 1 });
          } else {
            await (await locate()).click({ timeout, button: p.button ?? "left", clickCount: p.clickCount ?? 1 });
          }
          record("click");
        } else if (action === "hover") {
          if (hasLocatorTarget()) {
            await (await locate()).hover({ timeout });
          } else {
            const { x, y } = readCoords();
            await page.mouse.move(x, y);
          }
          record("hover");
        } else if (action === "scroll") {
          if (hasLocatorTarget()) {
            await (await locate()).scrollIntoViewIfNeeded({ timeout });
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
            const box = await (await locate()).boundingBox({ timeout });
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
          await (await locate()).fill(p.text, { timeout });
          record("fill");
        } else if (action === "press") {
          if (typeof p.key !== "string" || p.key.length > 80)
            throw Error("Invalid key");
          if (hasLocatorTarget()) await (await locate()).press(p.key, { timeout });
          else await page.keyboard.press(p.key);
          record("press");
        } else if (action === "select") {
          if (typeof p.option !== "string" || p.option.length > 256)
            throw Error("select requires an observed option label, at most 256 characters");
          await (await locate()).evaluate((element, label) => {
            if (element.tagName !== "SELECT") throw Error("select requires a native select control");
            const options = Array.from(element.options).filter(option => option.label === label);
            if (options.length !== 1) throw Error("select requires one unique option label; inspect the control");
            if (options[0].disabled || options[0].closest("optgroup[disabled]")) throw Error("Selected option is disabled");
          }, p.option, { timeout });
          await (await locate()).selectOption({ label: p.option }, { timeout });
          record("select");
        } else if (action === "check") {
          if (typeof p.checked !== "boolean") throw Error("check requires a boolean checked state");
          await (await locate()).setChecked(p.checked, { timeout });
          record("check");
        } else if (action === "verify") {
          if (typeof p.text !== "string" || p.text.length > 8000)
            throw Error("verify requires text of at most 8000 characters");
          result = { verification: await (await locate()).evaluate(verifyBrowserText, { text: p.text }, { timeout }) };
        } else if (action === "wait") {
          const kind = p.kind ?? "element";
          if (kind === "url") {
            if (typeof p.url !== "string") throw Error("URL wait requires url (exact URL or Playwright glob)");
            await surface.waitForURL(p.url, { timeout, waitUntil: "domcontentloaded" });
          } else if (kind === "load") {
            if (!["domcontentloaded", "load", "networkidle"].includes(p.state ?? "load")) throw Error("Invalid load state");
            await surface.waitForLoadState(p.state ?? "load", { timeout });
          } else if (kind === "text") {
            if (typeof p.text !== "string" || !p.text) throw Error("Text wait requires nonempty text");
            await surface.getByText(p.text, { exact: false }).first().waitFor({ state: p.state ?? "visible", timeout });
          } else if (kind === "function") {
            if (typeof p.script !== "string" || !p.script || p.script.length > 8000) throw Error("Function wait requires script (return a boolean)");
            const handle = await surface.waitForFunction(new Function(p.script), null, { timeout, polling: 100 });
            await handle.dispose();
          } else if (kind === "element") {
            if (!["attached", "detached", "visible", "hidden"].includes(p.state ?? "visible")) throw Error("Invalid wait state");
            const target = await locate();
            if (p.ref || p.marker) {
              if (["attached", "detached"].includes(p.state)) throw Error("Use an observed selector for attached/detached waits");
              await target.waitForElementState(p.state ?? "visible", { timeout });
            } else await target.waitFor({ state: p.state ?? "visible", timeout });
          } else throw Error("Invalid wait kind");
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
            inspection: await (await locate()).evaluate(
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
          const evaluator = new AsyncFunction("element", "args", `const cap = ${capEvaluateResult.toString()}; return cap(await (async () => {${p.script}\n})(), args.maxChars);`);
          let deadline;
          try {
            const evaluation = await Promise.race([
              surface.locator(":root").evaluate(evaluator, { maxChars }),
              new Promise((_, reject) => { deadline = setTimeout(() => reject(Error("Evaluation timeout; script may still be running; inspect before retrying")), timeout); }),
            ]);
            result = { evaluation };
          } finally { clearTimeout(deadline); }
          record("evaluate");
        } else if (action === "html") {
          const maxChars = p.maxChars ?? 8000;
          if (!Number.isInteger(maxChars) || maxChars < 100 || maxChars > 64000)
            throw Error("Invalid maxChars: use 100–64000");
          result = await (await locate()).evaluate((el, maxChars) => {
            const markup = el.outerHTML;
            return { html: markup.slice(0, maxChars), truncated: markup.length > maxChars, chars: markup.length };
          }, maxChars);
        } else if (action === "read") {
          const maxChars = p.maxChars ?? 8000, offset = p.offset ?? 0;
          if (!Number.isInteger(maxChars) || maxChars < 100 || maxChars > 64000 || !Number.isInteger(offset) || offset < 0)
            throw Error("Invalid read offset or maxChars");
          result = { reading: await (hasLocatorTarget() ? await locate() : surface.locator(":root")).evaluate(readBrowserPage, { offset, maxChars, query: p.query }) };
        } else if (action === "markers") {
          if (p.frame)
            throw Error("markers captures the main frame; omit frame");
          const collected = await targets(true);
          try {
            await page.evaluate(paintMarkers, collected.rows);
            const png = await page.screenshot({ type: "png", timeout: 10000 });
            if (png.length > 1_100_000)
              throw Error("Screenshot exceeds attachment limit");
            result = {
              png: png.toString("base64"),
              mimeType: "image/png",
              markers: collected.rows,
              markerCount: collected.rows.length,
              visited: collected.visited,
              limit: MARKER_LIMIT,
              truncated: collected.truncated,
            };
          } finally {
            await page.evaluate(clearMarkers).catch(() => {});
          }
          record("markers");
        } else if (action === "observe") {
          const state = await surface
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
            hasLocatorTarget() ? await locate() : page
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
        if (result.pageState) {
          stage = "observation";
          const captured = await targets();
          result.targets = captured.rows;
          result.targetsTruncated = captured.truncated;
          result.humanHelp = await surface.locator(":root").evaluate(browserHumanHelp).catch(() => null);
          result.tabs = tabList();
        }
        if (action === "renew") {
          // Renew only after a successful observation, without navigation or replay.
          lease.renew();
          armExpiry();
        }
        result = {
          ok: true,
          tab: activeTab()?.id,
          url: page ? safeBrowserUrl(page.url()) : undefined,
          diagnostics: { logs: logs?.summary(), network: network?.summary() },
          untrusted: true,
          lease: lease.receipt(),
          ...result,
        };
        output.write(JSON.stringify({ id, result }) + "\n");
      } catch (error) {
        const failure = browserFailure(error, stage, action);
        if (
          stage === "observation" &&
          ["click", "fill", "press", "select", "check", "hover", "scroll", "drag", "navigate", "new_tab", "back", "forward", "reload"].includes(
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
              tab: activeTab()?.id,
              tabs: tabList(),
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
