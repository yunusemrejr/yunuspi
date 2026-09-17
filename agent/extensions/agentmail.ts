/**
 * agentmail — AgentMail email tools (send + inspect) for agent-run email.
 *
 * The API key is read from the process environment at call time; this module
 * never writes, caches on disk, logs or echoes credentials:
 *   AGENTMAIL_API_KEY    required  Bearer token for api.agentmail.to (or *.eu)
 *   AGENTMAIL_INBOX_ID   optional  default inbox (usually the sender address)
 *   AGENTMAIL_BASE_URL   optional  endpoint override (tests / EU region)
 *
 * Transport is delegated to performHttp in http-tools.ts so there is exactly
 * one bounded HTTP owner in the harness: SSRF guard, no redirect following,
 * cookie stripping, size/time caps and header validation all stay in one place.
 *
 * Outreach hygiene the tools cannot enforce stays in the prompt guidelines
 * (verified recipients, no padding a campaign to a count, honest sender, an
 * opt-out line, respect a suppression list). The tools do enforce bounded
 * recipients, a required subject, CR/LF rejection (header injection) and a
 * request size the API accepts.
 */
import { Type } from "typebox";
import { performHttp } from "./http-tools.ts";

const API_KEY_ENV = "AGENTMAIL_API_KEY";
const INBOX_ENV = "AGENTMAIL_INBOX_ID";
const BASE_URL_ENV = "AGENTMAIL_BASE_URL";
const DEFAULT_BASE_URL = "https://api.agentmail.to";

const MAX_RECIPIENTS = 50;
const MAX_SUBJECT = 200;
const MAX_BODY_BYTES = 60_000;
const MAX_LABELS = 20;
const MAX_LABEL = 64;
const MAX_MESSAGE_LIST = 100;
const MESSAGE_LIST_BYTES = 32_768;
const MESSAGE_DETAIL_BYTES = 32_768;
const MAX_TEXT_FIELD = 8_000;

export type AgentMailConfig = {
  apiKey: string;
  baseUrl: string;
  defaultInboxId?: string;
};

export type ConfigResolution =
  | { ok: true; config: AgentMailConfig }
  | { ok: false; error: string; nextStep: string };

/** Read configuration from the environment only. Pure so tests can inject env. */
export function resolveConfig(
  env: Record<string, string | undefined> = process.env,
): ConfigResolution {
  const apiKey = (env[API_KEY_ENV] ?? "").trim();
  if (!apiKey)
    return {
      ok: false,
      error: `${API_KEY_ENV} is not set, so AgentMail is unavailable.`,
      nextStep: `Export ${API_KEY_ENV} in the environment that launches pi (never in a committed file), then restart the session.`,
    };
  const rawBase = (env[BASE_URL_ENV] ?? "").trim() || DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(rawBase);
  } catch {
    return {
      ok: false,
      error: `${BASE_URL_ENV} is not a valid URL.`,
      nextStep: `Set ${BASE_URL_ENV} to an https API origin such as ${DEFAULT_BASE_URL}.`,
    };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return {
      ok: false,
      error: `${BASE_URL_ENV} must be http or https.`,
      nextStep: `Set ${BASE_URL_ENV} to an https API origin.`,
    };
  if (url.username || url.password || url.search || url.hash)
    return {
      ok: false,
      error: `${BASE_URL_ENV} must be a bare origin without credentials, query or fragment.`,
      nextStep: `Set ${BASE_URL_ENV} to an origin only, e.g. ${DEFAULT_BASE_URL}.`,
    };
  const inbox = (env[INBOX_ENV] ?? "").trim();
  return {
    ok: true,
    config: {
      apiKey,
      baseUrl: url.origin + url.pathname.replace(/\/+$/, ""),
      ...(inbox ? { defaultInboxId: inbox } : {}),
    },
  };
}

const PLAIN_ADDRESS = /^[^\s<>@,;:"]+@[^\s<>@,;:"]+\.[A-Za-z0-9-]{2,}$/;
const NAMED_ADDRESS =
  /^[^<>()\\,";:\r\n]{1,64}\s*<[^\s<>@,;:"]+@[^\s<>@,;:"]+\.[A-Za-z0-9-]{2,}>$/;
const INBOX_ID = /^[A-Za-z0-9][A-Za-z0-9._%+-]{0,127}$/;
const MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._=+@:-]{0,255}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;
const SEARCH_TEXT = /^[^\r\n]{1,200}$/;

function bad(field: string, why: string): never {
  throw new Error(`${field}: ${why}`);
}

