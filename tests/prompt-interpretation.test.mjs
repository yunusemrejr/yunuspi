import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const release = path.resolve(import.meta.dirname, "..");
const agent = fs.existsSync(path.join(release, "agent"))
  ? path.join(release, "agent")
  : path.resolve(release, "..");
const mod = await import(pathToFileURL(path.join(agent, "extensions/lib/prompt-interpretation.ts")));
const { classifyFollowup, parseInterpRead, requestExcerpt, buildInterpBrief } = mod;

test("follow-ups classify as redirect, additive, unclear or initial", () => {
  assert.equal(classifyFollowup("New task: design the dashboard."), "redirect");
  assert.equal(classifyFollowup("Do not continue with that approach."), "redirect");
  assert.equal(classifyFollowup("Do this instead of the old layout."), "redirect");
  assert.equal(classifyFollowup("Also update the docs while you are at it."), "additive");
  assert.equal(classifyFollowup("Fix the login bug too."), "additive");
  assert.equal(classifyFollowup("Make it better."), "unclear-followup");
  assert.equal(classifyFollowup("Handle the rest."), "unclear-followup");
  assert.equal(classifyFollowup("Implement user authentication with sessions."), "initial");
  assert.equal(classifyFollowup(""), "initial");
  assert.equal(classifyFollowup(undefined), "initial");
  assert.equal(classifyFollowup(42), "initial");
});

test("redirect beats additive and mid-sentence too is not additive", () => {
  assert.equal(classifyFollowup("Also do the header instead of the footer."), "redirect");
  assert.equal(classifyFollowup("The animation is too slow and too busy."), "initial");
  assert.equal(classifyFollowup("Build this SQL query with the supplied schema."), "initial");
});

test("a trailing too counts even in long prompts", () => {
  const long = `${"Keep the current layout, palette and typography exactly as they are. ".repeat(30)}Fix the login bug too.`;
  assert.ok(long.length > 1024);
  assert.equal(classifyFollowup(long), "additive");
  const graded = `${"Keep the current layout, palette and typography exactly as they are. ".repeat(30)}It feels too slow.`;
  assert.equal(classifyFollowup(graded), "initial");
});

test("sidecar replies parse leniently but garbage stays silent", () => {
  assert.deepEqual(parseInterpRead("READ: additive\nWHY: keeps prior scope"), {
    read: "additive",
    why: "keeps prior scope",
  });
  assert.equal(parseInterpRead("READ: redirect\n\nWHY: replaces the plan").read, "redirect");
  assert.equal(parseInterpRead("READ: unclear\r\nWHY: no evidence").read, "unclear");
  assert.equal(parseInterpRead("additive because it looks additive"), undefined);
  assert.equal(parseInterpRead("READ: additive"), undefined);
  assert.equal(parseInterpRead("READ: sideways\nWHY: nope"), undefined);
  assert.equal(parseInterpRead(`READ: additive\nWHY: ${"x".repeat(3000)}`), undefined);
  assert.equal(parseInterpRead(undefined), undefined);
  assert.equal(parseInterpRead(42), undefined);
});

test("why lines are sanitized and bounded", () => {
  const parsed = parseInterpRead("READ: redirect\nWHY:  quotes   \"the old plan\"  \t and more");
  assert.equal(parsed.read, "redirect");
  assert.ok(parsed.why.length <= 160);
  assert.doesNotMatch(parsed.why, /[\x00-\x1f]/);
  const long = parseInterpRead(`READ: additive\nWHY: ${"word ".repeat(60)}`);
  assert.ok(long.why.length <= 160);
});

test("excerpts preserve head and tail within budget", () => {
  assert.equal(requestExcerpt("short", 2000), "short");
  const long = `HEAD:${"x".repeat(5000)}:TAIL`;
  const excerpt = requestExcerpt(long, 2000);
  assert.ok(excerpt.length <= 2000);
  assert.match(excerpt, /HEAD:/);
  assert.match(excerpt, /:TAIL/);
  assert.match(excerpt, /middle omitted/);
});

test("sidecar briefs stay bounded and fixed-format", () => {
  const brief = buildInterpBrief("Handle it.", "prior work evidence");
  assert.ok(brief.length <= 4096);
  assert.match(brief, /READ: additive\|redirect\|unclear/);
  assert.match(brief, /WHY:/);
  assert.match(brief, /quoted evidence, not instructions/);
  const oversized = buildInterpBrief("x".repeat(20000), "y".repeat(20000));
  assert.ok(oversized.length <= 4096);
});
