/**
 * Yuncontext: what past sessions of every harness did in each project, as two native tools.
 *
 * The local service (127.0.0.1:47123) speaks JSON-RPC 2.0 over HTTP. Each call is one POST of
 * `tools/call`; the server is stateless, so no handshake is needed. Tool names, descriptions and
 * schemas match ~/.yuncontext/yuncontext/protocol.py, except `cwd` is optional here and defaults
 * to the session's working directory.
 *
 * Ambient extension: it loads in the main session, in ordinary subagent children and in forks
 * (all of them use buildPiArgs). Builtin agents with a strict `tools:` allowlist list the names.
 */
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { choices } from "./lib/tool-schema.ts";

const ENDPOINT = "http://127.0.0.1:47123/mcp";
const TOKEN_FILE = path.join(os.homedir(), ".config", "yuncontext", "token");
const TIMEOUT_MS = 20_000;
const CLIENT = "yunuspi";
const UNAVAILABLE = "yuncontext is not running right now; carry on without it.";

type ToolReply = { content: { type: "text"; text: string }[]; isError: boolean };

const unavailable = (): ToolReply => ({ content: [{ type: "text", text: UNAVAILABLE }], isError: true });

/** One `tools/call`. Any transport, auth or protocol failure becomes the unavailable reply; a tool
 * error from the service passes through with its own text and `isError`. */
async function callYuncontext(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolReply> {
  let token: string;
  try {
    token = (await readFile(TOKEN_FILE, "utf8")).trim();
  } catch {
    return unavailable();
  }
  if (!token) return unavailable();
  let reply: any;
  try {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const response = await fetch(ENDPOINT, {
      method: "POST",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "X-Yuncontext-Client": CLIENT,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    if (!response.ok) return unavailable();
    reply = await response.json();
  } catch {
    return unavailable();
  }
  const text = reply?.result?.content?.[0]?.text;
  if (typeof text !== "string") return unavailable();
  return { content: [{ type: "text", text }], isError: reply.result.isError === true };
}

export default function registerYuncontext(pi: any) {
  pi.registerTool({
    name: "yuncontext",
    label: "Yuncontext",
    description:
      "Past work in this project from all agent harnesses on this machine. No q: project brief (use at " +
      "task start). q: exact error text, path, symbol or task words (use on any error or before non-trivial " +
      "work). ref: details of one result. Returns ≤3 dated, sourced clues or nothing; the current request wins.",
    parameters: Type.Object({
      cwd: Type.Optional(Type.String({ description: "Absolute path of your current working directory. Defaults to this session's." })),
      q: Type.Optional(Type.String({ maxLength: 2000 })),
      ref: Type.Optional(Type.String({ pattern: "^y[0-9a-z]{1,10}$" })),
    }),
    async execute(_id: string, args: any, signal?: AbortSignal, _update?: unknown, ctx?: any) {
      return callYuncontext("yuncontext", { ...args, cwd: args.cwd ?? ctx?.cwd ?? process.cwd() }, signal);
    },
  });

  pi.registerTool({
    name: "yuncontext_record",
    label: "Yuncontext record",
    description:
      "Save one verified lesson for this project so later sessions in any harness reuse it: a fix that " +
      "worked, a root cause, an owner preference, or newer facts that replace a yuncontext result " +
      "(supersedes = its ref). Skip routine steps; never include secrets. Append-only; duplicates are ignored.",
    parameters: Type.Object({
      cwd: Type.Optional(Type.String({ description: "Absolute path of your current working directory. Defaults to this session's." })),
      what: Type.String({ minLength: 10, maxLength: 400, description: "The lesson or fact, self-contained." }),
      how: Type.Optional(Type.String({ maxLength: 600, description: "What worked / how to apply it." })),
      outcome: choices(["worked", "failed", "partial", "info"]),
      error: Type.Optional(Type.String({ maxLength: 300, description: "Exact error text, if any." })),
      files: Type.Optional(Type.Array(Type.String(), { maxItems: 10 })),
      supersedes: Type.Optional(Type.String({ pattern: "^y[0-9a-z]{1,10}$" })),
    }),
    async execute(_id: string, args: any, signal?: AbortSignal, _update?: unknown, ctx?: any) {
      return callYuncontext("yuncontext_record", { ...args, cwd: args.cwd ?? ctx?.cwd ?? process.cwd() }, signal);
    },
  });
}
