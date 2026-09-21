/**
 * http_request — bounded raw HTTP for API calls, status checks and tests.
 *
 * Replaces the common `curl` bash calls that fail small models on quoting and
 * on unbounded output. Deliberately conservative:
 *   - http/https only, no credentials in the URL, metadata endpoints blocked
 *   - redirects are NOT followed (the Location header is returned)
 *   - request body, response size and wall time are capped
 *   - set-cookie values are never returned
 * fetch_content remains the tool for readable pages; this one is for APIs.
 */

import { compactJsonWhitespace } from "./lib/compact-tool-json.ts";
import { askJev, jevMark, tooShort } from "./lib/jev-client.ts";
import { needleClassify } from "./lib/needle-runtime.ts";
import { microMetrics } from "./lib/micro-intelligence/metrics.ts";

const HTTP_CAUSE_LABELS = [
  { id: "timeout", text: "The request timed out waiting." },
  { id: "network", text: "DNS, connection, socket, or proxy failure." },
  { id: "validation", text: "Bad URL, method, headers, or blocked/SSRF input." },
  { id: "auth", text: "Missing, expired, or rejected credentials." },
  { id: "quota", text: "Rate limit, billing refusal, or exhausted allowance." },
  { id: "server", text: "The server errored (5xx) or failed unexpectedly." },
  { id: "cancelled", text: "The caller cancelled the request." },
];
import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";
import { Agent, request } from "undici";
import { Type } from "typebox";
import { lookupWithAbort, validateRemoteUrl, type Lookup, type LookupAddress } from "./pi-web-access/ssrf-protection.ts";

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
const URL_LIMIT = 2048;
const BODY_LIMIT = 65536;
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 30000;
const DEFAULT_MAX_BYTES = 16384;
const MAX_BYTES = 524288;
const BLOCKED_HOSTS = /^(?:169\.254\.169\.254|metadata\.google\.internal)$/i;
const RETURNED_HEADERS =
  /^(?:content-type|content-length|location|retry-after|cache-control|etag|last-modified|allow|www-authenticate)$/i;

export type HttpRequestBody = {
  url: string;
  method?: string;
  headers?: Record<string, unknown>;
  body?: string;
  json?: unknown;
  timeoutMs?: number;
  maxBytes?: number;
};

type HttpFailureKind = "cancelled" | "timeout" | "validation" | "network" | "unknown";

type HttpTransportOptions = { lookup?: Lookup };

const defaultLookup: Lookup = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function isLoopbackAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  if (net.isIP(normalized) === 4) return normalized.split(".")[0] === "127";
  return normalized === "::1" || normalized === "0:0:0:0:0:0:0:1";
}

/**
 * Validate a target and retain the exact DNS answers used by that validation.
 * The request's Agent receives those answers through its lookup callback so a
 * hostname cannot be re-resolved to a private address between validation and
 * connect (DNS rebinding).
 */
async function validateHttpTarget(
  url: URL,
  signal: AbortSignal,
  lookup: Lookup,
): Promise<{ url: URL; addresses?: LookupAddress[] }> {
  const resolved = new Map<string, LookupAddress[]>();
  const captureLookup: Lookup = async (hostname) => {
    const addresses = await lookup(hostname);
    resolved.set(normalizeHostname(hostname), addresses);
    return addresses;
  };
  const validated = await validateRemoteUrl(url, {
    signal,
    allowLoopback: true,
    lookup: captureLookup,
  });
  const hostname = normalizeHostname(validated.hostname);
  let addresses = resolved.get(hostname);
  // validateRemoteUrl intentionally accepts the exact `localhost` name for
  // explicit local APIs without DNS. Pin it to loopback before connecting so
  // that the transport cannot turn that exception into a public re-resolution.
  if (!addresses && hostname === "localhost") {
    try {
      addresses = (await lookupWithAbort("localhost", lookup, signal)).filter(({ address }) => isLoopbackAddress(address));
    } catch (error) {
      if (signal.aborted) throw error;
      addresses = [];
    }
    if (addresses.length === 0) addresses = [{ address: "127.0.0.1", family: 4 }];
  }
  return { url: validated, ...(addresses ? { addresses } : {}) };
}