function text(
  value: unknown,
  field: string,
  max: number,
  required = false,
): string | undefined {
  if (value === undefined || value === null) {
    if (required) bad(field, "is required");
    return undefined;
  }
  if (typeof value !== "string") bad(field, "must be a string");
  if (/[\r\n]/.test(value)) bad(field, "must not contain CR or LF");
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) bad(field, "must not be empty");
    return undefined;
  }
  if (trimmed.length > max) bad(field, `must be at most ${max} characters`);
  return trimmed;
}

/** Address in `user@domain` or `Display Name <user@domain>` form. */
export function validateAddress(value: unknown, field: string): string {
  const address = text(value, field, 320, true)!;
  if (!PLAIN_ADDRESS.test(address) && !NAMED_ADDRESS.test(address))
    bad(
      field,
      "must be an email address, optionally as `Display Name <user@domain>`",
    );
  return address;
}

/** Accept one address or a bounded list; duplicates are collapsed. */
export function validateRecipients(
  value: unknown,
  field: string,
  required = false,
): string[] {
  const rows =
    value === undefined || value === null
      ? []
      : Array.isArray(value)
        ? value
        : [value];
  if (!rows.length) {
    if (required) bad(field, "needs at least one recipient");
    return [];
  }
  if (rows.length > MAX_RECIPIENTS)
    bad(field, `supports at most ${MAX_RECIPIENTS} recipients`);
  const out: string[] = [];
  for (const row of rows) {
    const address = validateAddress(row, field);
    if (!out.includes(address)) out.push(address);
  }
  return out;
}

export function validateInboxId(value: unknown, fallback?: string): string {
  const raw =
    value === undefined || value === null || value === "" ? fallback : value;
  if (raw === undefined || raw === null || raw === "")
    bad("inboxId", `is required; pass it explicitly or set ${INBOX_ENV}`);
  const id = text(raw, "inboxId", 320, true)!;
  if (id.includes("@")) return validateAddress(id, "inboxId");
  if (!INBOX_ID.test(id)) bad("inboxId", "is not a valid inbox id or address");
  return id;
}

function validateMessageId(value: unknown): string {
  const id = text(value, "id", 256, true)!;
  if (!MESSAGE_ID.test(id)) bad("id", "is not a valid message id");
  return id;
}

export function validateLabels(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) bad("labels", "must be an array of strings");
  if (value.length > MAX_LABELS)
    bad("labels", `supports at most ${MAX_LABELS} labels`);
  return value.map((row) => {
    const label = text(row, "labels", MAX_LABEL, true)!;
    if (!LABEL.test(label))
      bad(
        "labels",
        "entries must be short words (letters, digits, space, _ or -)",
      );
    return label;
  });
}

function validateBodyText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") bad(field, "must be a string");
  if (!value.trim()) return undefined;
  if (Buffer.byteLength(value, "utf8") > MAX_BODY_BYTES)
    bad(field, `must be at most ${MAX_BODY_BYTES} bytes of UTF-8`);
  return value;
}

export type SendInput = {
  inboxId?: string;
  to: unknown;
  cc?: unknown;
  bcc?: unknown;
  replyTo?: unknown;
  subject: unknown;
  text?: unknown;
  html?: unknown;
  labels?: unknown;
};

/** Wire shape of the AgentMail send body (snake_case field names are the API's). */
export type SendEnvelope = {
  to: string[];
  cc?: string[];
  bcc?: string[];
  reply_to?: string[];
  subject: string;
  text?: string;
  html?: string;
  labels?: string[];
};

/** Build the exact AgentMail send payload; exported for tests. */
export function buildSendPayload(
  input: SendInput,
  inboxId: string,
): { inboxId: string; envelope: SendEnvelope } {
  const to = validateRecipients(input.to, "to", true);
  const cc = validateRecipients(input.cc, "cc");
  const bcc = validateRecipients(input.bcc, "bcc");
  const replyTo =
    input.replyTo === undefined
      ? []
      : validateRecipients(input.replyTo, "replyTo");
  const subject = text(input.subject, "subject", MAX_SUBJECT, true)!;
  const textBody = validateBodyText(input.text, "text");
  const htmlBody = validateBodyText(input.html, "html");
  if (!textBody && !htmlBody)
    bad("text", "or html is required: supply the message body");
  const labels = validateLabels(input.labels);
  return {
    inboxId,
    envelope: {
      to,
      ...(cc.length ? { cc } : {}),
      ...(bcc.length ? { bcc } : {}),
      ...(replyTo.length ? { reply_to: replyTo } : {}),
      subject,
      ...(textBody ? { text: textBody } : {}),
      ...(htmlBody ? { html: htmlBody } : {}),
      ...(labels.length ? { labels } : {}),
    },
  };
}

