import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";

const release = path.resolve(import.meta.dirname, "..");
const roots = [release, path.resolve(release, ".."), path.resolve(release, "../..")];
const root = roots.find(candidate => fs.existsSync(path.join(candidate, "agent", "skills"))) ?? release;
const skillsRoot = path.join(root, "agent", "skills");

function inventory() {
  return fs.readdirSync(skillsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const file = path.join(skillsRoot, entry.name, "SKILL.md");
      if (!fs.existsSync(file)) return null;
      const lines = fs.readFileSync(file, "utf8").split("\n");
      const end = lines.indexOf("---", 1);
      assert.ok(end > 0, `${entry.name}: frontmatter is required`);
      const frontmatter = parse(lines.slice(1, end).join("\n")) ?? {};
      return { name: entry.name, file, frontmatter, body: lines.slice(end + 1).join("\n") };
    })
    .filter(Boolean);
}

test("every shipped skill has a unique routable manifest and resolvable references", () => {
  const entries = inventory();
  assert.ok(entries.length > 0, "the public skill catalogue is empty");
  const names = new Set();
  for (const entry of entries) {
    const { name, frontmatter, body } = entry;
    assert.equal(frontmatter.name, name, `${name}: name must match its directory`);
    assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${name}: invalid routable name`);
    assert.equal(names.has(name), false, `${name}: duplicate skill name`);
    names.add(name);
    assert.equal(typeof frontmatter.description, "string", `${name}: description is required`);
    assert.ok(frontmatter.description.trim().length >= 40, `${name}: description is too vague`);
    assert.ok(frontmatter.description.length <= 1024, `${name}: description exceeds loader limit`);
    assert.ok(body.trim(), `${name}: body is empty`);
    for (const line of body.split("\n")) {
      const start = line.indexOf("](");
      if (start < 0) continue;
      const target = line.slice(start + 2).split(")", 1)[0].split("#", 1)[0];
      if (!target.startsWith("references/") && !target.startsWith("assets/")) continue;
      assert.ok(fs.existsSync(path.join(path.dirname(entry.file), target)), `${name}: missing ${target}`);
    }
  }
});