type PinnedLookupCallback = (
  error: Error | null,
  address?: string | LookupAddress[],
  family?: number,
) => void;

function createPinnedLookup(
  target: { url: URL; addresses?: LookupAddress[] },
): (hostname: string, options: { family?: number; all?: boolean }, callback: PinnedLookupCallback) => void {
  const targetHostname = normalizeHostname(target.url.hostname);
  const pinned = target.addresses?.filter(({ address, family }) =>
    typeof address === "string" && (family === 4 || family === 6),
  ) ?? [];
  return (hostname, options, callback) => {
    const normalized = normalizeHostname(hostname);
    if (normalized !== targetHostname || pinned.length === 0) {
      callback(new Error(`No validated DNS address for ${hostname}`));
      return;
    }
    const family = options?.family === 4 || options?.family === 6 ? options.family : undefined;
    const candidates = family ? pinned.filter((entry) => entry.family === family) : pinned;
    if (candidates.length === 0) {
      callback(new Error(`No validated ${family === 4 ? "IPv4" : "IPv6"} address for ${hostname}`));
      return;
    }
    if (options?.all) callback(null, candidates);
    else callback(null, candidates[0].address, candidates[0].family);
  };
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { value, truncated: false };
  let low = 0;
  let high = Math.min(value.length, maxBytes) + 1;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) low = middle;
    else high = middle;
  }
  return { value: value.slice(0, low), truncated: true };
}

function describeHttpFailure(error: unknown, signal?: AbortSignal): {
  error: string;
  kind: HttpFailureKind;
  retryable: boolean;
  nextStep: string;
  decidedBy: string;
} {
  const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim().slice(0, 240) || "HTTP request failed";
  const lower = message.toLowerCase();
  const kind: HttpFailureKind = signal?.aborted || lower === "cancelled" || lower.includes("abort")
    ? "cancelled"
    : lower.includes("timed out") || lower.includes("timeout")
      ? "timeout"
      : /url |url is|unsupported method|only http|credentials|header|body|json|invalid request|allowed:|managed by|blocked internal|blocked hostname|blocked host|host is blocked|cloud metadata|remote urls? are not|resolved non-ip|ssrf/i.test(lower)
        ? "validation"
        : /fetch failed|econn|enotfound|enetwork|socket|dns|network|connect/i.test(lower)
          ? "network"
          : "unknown";
  const nextStep = kind === "cancelled"
    ? "The request was cancelled; retry only if the result is still needed."
    : kind === "timeout"
      ? "Retry once with a reachable endpoint or increase timeoutMs within the bounded limit."
      : kind === "validation"
        ? "Fix the URL, method, headers or bounded body inputs, then retry."
        : kind === "network"
          ? "Check endpoint and proxy/network access, then retry once or use fetch_content for readable pages."
          : "Check the endpoint and request inputs; retry only after correcting the cause.";
  return { error: message, kind, retryable: kind === "timeout" || kind === "network", nextStep, decidedBy: "regex" };
}

/** Causes that rewrite the failure kind; auth/quota/server add guidance only.
 * Shared by the Needle and Jev refinements so the twins cannot drift. */
const KIND_REWRITE = new Set(["timeout", "network", "validation", "cancelled"]);

/** Apply one ML cause verdict to a regex-leftover failure. Returns true when
 * the verdict decided the kind (recorded as `decidedBy` provenance). */