type RequestOptions = {
  method: "GET" | "POST";
  path: string;
  query?: Array<[string, string]>;
  body?: unknown;
  maxBytes?: number;
};

export type AgentMailResult = {
  status: number;
  data?: unknown;
  text: string;
  truncated: boolean;
  headers?: Record<string, string>;
};

/** One bounded AgentMail API call. Exported so tests can drive a local server. */
export async function agentMailRequest(
  config: AgentMailConfig,
  options: RequestOptions,
  signal?: AbortSignal,
): Promise<AgentMailResult> {
  const search = options.query?.length
    ? `?${new URLSearchParams(options.query).toString()}`
    : "";
  const result = await performHttp(
    {
      url: `${config.baseUrl}${options.path}${search}`,
      method: options.method,
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        accept: "application/json",
      },
      ...(options.body === undefined ? {} : { json: options.body }),
      maxBytes: options.maxBytes ?? 16_384,
    },
    signal,
  );
  let data: unknown;
  if (result.encoding === "json") {
    try {
      data = JSON.parse(result.body);
    } catch {
      data = undefined;
    }
  }
  return {
    status: result.status,
    data,
    text: result.body,
    truncated: result.truncated,
    ...(result.headers && typeof result.headers === "object"
      ? { headers: result.headers as Record<string, string> }
      : {}),
  };
}

/** Statuses worth one automatic retry on idempotent reads. Sends never retry:
 * the send endpoint takes no idempotency key, so a retried POST could deliver
 * twice. */
const GET_RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const GET_RETRY_DEFAULT_MS = 400;
const GET_RETRY_MAX_MS = 5_000;

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Honor a small Retry-After; otherwise wait a short fixed delay. Pure. */
export function retryDelayMs(
  headers: Record<string, string> | undefined,
  fallbackMs = GET_RETRY_DEFAULT_MS,
): number {
  const clamp = (ms: number) =>
    Number.isFinite(ms)
      ? Math.min(GET_RETRY_MAX_MS, Math.max(0, Math.floor(ms)))
      : fallbackMs;
  if (!headers || typeof headers !== "object") return fallbackMs;
  const entry = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === "retry-after",
  );
  if (!entry) return fallbackMs;
  const seconds = Number(entry[1]);
  if (Number.isFinite(seconds)) return clamp(seconds * 1000);
  const at = Date.parse(entry[1]);
  if (!Number.isNaN(at)) return clamp(at - Date.now());
  return fallbackMs;
}

export type GetWithRetry = {
  result: AgentMailResult;
  retried: boolean;
};

/** One GET with a single bounded retry on 429/5xx or a transport throw.
 * Cancellation is never retried. Exported for tests. */
export async function getWithRetry(
  config: AgentMailConfig,
  options: Omit<RequestOptions, "method" | "body">,
  signal?: AbortSignal,
): Promise<GetWithRetry> {
  const attempt = () =>
    agentMailRequest(config, { ...options, method: "GET" }, signal);
  const cancelled = (error: unknown) =>
    signal?.aborted === true ||
    /abort|cancel/i.test(
      error instanceof Error ? error.message : String(error),
    );
  try {
    const first = await attempt();
    if (!GET_RETRY_STATUSES.has(first.status) || signal?.aborted)
      return { result: first, retried: false };
    await sleep(retryDelayMs(first.headers));
    if (signal?.aborted) return { result: first, retried: true };
    try {
      return { result: await attempt(), retried: true };
    } catch (error) {
      if (cancelled(error)) throw error;
      return { result: first, retried: true };
    }
  } catch (error) {
    if (cancelled(error)) throw error;
    await sleep(GET_RETRY_DEFAULT_MS);
    if (signal?.aborted) throw error;
    return { result: await attempt(), retried: true };
  }
}

type ApiErrorRow = {
  name?: string;
  message?: string;
  code?: string;
  fix?: string;
  docs?: string;
  errors?: unknown;
};

function apiError(data: unknown, raw: string): ApiErrorRow {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const row = data as Record<string, unknown>;
    const str = (value: unknown) =>
      typeof value === "string" && value.trim()
        ? value.trim().slice(0, 400)
        : undefined;
    return {
      name: str(row.name),
      message: str(row.message),
      code: str(row.code),
      fix: str(row.fix),
      docs: str(row.docs),
      ...(row.errors === undefined ? {} : { errors: row.errors }),
    };
  }
  return {
    message:
      raw.slice(0, 300).replace(/\s+/g, " ").trim() || "empty response body",
  };
}

