import test from "node:test";
import assert from "node:assert/strict";
import { commandTokens, correctSlashCommands } from "../core/coding-agent/src/core/command-correction.js";

const commands = ["goal", "noslop", "nobug", "3d", "video", "anatomy", "model", "models", "budget", "used", "user", "name", "new"];
const chainable = ["goal", "noslop", "nobug", "3d", "video", "anatomy"];
const tokens = (text) => commandTokens(text, { commands, chainable });

test("the leading token and each chained boost slice back to their exact text", () => {
  const raw = "/3d /video make a film";
  const found = tokens(raw);
  assert.deepEqual(found.map((token) => raw.slice(token.start, token.end)), ["/3d", "/video"]);
  assert.deepEqual(found.map(({ name, known, chained }) => ({ name, known, chained })), [
    { name: "3d", known: true, chained: false },
    { name: "video", known: true, chained: true },
  ]);
});

test("leading whitespace shifts the token start, not its text", () => {
  const raw = "  /goal /3d /video x";
  const found = tokens(raw);
  assert.equal(found[0].start, 2);
  assert.deepEqual(found.map((token) => raw.slice(token.start, token.end)), ["/goal", "/3d", "/video"]);
});

test("only a chainable known head chains; any other head yields just itself", () => {
  assert.deepEqual(tokens("/model /video x").map((token) => token.name), ["model"]);
  assert.deepEqual(tokens("/budget /video x").map((token) => token.name), ["budget"]);
  const unknownHead = "/zzz /video x";
  assert.deepEqual(tokens(unknownHead).map((token) => [unknownHead.slice(token.start, token.end), token.known]), [["/zzz", false]]);
});

test("a chained name that matches no boost is reported as unknown, with its own text", () => {
  const raw = "/3d /autonomy /video go";
  const found = tokens(raw);
  assert.deepEqual(found.map((token) => raw.slice(token.start, token.end)), ["/3d", "/autonomy", "/video"]);
  assert.equal(found[1].known, false);
  assert.equal(found[1].chained, true);
});

test("a mistyped chained boost is listed as unknown but still located", () => {
  const raw = "/3d /nobugs make it";
  const found = tokens(raw);
  assert.equal(raw.slice(found[1].start, found[1].end), "/nobugs");
  assert.equal(found[1].known, false);
});

test("tokens inside code spans and paths are not commands", () => {
  const raw = "/3d /video `/nobugs` /tmp/x";
  assert.deepEqual(tokens(raw).map((token) => raw.slice(token.start, token.end)), ["/3d", "/video"]);
  assert.deepEqual(tokens("hello /3d"), []);
  assert.deepEqual(tokens(""), []);
});

test("a goal with a chained boost is a clean check: no correction, no unrecognized", () => {
  assert.equal(correctSlashCommands("/goal resume", { commands, chainable }), undefined);
  assert.equal(correctSlashCommands("/3d /video /nobug make it", { commands, chainable }), undefined);
});

test("correction reports the chained token that matches no boost and fixes the near one", () => {
  const raw = "/3d /video /autonomy /noslop /nobugs make a film";
  const found = correctSlashCommands(raw, { commands: ["3d", "video", "noslop", "nobug", "goal", "model"], chainable: ["3d", "video", "noslop", "nobug", "goal"] });
  assert.deepEqual(found, {
    text: "/3d /video /autonomy /noslop /nobug make a film",
    fixes: [{ from: "/nobugs", to: "/nobug" }],
    unrecognized: ["/autonomy"],
  });
});

test("digits-only chained tokens are neither fixed nor reported", () => {
  assert.equal(correctSlashCommands("/3d /2 x", { commands, chainable }), undefined);
});

test("a number after a boost is not a command token, matching correction", () => {
  const names = { commands: ["3d", "video", "goal"], chainable: ["3d", "video", "goal"] };
  assert.deepEqual(commandTokens("/3d /2 shots", names).map((token) => token.name), ["3d"]);
  assert.equal(correctSlashCommands("/3d /2 shots", names), undefined);
});