function applyHttpCause(
  failure: { kind: HttpFailureKind; retryable: boolean; nextStep: string },
  cause: string,
): boolean {
  let decided = false;
  if (KIND_REWRITE.has(cause)) {
    (failure as { kind: string }).kind = cause;
    decided = true;
  }
  if (cause === "server") failure.retryable = true;
  if (cause === "auth") failure.nextStep = "Provide or refresh credentials, then retry.";
  if (cause === "quota") failure.nextStep = "Back off for the provider cooldown window, then retry.";
  if (cause === "server") failure.nextStep = "Retry once; the failure is server-side.";
  return decided;
}

function validateHeaders(
  input: Record<string, unknown>,
): Record<string, string> {
  const entries = Object.entries(input ?? {});
  if (entries.length > 20) throw new Error("At most 20 headers are allowed");
  const headers: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name))
      throw new Error(`Invalid header name: ${name.slice(0, 40)}`);
    if (
      typeof value !== "string" ||
      value.length > 1024 ||
      /[\r\n]/.test(value)
    )
      throw new Error(`Invalid value for header ${name}`);
    const lower = name.toLowerCase();
    if (
      [
        "host",
        "content-length",
        "connection",
        "transfer-encoding",
        "upgrade",
        "te",
      ].includes(lower)
    )
      throw new Error(
        `Header ${name} is managed by the client and cannot be set`,
      );
    headers[name] = value;
  }
  return headers;
}

