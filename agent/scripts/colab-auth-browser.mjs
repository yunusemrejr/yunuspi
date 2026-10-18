#!/usr/bin/env node
/**
 * Visible-browser helper for the Colab CLI's copy-paste OAuth flow.
 *
 * The official CLI prints an accounts.google.com URL and then waits for an
 * authorization code on stdin. This helper opens that URL in a real browser,
 * clicks through the account chooser and consent screens, and reads the code
 * from Google's landing page. It never asks for, types, or stores a password;
 * if Google needs a human (password, 2-step, CAPTCHA, device confirmation) it
 * reports `needs_user` and keeps polling so the person can finish in the window.
 *
 * Protocol: one JSON object per line on stdout. The extension reads the last
 * `{"status":"code","code":"..."}` line and writes the code to the CLI stdin.
 * The code is a credential and is never printed as prose.
 *
 * Usage:
 *   node colab-auth-browser.mjs --url <oauth-url> [--profile DIR]
 *        [--timeout SEC] [--headless] [--cookies FILE] [--email ADDR]
 *
 * Exit codes: 0 code captured, 1 error, 2 timeout, 3 missing browser.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(new URL("../npm/package.json", import.meta.url));

function loadPlaywright() {
  try {
    return require("playwright");
  } catch (error) {
    try {
      return require("playwright-core");
    } catch {
      throw new Error(`Playwright is unavailable: ${error.message}`);
    }
  }
}

/** Extract the authorization code from the text Google displays on its
 * "application default auth code" landing page. Pure so it can be tested
 * without a browser. */
export function extractAuthCode(text) {
  const source = String(text ?? "");
  if (!source.trim()) return null;
  // Google web auth codes usually look like 4/0AX4Xf... or 1//0g...
  const direct = source.match(/\b((?:4\/|1\/\/)[0-9A-Za-z._~+/=-]{20,})\b/);
  if (direct) return direct[1];
  // The landing page also renders the code in a <code>, <pre>, <textarea> or
  // text input; a standalone long token on its own line is the next best clue.
  const lines = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const stripped = line.replace(/^(?:authorization\s+code|code)\s*[:=]\s*/i, "");
    if (/^[A-Za-z0-9._~+/=-]{24,}$/.test(stripped) && !/^https?:/i.test(stripped))
      return stripped;
  }
  return null;
}

/** Normalize the page URL to a coarse stage so the extension can report
 * progress without leaking OAuth state, client ids or query values. */
export function authStage(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl ?? ""));
  } catch {
    return "unknown";
  }
  if (url.hostname === "sdk.cloud.google.com" && url.pathname.includes("applicationdefaultauthcode")) return "code-page";
  if (url.hostname === "accounts.google.com") {
    if (/\/signin\/(?:identifier|v3\/signin)/.test(url.pathname)) return "sign-in";
    if (/\/oauth\/consent/.test(url.pathname) || url.searchParams.has("continue")) return "consent";
    if (/accountchooser|\/AccountChooser/.test(url.pathname)) return "account-chooser";
    return "accounts";
  }
  if (url.hostname === "colab.research.google.com") return "colab";
  return "other";
}

/** Convert a user browser cookie export (Playwright addCookies shape) into the
 * exact fields Chromium accepts, dropping anything else. */
export function playwrightCookies(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((cookie) => {
    if (!cookie || typeof cookie.name !== "string" || typeof cookie.value !== "string") return [];
    if (typeof cookie.domain !== "string" || !cookie.domain) return [];
    const item = {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: typeof cookie.path === "string" && cookie.path.startsWith("/") ? cookie.path : "/",
      httpOnly: cookie.httpOnly === true,
      secure: cookie.secure !== false,
    };
    if (typeof cookie.expires === "number" && Number.isFinite(cookie.expires) && cookie.expires > 0) item.expires = cookie.expires;
    if (["Strict", "Lax", "None"].includes(cookie.sameSite)) item.sameSite = cookie.sameSite;
    return [item];
  });
}