type Failure = {
  ok: false;
  status: number;
  kind: string;
  retryable: boolean;
  error: string;
  nextStep: string;
  code?: string;
  fix?: string;
  docs?: string;
  errors?: unknown;
};

/** Turn one non-2xx API response into a stable, actionable failure object. */
export function describeApiFailure(
  status: number,
  data: unknown,
  raw: string,
): Failure {
  const detail = apiError(data, raw);
  const kind =
    status === 400 || status === 422
      ? "validation"
      : status === 401
        ? "unauthorized"
        : status === 403
          ? "rejected"
          : status === 404
            ? "not_found"
            : status === 409
              ? "conflict"
              : status === 429
                ? "rate_limited"
                : status >= 500
                  ? "server"
                  : status >= 300 && status < 400
                    ? "redirect"
                    : "http_error";
  const nextStep =
    kind === "unauthorized"
      ? `Check ${API_KEY_ENV}; the key is missing, expired or does not cover this inbox.`
      : kind === "rejected"
        ? "The API refused the message (sender/domain not verified, or blocked). Fix the account state before retrying; do not resend blindly."
        : kind === "validation"
          ? "Fix the named fields and retry once."
          : kind === "not_found"
            ? "Verify the inbox id and message id, then retry."
            : kind === "rate_limited"
              ? "Back off before retrying; do not loop on sends."
              : kind === "conflict"
                ? "The request conflicts with current state; re-read the resource and retry deliberately."
                : kind === "server"
                  ? "The API failed; retry once, then report the failure instead of looping."
                  : kind === "redirect"
                    ? "Unexpected redirect; check the configured base URL."
                    : "Inspect the status and body; retry only after correcting the cause.";
  return {
    ok: false,
    status,
    kind,
    retryable:
      kind === "rate_limited" || kind === "server" || kind === "conflict",
    error: detail.message ?? `AgentMail returned HTTP ${status}`,
    nextStep,
    ...(detail.code ? { code: detail.code } : {}),
    ...(detail.fix ? { fix: detail.fix } : {}),
    ...(detail.docs ? { docs: detail.docs } : {}),
    ...(detail.errors === undefined ? {} : { errors: detail.errors }),
  };
}

function str(value: unknown, max = 240): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, max)
    : undefined;
}

function list(value: unknown, max = 40): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .filter((row) => typeof row === "string")
    .slice(0, max) as string[];
  return out.length ? out : undefined;
}

/** Compact list row: bodies stay out of list results on purpose. */
export function distillMessage(row: unknown) {
  const item = (row && typeof row === "object" ? row : {}) as Record<
    string,
    unknown
  >;
  return {
    ...(str(item.message_id) ? { messageId: str(item.message_id) } : {}),
    ...(str(item.thread_id) ? { threadId: str(item.thread_id) } : {}),
    ...(str(item.from, 320) ? { from: str(item.from, 320) } : {}),
    ...(list(item.to) ? { to: list(item.to) } : {}),
    ...(str(item.timestamp) ? { timestamp: str(item.timestamp) } : {}),
    ...(str(item.subject, 300) ? { subject: str(item.subject, 300) } : {}),
    ...(list(item.labels) ? { labels: list(item.labels) } : {}),
    ...(str(item.preview, 300) ? { preview: str(item.preview, 300) } : {}),
  };
}

/** One message with bounded bodies; html is opt-in because it is token-heavy. */
export function distillMessageDetail(row: unknown, includeHtml = false) {
  const item = (row && typeof row === "object" ? row : {}) as Record<
    string,
    unknown
  >;
  const attachments = Array.isArray(item.attachments)
    ? item.attachments
        .slice(0, 20)
        .map((entry) => {
          const attachment = (
            entry && typeof entry === "object" ? entry : {}
          ) as Record<string, unknown>;
          return {
            ...(str(attachment.filename, 200)
              ? { filename: str(attachment.filename, 200) }
              : {}),
            ...(str(attachment.content_type, 100)
              ? { contentType: str(attachment.content_type, 100) }
              : {}),
            ...(typeof attachment.size === "number"
              ? { size: attachment.size }
              : {}),
          };
        })
        .filter((row) => Object.keys(row).length > 0)
    : undefined;
  const body =
    str(item.text, MAX_TEXT_FIELD) ?? str(item.extracted_text, MAX_TEXT_FIELD);
  return {
    ...distillMessage(item),
    ...(list(item.cc) ? { cc: list(item.cc) } : {}),
    ...(list(item.bcc) ? { bcc: list(item.bcc) } : {}),
    ...(list(item.reply_to) ? { replyTo: list(item.reply_to) } : {}),
    ...(body ? { text: body } : {}),
    ...(includeHtml
      ? {
          ...(str(item.html, MAX_TEXT_FIELD)
            ? { html: str(item.html, MAX_TEXT_FIELD) }
            : {}),
        }
      : {}),
    ...(attachments?.length ? { attachments } : {}),
  };
}