/** Perform one bounded HTTP request. Returns a compact result object. */
export async function performHttp(
  input: HttpRequestBody,
  signal?: AbortSignal,
  transportOptions: HttpTransportOptions = {},
) {
  if (!input || typeof input !== "object")
    throw new Error("Invalid request input");
  if (
    typeof input.url !== "string" ||
    !input.url ||
    input.url.length > URL_LIMIT
  )
    throw new Error(
      `url is required and must be at most ${URL_LIMIT} characters`,
    );
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new Error("url is not a valid absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("Only http and https URLs are supported");
  if (url.username || url.password)
    throw new Error(
      "Credentials in the URL are not allowed; use an Authorization header",
    );
  if (BLOCKED_HOSTS.test(url.hostname))
    throw new Error("This host is blocked (cloud metadata endpoint)");

  const method = String(input.method ?? "GET").toUpperCase();
  if (!METHODS.includes(method))
    throw new Error(
      `Unsupported method: ${method} (allowed: ${METHODS.join(", ")})`,
    );
  if (input.body !== undefined && input.json !== undefined)
    throw new Error("Supply either body or json, not both");
  let body: string | undefined;
  if (input.headers !== undefined && (!input.headers || typeof input.headers !== "object" || Array.isArray(input.headers)))
    throw new Error("headers must be an object of string values");
  const headers = validateHeaders(
    (input.headers ?? {}) as Record<string, unknown>,
  );
  if (input.json !== undefined) {
    try {
      body = JSON.stringify(input.json);
    } catch {
      throw new Error("json must be JSON-serializable");
    }
    if (typeof body !== "string") throw new Error("json must be JSON-serializable");
    if (Buffer.byteLength(body, "utf8") > BODY_LIMIT)
      throw new Error(`json body exceeds ${BODY_LIMIT} bytes`);
    if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type"))
      headers["content-type"] = "application/json";
  } else if (input.body !== undefined) {
    if (typeof input.body !== "string")
      throw new Error("body must be a string");
    if (Buffer.byteLength(input.body, "utf8") > BODY_LIMIT)
      throw new Error(`body exceeds ${BODY_LIMIT} bytes`);
    body = input.body;
  }

  const timeoutMs = Math.min(
    Math.max(Number(input.timeoutMs) || DEFAULT_TIMEOUT_MS, 1000),
    MAX_TIMEOUT_MS,
  );
  const maxBytes = Math.min(
    Math.max(Number(input.maxBytes) || DEFAULT_MAX_BYTES, 1024),
    MAX_BYTES,
  );
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;

  let target: Awaited<ReturnType<typeof validateHttpTarget>>;
  try {
    target = await validateHttpTarget(url, combined, transportOptions.lookup ?? defaultLookup);
  } catch (error) {
    // Localhost pinning uses lookupWithAbort, whose abort error does not
    // distinguish the deadline from caller cancellation.
    if (!signal?.aborted && timeoutSignal.aborted)
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    throw error;
  }
  const dispatcher = new Agent({
    connect: { lookup: createPinnedLookup(target) },
  });
  let response: Awaited<ReturnType<typeof request>>;
  try {
    try {
      response = await request(target.url, {
        method,
        headers,
        body,
        signal: combined,
        maxRedirections: 0,
        dispatcher,
      });
    } catch (error: any) {
      if (signal?.aborted) throw new Error("Cancelled");
      if (timeoutSignal.aborted)
        throw new Error(`Request timed out after ${timeoutMs}ms`);
      const code = error?.code ? `${error.code}: ` : "";
      throw new Error(
        `${code}${String(error?.message ?? "request failed").slice(0, 240)}`,
      );
    }

    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    if (response.body) {
      try {
        for await (const chunk of response.body) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > maxBytes) {
            chunks.push(
              buffer.subarray(0, Math.max(0, buffer.length - (bytes - maxBytes))),
            );
            truncated = true;
            response.body.destroy();
            break;
          }
          chunks.push(buffer);
        }
      } catch (error: any) {
        if (signal?.aborted) throw new Error("Cancelled");
        if (timeoutSignal.aborted)
          throw new Error(`Request timed out after ${timeoutMs}ms`);
        if (!truncated)
          throw new Error(
            `Response read failed: ${String(error?.message ?? error).slice(0, 200)}`,
          );
      }
    }
    const raw = Buffer.concat(chunks);
    const contentType = String(response.headers["content-type"] ?? "");
    const returned: Record<string, string> = {};
    for (const [name, value] of Object.entries(response.headers)) {
      if (RETURNED_HEADERS.test(name) && typeof value === "string")
        returned[name] = value.slice(0, 300);
      if (
        name.toLowerCase().startsWith("x-ratelimit-") &&
        typeof value === "string"
      )
        returned[name] = value.slice(0, 100);
    }

    let text: string;
    let encoding = "text";
    if (/json/i.test(contentType)) {
      const rawText = raw.toString("utf8");
      try {
        // Validate, then remove only lexical whitespace: preserve large integers,
        // duplicate keys and escapes exactly as received.
        JSON.parse(rawText);
        text = compactJsonWhitespace(rawText, 0);
        encoding = "json";
      } catch {
        text = rawText;
        encoding = "text";
      }
    } else if (
      /^text\/|xml|javascript|x-www-form-urlencoded/i.test(contentType) ||
      raw.length === 0
    ) {
      text = raw.toString("utf8");
    } else {
      // Reserve the prefix and whole base64 blocks before encoding the byte cap.
      const binaryLimit = Math.floor((maxBytes - "base64:".length) / 4) * 3;
      truncated ||= raw.length > binaryLimit;
      text = `base64:${raw.subarray(0, binaryLimit).toString("base64")}`;
      encoding = "base64";
    }

    const bounded = truncateUtf8(text, maxBytes);

    return {
      status: response.statusCode,
      headers: returned,
      encoding,
      body: bounded.value,
      truncated: truncated || bounded.truncated,
      bytes: raw.length,
    };
  } finally {
    await dispatcher.close().catch(() => {});
  }
}

