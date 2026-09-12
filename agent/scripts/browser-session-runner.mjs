import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { inspectPageState } from "./render-page-state.mjs";
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
export function safeBrowserUrl(raw) {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`.slice(0, 512);
  } catch {
    return "(unavailable)";
  }
}
export async function runBrowserSession(input, output) {
  let browser,
    context,
    page,
    closing = false,
    count = 0;
  const logs = [];
  const record = (kind, extra = {}) => {
    logs.push({ at: new Date().toISOString(), kind, ...extra });
    if (logs.length > 100) logs.shift();
  };
  const close = async () => {
    if (closing) return;
    closing = true;
    await browser?.close().catch(() => {});
  };
  const lifetime = setTimeout(() => {
    close().finally(() => process.exit(0));
  }, 10 * 60_000);
  lifetime.unref();
  process.on("SIGTERM", () => close().finally(() => process.exit(0)));
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.length > 32_768) throw Error("Browser request exceeds limit");
      let id;
      try {
        const request = JSON.parse(line);
        id = request.id;
        const { action, ...p } = request;
        if (++count > 200)
          throw Error(
            "Browser session action limit reached; close and open a new session",
          );
        if (action === "close") {
          await close();
          output.write(JSON.stringify({ id, result: { closed: true } }) + "\n");
          break;
        }
        if (!browser) {
          if (action !== "open") throw Error("Open the browser session first");
          browserUrl(p.url);
          browser = await chromium.launch({
            channel: process.env.PI_RENDER_BROWSER_CHANNEL ?? "chrome",
            headless: true,
            chromiumSandbox: true,
            timeout: 15_000,
            args: ["--disable-gpu", "--disable-webgl"],
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
          page.setDefaultTimeout(10_000);
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
            if (["error", "warning"].includes(message.type()))
              record(`console-${message.type()}`, {
                message: "omitted: untrusted page values",
              });
          });
          page.on("pageerror", () => record("page-script-error"));
          page.on("requestfailed", (request) =>
            record("request-failed", { url: safeBrowserUrl(request.url()) }),
          );
          page.on("response", (response) => {
            if (response.status() >= 400)
              record("http-error", {
                status: response.status(),
                url: safeBrowserUrl(response.url()),
              });
          });
        }
        const locate = () => {
          if (
            typeof p.selector === "string" &&
            p.selector.length > 0 &&
            p.selector.length <= 256
          )
            return page.locator(p.selector);
          if (
            typeof p.role === "string" &&
            typeof p.name === "string" &&
            p.name.length <= 256
          )
            return page.getByRole(p.role, { name: p.name, exact: true });
          throw Error(
            "Use a selector or exact role/name observed in this browser session",
          );
        };
        let result;
        if (action === "open" || action === "navigate") {
          const response = await page.goto(browserUrl(p.url), {
            waitUntil: "domcontentloaded",
          });
          record("navigation", {
            url: safeBrowserUrl(page.url()),
            status: response?.status(),
          });
        } else if (action === "click") {
          await locate().click();
          record("click");
        } else if (action === "fill") {
          if (typeof p.text !== "string" || p.text.length > 8000)
            throw Error("fill text limit is 8000 characters");
          await locate().fill(p.text);
          record("fill");
        } else if (action === "press") {
          if (typeof p.key !== "string" || p.key.length > 80)
            throw Error("Invalid key");
          await locate().press(p.key);
          record("press");
        } else if (action === "screenshot") {
          const png = await page.screenshot({ type: "png", timeout: 10_000 });
          if (png.length > 1_100_000)
            throw Error("Screenshot exceeds attachment limit");
          result = { png: png.toString("base64"), mimeType: "image/png" };
        } else if (!["snapshot", "logs"].includes(action))
          throw Error("Unsupported browser action");
        if (!result) {
          result = {
            url: safeBrowserUrl(page.url()),
            logs: logs.slice(-20),
            untrusted: true,
          };
          if (action !== "logs") {
            result.pageState = await page
              .locator(":root")
              .evaluate(inspectPageState, { selector: null });
            while (
              JSON.stringify(result).length > 14_000 &&
              result.pageState.items.length
            ) {
              result.pageState.items.pop();
              result.pageState.truncated = true;
            }
          }
        }
        output.write(JSON.stringify({ id, result }) + "\n");
      } catch (error) {
        record("action-error");
        // Playwright errors can echo entered values or URLs. Retain the failure
        // class; callers inspect current state before retrying uncertain actions.
        output.write(
          JSON.stringify({
            id,
            error:
              error.name === "TimeoutError"
                ? "Browser action timed out; inspect current state before retrying"
                : "Browser action failed; inspect state/logs and validate the target. No automatic action replay.",
          }) + "\n",
        );
      }
    }
  } finally {
    clearTimeout(lifetime);
    await close();
    lines.close();
  }
}
if (process.argv[1] === new URL(import.meta.url).pathname)
  await runBrowserSession(process.stdin, process.stdout);
