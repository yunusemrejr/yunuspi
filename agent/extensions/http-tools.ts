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

import { request } from "undici";
import { Type } from "typebox";

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
const URL_LIMIT = 2048;
const BODY_LIMIT = 65536;
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 30000;
const DEFAULT_MAX_BYTES = 262144;
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
  const headers = validateHeaders(
    (input.headers ?? {}) as Record<string, unknown>,
  );
  if (input.json !== undefined) {
    body = JSON.stringify(input.json);
    if (body.length > BODY_LIMIT)
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

  let response: Awaited<ReturnType<typeof request>>;
  try {
    response = await request(url, {
      method,
      headers,
      body,
      signal: combined,
      maxRedirections: 0,
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
      text = JSON.stringify(JSON.parse(rawText), null, 2);
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
    text = `base64:${raw.toString("base64")}`;
    encoding = "base64";
  }

  return {
    status: response.statusCode,
    headers: returned,
    encoding,
    body: text.length > maxBytes ? text.slice(0, maxBytes) : text,
    truncated: truncated || text.length > maxBytes,
    bytes: raw.length,
  };
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
        Type.Integer({ minimum: 1024, maximum: MAX_BYTES }),
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
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : "Request failed",
            },
          ],
        };
      }
    },
  });
}