export default function httpTools(pi: any) {
  pi.registerTool({
    name: "http_request",
    label: "HTTP Request",
    description:
      "Bounded raw HTTP request (GET/HEAD/POST/PUT/PATCH/DELETE) for APIs, status checks and tests. Use this INSTEAD of bash `curl` for simple calls: no shell quoting, returns status, headers and a size-capped body, never follows redirects (Location is returned). Use fetch_content for readable web pages.",
    promptSnippet: "Bounded HTTP request with status, headers and capped body",
    promptGuidelines: [
      "Use http_request instead of bash `curl` for simple HTTP API calls and status checks.",
    ],
    parameters: Type.Object({
      url: Type.String({ minLength: 1, maxLength: URL_LIMIT }),
      method: Type.Optional(Type.Union(METHODS.map((m) => Type.Literal(m)))),
      headers: Type.Optional(
        Type.Record(Type.String(), Type.String({ maxLength: 1024 })),
      ),
      body: Type.Optional(Type.String({ maxLength: BODY_LIMIT })),
      json: Type.Optional(Type.Unknown()),
      timeoutMs: Type.Optional(
        Type.Integer({ minimum: 1000, maximum: MAX_TIMEOUT_MS }),
      ),
      maxBytes: Type.Optional(
        Type.Integer({ minimum: 1024, maximum: MAX_BYTES, description: "Response byte cap; defaults to 16384. Increase explicitly when more body content is needed; check truncated." }),
      ),
    }),
    async execute(_id: any, params: HttpRequestBody, signal: any) {
      try {
        const result = await performHttp(params, signal);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
        };
      } catch (error) {
        const failure = describeHttpFailure(error, signal);
        // Needle first: an accepted local classification refines the regex
        // leftover without a network call. Application is shared with the Jev
        // refinement below via applyHttpCause: only kind-rewrite causes change
        // the kind; auth/quota/server add next-step guidance. A Needle kind
        // verdict skips Jev; guidance-only causes still get Jev validation.
        if (failure.kind === "unknown" && !tooShort(failure.error, 40)) {
          try {
            const ranked = await needleClassify({ text: failure.error.slice(0, 1024), labels: HTTP_CAUSE_LABELS });
            if (ranked.ok && !ranked.shadow && ranked.value.accepted) {
              const cause = ranked.value.label;
              if (applyHttpCause(failure, cause)) failure.decidedBy = "needle";
              (failure as unknown as Record<string, unknown>).needle = {
                cause,
                score: ranked.value.score,
                margin: ranked.value.margin,
              };
              microMetrics().run("needle", ranked.ms);
              microMetrics().accept("needle");
            } else {
              microMetrics().skip("needle", ranked.ok ? (ranked.shadow ? "shadow" : "low-confidence") : ranked.reason);
            }
          } catch {
            microMetrics().skip("needle", "unavailable");
          }
        }
        // Jev refines only the regex leftovers: short messages and decided
        // kinds keep the deterministic verdict.
        try {
          if (failure.kind === "unknown" && !tooShort(failure.error, 40)) {
            const judged = await askJev("classify", failure.error, {
              kind: {
                type: "choice",
                instructions: "What kind of HTTP failure is this?",
                criteria: {
                  timeout: "The request timed out waiting.",
                  network: "DNS, connection, socket, or proxy failure.",
                  validation: "Bad URL, method, headers, or blocked/SSRF input.",
                  auth: "Missing, expired, or rejected credentials.",
                  quota: "Rate limit, billing refusal, or exhausted allowance.",
                  server: "The server errored (5xx) or failed unexpectedly.",
                  cancelled: "The caller cancelled the request.",
                },
              },
            }, { pi, signal });
            if (judged.ok) {
              const cause = judged.answers.kind?.choice;
              const confidence = judged.answers.kind?.confidence ?? 0;
              const known = HTTP_CAUSE_LABELS.map((label) => label.id);
              if (cause && known.includes(cause) && confidence >= 0.7) {
                if (applyHttpCause(failure, cause)) failure.decidedBy = "jev";
                (failure as unknown as Record<string, unknown>).jev = {
                  mark: jevMark("classify", `${cause} ${confidence.toFixed(2)}`, judged.usage),
                  cause,
                  confidence,
                };
              }
            }
          }
        } catch {
          // The regex verdict stands.
        }
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(failure) }],
          details: failure,
        };
      }
    },
  });
}
