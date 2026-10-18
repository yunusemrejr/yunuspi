import test from "node:test";
import assert from "node:assert/strict";
import { closestCommand, correctSlashCommands, describeCorrection } from "../core/coding-agent/src/core/command-correction.js";

const commands = ["goal", "noslop", "nobug", "3d", "video", "anatomy", "model", "models", "budget", "used", "user", "name", "new"];
const chainable = ["goal", "noslop", "nobug", "3d", "video", "anatomy"];
const check = (text) => correctSlashCommands(text, { commands, chainable });

test("a mistyped leading command or chained boost is corrected in place", () => {
  assert.deepEqual(check("/3d /noslop /nobugs make a film"), { text: "/3d /noslop /nobug make a film", fixes: [{ from: "/nobugs", to: "/nobug" }] });
  assert.deepEqual(check("/nobugs fix login"), { text: "/nobug fix login", fixes: [{ from: "/nobugs", to: "/nobug" }] });
  assert.equal(check("/nosloop /anatomie /vidoe go").text, "/noslop /anatomy /video go");
  assert.equal(check("/goal ship it /nobugz /3ds").text, "/goal ship it /nobug /3d");
  assert.equal(check("/vid make").text, "/video make", "a unique prefix completes");
  assert.equal(check("/3D /video x").text, "/3d /video x", "case-only differences resolve to the registered name");
});

test("known commands, paths, code spans, prose and ambiguous names are left alone", () => {
  for (const text of ["/models", "/3d /video. make /tmp/x and `/nobugs`", "/etc/hosts broken", "hello /nobugs", "/skill:anatomy x"])
    assert.equal(check(text), undefined, text);
  assert.equal(check("/model /nobugs"), undefined, "boosts are only checked after a chainable command");
  assert.equal(closestCommand("use", ["used", "user"]), undefined, "a tie offers nothing");
  assert.deepEqual(check("/xyz hello"), { text: "/xyz hello", fixes: [], unknown: "/xyz" });
});

test("the correction reads as one question", () => {
  assert.equal(describeCorrection([{ from: "/nobugs", to: "/nobug" }]), "Did you mean /nobug (not /nobugs)?");
  assert.equal(describeCorrection([{ from: "/a", to: "/b" }, { from: "/c", to: "/d" }, { from: "/e", to: "/f" }]), "Did you mean /b (not /a), /d (not /c) and /f (not /e)?");
});


test("a sentence mark after a leading command is dropped, not sent as prose", () => {
  assert.deepEqual(check("/3d. make X"), { text: "/3d make X", fixes: [{ from: "/3d.", to: "/3d" }] });
  assert.deepEqual(check("/noslop, tidy it"), { text: "/noslop tidy it", fixes: [{ from: "/noslop,", to: "/noslop" }] });
  assert.equal(check("/3d. make X").unknown, undefined);
});

test("tilde fenced code is text, never commands or corrections", () => {
  assert.equal(check("/3d build this example\n~~~\n/nobugs /vidoe\n~~~\ndone"), undefined);
  assert.equal(check("run this:\n~~~\n/3d /nobugz\n~~~"), undefined);
});