function parseArgs(argv) {
  const out = { timeoutSec: 300, headless: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--url") out.url = argv[++i];
    else if (arg === "--profile") out.profile = argv[++i];
    else if (arg === "--timeout") out.timeoutSec = Number(argv[++i]);
    else if (arg === "--headless") out.headless = true;
    else if (arg === "--cookies") out.cookies = argv[++i];
    else if (arg === "--email") out.email = argv[++i];
    else if (arg === "--help") {
      process.stdout.write("usage: colab-auth-browser.mjs --url URL [--profile DIR] [--timeout SEC] [--headless] [--cookies FILE] [--email ADDR]\n");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!out.url || !/^https:\/\/accounts\.google\.com\//.test(out.url)) throw new Error("--url must be an accounts.google.com OAuth URL");
  if (!Number.isFinite(out.timeoutSec) || out.timeoutSec < 10 || out.timeoutSec > 1800) throw new Error("--timeout must be between 10 and 1800 seconds");
  return out;
}

function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One DOM snapshot, shaped for the decision function below. */
async function snapshot(page) {
  return page.evaluate(() => {
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 1 && rect.height > 1 && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.01;
    };
    const label = (element) => {
      const aria = element.getAttribute("aria-label");
      const title = element.getAttribute("title");
      const text = element.innerText || element.value || "";
      return String(aria || title || text || "").replace(/\s+/g, " ").trim().slice(0, 120);
    };
    const buttons = [...document.querySelectorAll('button, [role="button"], input[type="submit"], a[role="button"]')]
      .filter(isVisible)
      .map((element, index) => ({ index, text: label(element), disabled: element.disabled === true || element.getAttribute("aria-disabled") === "true" }))
      .filter((button) => button.text);
    const inputs = [...document.querySelectorAll("input")].filter(isVisible).map((element) => ({
      type: String(element.type || "text"),
      name: element.name || "",
      id: element.id || "",
      value: String(element.value || "").slice(0, 4096),
      placeholder: String(element.placeholder || "").slice(0, 120),
    }));
    const accounts = [...document.querySelectorAll("[data-identifier]")].filter(isVisible).map((element) => ({
      identifier: element.getAttribute("data-identifier"),
      text: label(element),
    }));
    const codeContainers = [...document.querySelectorAll("code, pre, textarea, input[type='text'], input:not([type])")]
      .filter(isVisible)
      .map((element) => String(element.value || element.textContent || "").trim())
      .filter(Boolean)
      .slice(0, 20);
    const text = String(document.body?.innerText || "").slice(0, 20000);
    return { href: location.href, text, buttons, inputs, accounts, codeContainers };
  }).catch(() => ({ href: page.url(), text: "", buttons: [], inputs: [], accounts: [], codeContainers: [] }));
}

function hasText(dom, regex) {
  return regex.test(dom.text);
}

/** Choose the next safe click from a snapshot. Returns a button index only;
 * navigation stays with Playwright so the helper never dispatches JS clicks
 * that the page cannot attribute to a real interaction. */
export function chooseAction(dom, email) {
  if (dom.inputs.some((input) => input.type === "password")) return { kind: "needs_user", reason: "password required" };
  if (dom.inputs.some((input) => input.type === "email" || input.name === "identifier" || input.id === "identifierId"))
    return { kind: "needs_user", reason: "Google sign-in required" };
  if (/\/signin\/(?:v3\/signin\/)?identifier/.test(String(dom.href || "")) && !dom.accounts.length)
    return { kind: "needs_user", reason: "Google sign-in required" };
  if (hasText(dom, /verify it(?:'|’)s you|2-step verification|enter the code|security code|not a robot|recaptcha|couldn.t sign you in|browser or app may not be secure|confirm you.re not a robot/i))
    return { kind: "needs_user", reason: "Google needs human verification" };
  if (dom.accounts.length) {
    const match = email ? dom.accounts.find((account) => account.identifier === email || account.text.includes(email)) : undefined;
    return { kind: "click_account", identifier: (match ?? dom.accounts[0]).identifier, text: (match ?? dom.accounts[0]).text };
  }
  const wanted = [
    /^(?:continue|allow|accept|i agree|got it|next|confirm|yes,? (?:i'?m|continue|allow))$/i,
    /continue with/i,
  ];
  const candidates = dom.buttons.filter((button) => !button.disabled && wanted.some((regex) => regex.test(button.text)) && !/cancel|back|use another account|switch account|not now|deny|reject/i.test(button.text));
  if (candidates.length) return { kind: "click_button", index: candidates[0].index, text: candidates[0].text };
  if (hasText(dom, /choose an account|pick an account/i)) return { kind: "needs_user", reason: "account chooser needs a choice" };
  if (hasText(dom, /sign in\b|email or phone/i)) return { kind: "needs_user", reason: "Google sign-in required" };
  return { kind: "wait" };
}

async function clickButton(page, text) {
  const exact = page.getByRole("button", { name: text, exact: true });
  if (await exact.count().catch(() => 0)) {
    await exact.first().click({ timeout: 4000 }).catch(() => {});
    return true;
  }
  const loose = page.getByRole("button", { name: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") });
  if (await loose.count().catch(() => 0)) {
    await loose.first().click({ timeout: 4000 }).catch(() => {});
    return true;
  }
  return false;
}

async function clickAccount(page, dom, choice) {
  if (choice.identifier) {
    const exact = page.locator(`[data-identifier="${choice.identifier.replace(/"/g, '\\"')}"]`);
    if (await exact.count().catch(() => 0)) {
      await exact.first().click({ timeout: 4000 }).catch(() => {});
      return true;
    }
  }
  const text = choice.text?.split("\n").map((line) => line.trim()).filter(Boolean)[0];
  if (!text) return false;
  const byText = page.getByText(text, { exact: false });
  if (await byText.count().catch(() => 0)) {
    await byText.first().click({ timeout: 4000 }).catch(() => {});
    return true;
  }
  return false;
}

async function launch(options, cookies) {
  const { chromium } = loadPlaywright();
  const errors = [];
  const channels = ["chrome", "msedge", undefined];
  const headed = !options.headless && Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  for (const channel of channels) {
    let context;
    try {
      context = await chromium.launchPersistentContext(options.profile, {
        headless: !headed,
        ...(channel ? { channel } : {}),
        viewport: { width: 1280, height: 900 },
        locale: "en-US",
        timeout: 20000,
        args: ["--no-first-run", "--no-default-browser-check", "--disable-blink-features=AutomationControlled"],
      });
      if (cookies.length) await context.addCookies(cookies).catch(() => {});
      return { context, browser: channel ?? "chromium", headed };
    } catch (error) {
      await context?.close().catch(() => {});
      errors.push(`${channel ?? "chromium"}: ${String(error.message).split("\n")[0]}`);
    }
  }
  throw new Error(`No browser could start (${errors.join("; ")})`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const profile = path.resolve(options.profile || path.join(os.homedir(), ".pi", "colab", "browser-profile"));
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  let cookies = [];
  if (options.cookies) {
    try {
      cookies = playwrightCookies(JSON.parse(fs.readFileSync(options.cookies, "utf8")));
    } catch {
      cookies = [];
    }
    try { fs.rmSync(options.cookies, { force: true }); } catch {}
  }
  const deadline = Date.now() + options.timeoutSec * 1000;
  let context;
  let browserLabel;
  let headed;
  try {
    ({ context, browser: browserLabel, headed } = await launch(options, cookies));
  } catch (error) {
    emit({ status: "error", stage: "launch", message: error.message });
    process.exit(3);
  }
  emit({ status: "opened", browser: browserLabel, visible: headed, seededCookies: cookies.length, url: "https://accounts.google.com/" });
  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(5000);
  let lastUserReason;
  let lastUrl = "";
  let clicked = 0;
  try {
    await page.goto(options.url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    while (Date.now() < deadline) {
      const dom = await snapshot(page);
      const stage = authStage(dom.href || page.url());
      if (dom.href && dom.href !== lastUrl) {
        lastUrl = dom.href;
        emit({ status: "navigated", stage });
      }
      const code = extractAuthCode([...(dom.codeContainers ?? []), dom.text ?? ""].join("\n"));
      if (code && stage === "code-page") {
        emit({ status: "code", code, stage });
        await context.close().catch(() => {});
        process.exit(0);
      }
      if (code && /authorization code|copy (?:this|the) code|enter this code/i.test(dom.text ?? "")) {
        emit({ status: "code", code, stage });
        await context.close().catch(() => {});
        process.exit(0);
      }
      const action = chooseAction(dom, options.email);
      if (action.kind === "needs_user" && action.reason !== lastUserReason) {
        lastUserReason = action.reason;
        emit({ status: "needs_user", reason: action.reason, stage, next: "Complete the browser step in the opened window; this helper will continue automatically." });
      }
      if (action.kind === "click_account") {
        clicked++;
        emit({ status: "action", action: "account", stage });
        await clickAccount(page, dom, action);
      } else if (action.kind === "click_button" && clicked < 20) {
        clicked++;
        emit({ status: "action", action: "consent", text: action.text, stage });
        await clickButton(page, action.text);
      }
      if (Date.now() >= deadline) break;
      await sleep(650);
    }
    emit({ status: "timeout", seconds: options.timeoutSec, stage: authStage(page.url()) });
    await context.close().catch(() => {});
    process.exit(2);
  } catch (error) {
    emit({ status: "error", stage: "browser", message: String(error.message).split("\n")[0].slice(0, 500) });
    await context.close().catch(() => {});
    process.exit(1);
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    emit({ status: "error", stage: "startup", message: String(error.message).slice(0, 500) });
    process.exit(1);
  });
}