/** Bounded search match fragments per field; the API sends these only for fields
 * the query actually matched. */
export function distillHighlights(row: unknown) {
  const item = (row && typeof row === "object" ? row : {}) as Record<
    string,
    unknown
  >;
  const highlights =
    item.highlights && typeof item.highlights === "object"
      ? (item.highlights as Record<string, unknown>)
      : undefined;
  if (!highlights) return undefined;
  const fragments = (value: unknown) => {
    if (!Array.isArray(value)) return undefined;
    const out = value
      .filter((row): row is string => typeof row === "string" && !!row.trim())
      .slice(0, 3)
      .map((row) => row.trim().slice(0, 200));
    return out.length ? out : undefined;
  };
  const from = fragments(highlights.from);
  const recipients = fragments(highlights.recipients);
  const subject = fragments(highlights.subject);
  const text = fragments(highlights.text);
  const out = {
    ...(from ? { from } : {}),
    ...(recipients ? { recipients } : {}),
    ...(subject ? { subject } : {}),
    ...(text ? { text } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

/** Cursor for the next list/search page, when the API returns one. */
export function nextPageToken(data: unknown): string | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  return str(
    (data as Record<string, unknown>).next_page_token,
    512,
  );
}

/** HTTP success is 2xx only: redirects are surfaced, never followed. */
function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

function ok(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: value,
  };
}

function fail(value: unknown, isError = true) {
  return {
    isError,
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: value,
  };
}

function configFailure(resolution: Extract<ConfigResolution, { ok: false }>) {
  return fail({
    ok: false,
    kind: "config",
    error: resolution.error,
    nextStep: resolution.nextStep,
  });
}

function transportFailure(error: unknown, signal?: AbortSignal) {
  const message =
    (error instanceof Error ? error.message : String(error))
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300) || "AgentMail request failed";
  const cancelled = signal?.aborted === true || /abort|cancel/i.test(message);
  const validation =
    /must |is required|is not a valid|supports at most|at least one|needs at least/.test(
      message,
    );
  const kind = cancelled
    ? "cancelled"
    : validation
      ? "validation"
      : /timed out|timeout/i.test(message)
        ? "timeout"
        : /fetch failed|econn|enotfound|network|socket|dns/i.test(message)
          ? "network"
          : "unknown";
  return fail({
    ok: false,
    kind,
    error: message,
    retryable: kind === "timeout" || kind === "network",
    nextStep: validation
      ? "Fix the named field and retry."
      : cancelled
        ? "The request was cancelled; retry only if the result is still needed."
        : "Check connectivity and the configured base URL, then retry once.",
  });
}

const GUIDELINE =
  "Use agentmail_status before the first send to confirm the key and the inbox; keep agentmail_send recipients verified from a real source page, respect any suppression list, and never pad a campaign to a requested count.";

const SEND_SCHEMA = Type.Object({
  inboxId: Type.Optional(
    Type.String({
      maxLength: 320,
      description: "Sender inbox; defaults to AGENTMAIL_INBOX_ID.",
    }),
  ),
  to: Type.Union(
    [
      Type.String({ maxLength: 320 }),
      Type.Array(Type.String({ maxLength: 320 }), { maxItems: MAX_RECIPIENTS }),
    ],
    {
      description:
        "Recipient address(es), plain or `Display Name <user@domain>`.",
    },
  ),
  cc: Type.Optional(
    Type.Union([
      Type.String({ maxLength: 320 }),
      Type.Array(Type.String({ maxLength: 320 }), { maxItems: MAX_RECIPIENTS }),
    ]),
  ),
  bcc: Type.Optional(
    Type.Union([
      Type.String({ maxLength: 320 }),
      Type.Array(Type.String({ maxLength: 320 }), { maxItems: MAX_RECIPIENTS }),
    ]),
  ),
  replyTo: Type.Optional(
    Type.Union([
      Type.String({ maxLength: 320 }),
      Type.Array(Type.String({ maxLength: 320 }), { maxItems: MAX_RECIPIENTS }),
    ]),
  ),
  subject: Type.String({ maxLength: MAX_SUBJECT }),
  text: Type.Optional(
    Type.String({
      maxLength: MAX_BODY_BYTES,
      description: "Plain-text body; prefer this over html.",
    }),
  ),
  html: Type.Optional(Type.String({ maxLength: MAX_BODY_BYTES })),
  labels: Type.Optional(
    Type.Array(Type.String({ maxLength: MAX_LABEL }), { maxItems: MAX_LABELS }),
  ),
});

export default function agentMailTools(pi: any) {
  pi.registerTool({
    name: "agentmail_status",
    label: "AgentMail Status",
    description: `Report AgentMail email configuration (key from ${API_KEY_ENV}, default sender inbox from ${INBOX_ENV}) and, when configured, list the inboxes the key can use. Read-only; never prints the key.`,
    promptSnippet: "AgentMail configuration and inbox list",
    promptGuidelines: [GUIDELINE],
    parameters: Type.Object({
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    async execute(_id: any, params: { limit?: number }, signal: AbortSignal) {
      try {
        const resolution = resolveConfig();
        if (!resolution.ok)
          return ok({
            ok: false,
            configured: false,
            apiKeyEnv: API_KEY_ENV,
            defaultInboxId: process.env[INBOX_ENV]?.trim() || null,
            error: resolution.error,
            nextStep: resolution.nextStep,
          });
        const { config } = resolution;
        const { result, retried } = await getWithRetry(
          config,
          {
            path: "/v0/inboxes",
            query: [["limit", String(params.limit ?? 20)]],
            maxBytes: 8_192,
          },
          signal,
        );
        if (!isSuccess(result.status))
          return fail({
            ...describeApiFailure(result.status, result.data, result.text),
            ...(retried ? { retried: true as const } : {}),
          });
        const payload = (result.data ?? {}) as Record<string, unknown>;
        const rows = Array.isArray(payload.inboxes) ? payload.inboxes : [];
        const inboxes = rows.slice(0, 100).map((row: unknown) => {
          const item = (row && typeof row === "object" ? row : {}) as Record<
            string,
            unknown
          >;
          return {
            inboxId: str(item.inbox_id, 320) ?? null,
            email: str(item.email, 320) ?? null,
            ...(str(item.display_name, 320)
              ? { displayName: str(item.display_name, 320) }
              : {}),
          };
        });
        const count =
          typeof payload.count === "number" ? payload.count : inboxes.length;
        return ok({
          ok: true,
          configured: true,
          baseUrl: config.baseUrl,
          defaultInboxId: config.defaultInboxId ?? null,
          count,
          inboxes,
          ...(config.defaultInboxId &&
          !inboxes.some(
            (row) =>
              row.inboxId === config.defaultInboxId ||
              row.email === config.defaultInboxId,
          )
            ? {
                note: `${INBOX_ENV} is set to ${config.defaultInboxId}, which is not in this page of inboxes; verify it before sending.`,
              }
            : {}),
        });
      } catch (error) {
        return transportFailure(error, signal);
      }
    },
  });

  pi.registerTool({
    name: "agentmail_send",
    label: "AgentMail Send",
    description: `Send one email through AgentMail (outreach, replies or notices) via POST /v0/inboxes/{inboxId}/messages/send, defaulting to the configured sender inbox. Body text and/or html required; up to ${MAX_RECIPIENTS} recipients; subject required; CR/LF rejected. Sends immediately — verify the recipient, the sender identity and any opt-out requirement first.`,
    promptSnippet: "Send an email through AgentMail",
    promptGuidelines: [
      GUIDELINE,
      "Do not send to addresses guessed from search snippets; only addresses verified on a real page or from the user's list.",
      "Include an honest sender identity and an opt-out line in outreach mail, and never re-send to an address on the suppression list.",
    ],
    parameters: SEND_SCHEMA,
    async execute(_id: any, params: SendInput, signal: AbortSignal) {
      try {
        const resolution = resolveConfig();
        if (!resolution.ok) return configFailure(resolution);
        const { config } = resolution;
        const inboxId = validateInboxId(params.inboxId, config.defaultInboxId);
        const { envelope } = buildSendPayload(params, inboxId);
        const result = await agentMailRequest(
          config,
          {
            method: "POST",
            path: `/v0/inboxes/${encodeURIComponent(inboxId)}/messages/send`,
            body: envelope,
            maxBytes: 8_192,
          },
          signal,
        );
        if (!isSuccess(result.status))
          return fail({
            ...describeApiFailure(result.status, result.data, result.text),
            inboxId,
          });
        const data = (result.data ?? {}) as Record<string, unknown>;
        return ok({
          ok: true,
          status: result.status,
          inboxId,
          messageId: str(data.message_id, 256) ?? null,
          threadId: str(data.thread_id, 256) ?? null,
          to: envelope.to,
          subject: envelope.subject,
          ...(envelope.cc?.length ? { cc: envelope.cc } : {}),
          ...(envelope.bcc?.length ? { bcc: envelope.bcc } : {}),
        });
      } catch (error) {
        return transportFailure(error, signal);
      }
    },
  });

  pi.registerTool({
    name: "agentmail_messages",
    label: "AgentMail Messages",
    description:
      "List recent email messages in an AgentMail inbox (most recent first) with compact rows: ids, from/to, subject, timestamp, labels and a short preview. Filter by labels, sender, recipients or subject; follow nextPageToken through every page before concluding. Use agentmail_search to find mail by topic, agentmail_message to read a body.",
    promptSnippet: "List AgentMail inbox messages",
    promptGuidelines: [GUIDELINE],
    parameters: Type.Object({
      inboxId: Type.Optional(Type.String({ maxLength: 320 })),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: MAX_MESSAGE_LIST }),
      ),
      pageToken: Type.Optional(
        Type.String({
          maxLength: 512,
          description: "nextPageToken from a previous page.",
        }),
      ),
      labels: Type.Optional(
        Type.Array(Type.String({ maxLength: MAX_LABEL }), {
          maxItems: MAX_LABELS,
        }),
      ),
      from: Type.Optional(
        Type.String({
          maxLength: 200,
          description: "Substring match on the sender.",
        }),
      ),
      to: Type.Optional(
        Type.String({
          maxLength: 200,
          description: "Substring match on the recipients.",
        }),
      ),
      subject: Type.Optional(
        Type.String({
          maxLength: 200,
          description: "Substring match on the subject.",
        }),
      ),
      ascending: Type.Optional(
        Type.Boolean({ description: "Oldest first instead of newest first." }),
      ),
      includeSpam: Type.Optional(Type.Boolean()),
      includeTrash: Type.Optional(Type.Boolean()),
    }),
    async execute(_id: any, params: any, signal: AbortSignal) {
      try {
        const resolution = resolveConfig();
        if (!resolution.ok) return configFailure(resolution);
        const { config } = resolution;
        const inboxId = validateInboxId(params.inboxId, config.defaultInboxId);
        const query: Array<[string, string]> = [
          ["limit", String(params.limit ?? 20)],
        ];
        for (const label of validateLabels(params.labels))
          query.push(["labels", label]);
        const pageToken = text(params.pageToken, "pageToken", 512);
        if (pageToken) query.push(["page_token", pageToken]);
        const from = text(params.from, "from", 200);
        if (from) {
          if (!SEARCH_TEXT.test(from))
            bad("from", "must be a single-line substring");
          query.push(["from", from]);
        }
        const to = text(params.to, "to", 200);
        if (to) {
          if (!SEARCH_TEXT.test(to)) bad("to", "must be a single-line substring");
          query.push(["to", to]);
        }
        const subject = text(params.subject, "subject", 200);
        if (subject) {
          if (!SEARCH_TEXT.test(subject))
            bad("subject", "must be a single-line substring");
          query.push(["subject", subject]);
        }
        if (params.ascending === true) query.push(["ascending", "true"]);
        if (params.includeSpam === true) query.push(["include_spam", "true"]);
        if (params.includeTrash === true) query.push(["include_trash", "true"]);
        const { result, retried } = await getWithRetry(
          config,
          {
            path: `/v0/inboxes/${encodeURIComponent(inboxId)}/messages`,
            query,
            maxBytes: MESSAGE_LIST_BYTES,
          },
          signal,
        );
        if (!isSuccess(result.status))
          return fail({
            ...describeApiFailure(result.status, result.data, result.text),
            inboxId,
            ...(retried ? { retried: true as const } : {}),
          });
        const data = (result.data ?? {}) as Record<string, unknown>;
        const rows = Array.isArray(data.messages) ? data.messages : [];
        const token = nextPageToken(data);
        return ok({
          ok: true,
          inboxId,
          count: typeof data.count === "number" ? data.count : rows.length,
          messages: rows.slice(0, MAX_MESSAGE_LIST).map(distillMessage),
          ...(token ? { nextPageToken: token } : {}),
          ...(result.truncated ? { truncated: true } : {}),
        });
      } catch (error) {
        return transportFailure(error, signal);
      }
    },
  });

  pi.registerTool({
    name: "agentmail_search",
    label: "AgentMail Search",
    description:
      "Full-text relevance search across one AgentMail inbox: sender, recipients and subject by substring plus tokenized body text. Returns compact rows with per-field match highlights; spam, trash, blocked and unauthenticated mail are always excluded by the API. Follow nextPageToken through every page; read a body with agentmail_message.",
    promptSnippet: "Search AgentMail inbox messages",
    promptGuidelines: [GUIDELINE],
    parameters: Type.Object({
      q: Type.String({
        minLength: 1,
        maxLength: 200,
        description: "Full-text query matched against sender, recipients, subject and body.",
      }),
      inboxId: Type.Optional(Type.String({ maxLength: 320 })),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: MAX_MESSAGE_LIST }),
      ),
      pageToken: Type.Optional(
        Type.String({
          maxLength: 512,
          description: "nextPageToken from a previous page.",
        }),
      ),
      before: Type.Optional(
        Type.String({
          maxLength: 64,
          description: "Only mail before this ISO timestamp.",
        }),
      ),
      after: Type.Optional(
        Type.String({
          maxLength: 64,
          description: "Only mail after this ISO timestamp.",
        }),
      ),
    }),
    async execute(_id: any, params: any, signal: AbortSignal) {
      try {
        const resolution = resolveConfig();
        if (!resolution.ok) return configFailure(resolution);
        const { config } = resolution;
        const inboxId = validateInboxId(params.inboxId, config.defaultInboxId);
        const q = text(params.q, "q", 200, true)!;
        if (!SEARCH_TEXT.test(q)) bad("q", "must be a single-line query");
        const query: Array<[string, string]> = [
          ["q", q],
          ["limit", String(params.limit ?? 20)],
        ];
        const pageToken = text(params.pageToken, "pageToken", 512);
        if (pageToken) query.push(["page_token", pageToken]);
        for (const field of ["before", "after"] as const) {
          const bound = text(params[field], field, 64);
          if (bound) {
            if (!/^[^\r\n]{1,64}$/.test(bound))
              bad(field, "must be a single-line timestamp");
            query.push([field, bound]);
          }
        }
        const { result, retried } = await getWithRetry(
          config,
          {
            path: `/v0/inboxes/${encodeURIComponent(inboxId)}/messages/search`,
            query,
            maxBytes: MESSAGE_LIST_BYTES,
          },
          signal,
        );
        if (!isSuccess(result.status))
          return fail({
            ...describeApiFailure(result.status, result.data, result.text),
            inboxId,
            ...(retried ? { retried: true as const } : {}),
          });
        const data = (result.data ?? {}) as Record<string, unknown>;
        const rows = Array.isArray(data.messages) ? data.messages : [];
        const token = nextPageToken(data);
        return ok({
          ok: true,
          inboxId,
          count: typeof data.count === "number" ? data.count : rows.length,
          messages: rows.slice(0, MAX_MESSAGE_LIST).map((row) => {
            const highlights = distillHighlights(row);
            return {
              ...distillMessage(row),
              ...(highlights ? { highlights } : {}),
            };
          }),
          ...(token ? { nextPageToken: token } : {}),
          ...(result.truncated ? { truncated: true } : {}),
        });
      } catch (error) {
        return transportFailure(error, signal);
      }
    },
  });

  pi.registerTool({
    name: "agentmail_message",
    label: "AgentMail Message",
    description:
      "Read one AgentMail email message body by id (from agentmail_messages or agentmail_search). Returns bounded plain text plus metadata; set includeHtml only when the HTML form is actually needed.",
    promptSnippet: "Read one AgentMail message",
    promptGuidelines: [GUIDELINE],
    parameters: Type.Object({
      id: Type.String({
        maxLength: 256,
        description: "Message id from agentmail_messages or agentmail_search.",
      }),
      inboxId: Type.Optional(Type.String({ maxLength: 320 })),
      includeHtml: Type.Optional(
        Type.Boolean({
          description:
            "Also return the HTML body (token-heavy; default false).",
        }),
      ),
    }),
    async execute(_id: any, params: any, signal: AbortSignal) {
      try {
        const resolution = resolveConfig();
        if (!resolution.ok) return configFailure(resolution);
        const { config } = resolution;
        const inboxId = validateInboxId(params.inboxId, config.defaultInboxId);
        const messageId = validateMessageId(params.id);
        const { result, retried } = await getWithRetry(
          config,
          {
            path: `/v0/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(messageId)}`,
            maxBytes: MESSAGE_DETAIL_BYTES,
          },
          signal,
        );
        if (!isSuccess(result.status))
          return fail({
            ...describeApiFailure(result.status, result.data, result.text),
            inboxId,
            messageId,
            ...(retried ? { retried: true as const } : {}),
          });
        return ok({
          ok: true,
          inboxId,
          ...distillMessageDetail(result.data, params.includeHtml === true),
          ...(result.truncated ? { truncated: true } : {}),
        });
      } catch (error) {
        return transportFailure(error, signal);
      }
    },
  });
}
