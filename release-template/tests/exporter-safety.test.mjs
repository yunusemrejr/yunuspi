import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const exporter = [
  path.join(root, "agent/scripts/harness-public-export.mjs"),
  path.resolve(root, "../scripts/harness-public-export.mjs"),
].find((p) => fs.existsSync(p));
assert.ok(exporter, "exporter must be shipped");
const { CORE_COMPATIBILITY_TESTS } = await import(
  pathToFileURL(path.join(path.dirname(exporter), "lib/core-compatibility.mjs")),
);
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-safety-"));
  const source = path.join(dir, "source"),
    templates = path.join(dir, "templates"),
    output = path.join(dir, "output");
  for (const name of ["extensions", "skills", "scripts", "npm"])
    fs.mkdirSync(path.join(source, name), { recursive: true });
  fs.mkdirSync(path.join(templates, "scripts"), { recursive: true });
  fs.copyFileSync(
    path.join(root, "scripts/check-public.mjs"),
    path.join(templates, "scripts/check-public.mjs"),
  );
  fs.writeFileSync(
    path.join(source, "extensions/live-models.ts"),
    "export const live = true;\n",
  );
  fs.writeFileSync(
    path.join(source, "extensions/manifest.json"),
    JSON.stringify({ supportFiles: [] }),
  );
  for (const name of ["package.json", "package-lock.json"])
    fs.writeFileSync(path.join(source, "npm", name), "{}");
  return {
    dir,
    source,
    templates,
    output,
    run: () =>
      spawnSync(
        process.execPath,
        [
          exporter,
          "--source",
          source,
          "--templates",
          templates,
          "--output",
          output,
        ],
        { encoding: "utf8" },
      ),
  };
}
test("default installed export uses current runtime templates before legacy templates", () => {
  const f = fixture();
  try {
    for (const [relative, marker] of [['public-template', 'stale'], ['runtime/release-template', 'current']]) {
      const target = path.join(f.source, relative);
      fs.cpSync(f.templates, target, { recursive: true });
      fs.mkdirSync(path.join(target, 'docs'));
      fs.writeFileSync(path.join(target, 'docs/INSTALL.md'), marker);
    }
    const result = spawnSync(process.execPath, [exporter, '--source', f.source, '--output', f.output], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(f.output, 'docs/INSTALL.md'), 'utf8'), 'current');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});
test("exporter rejects exact OAuth and account canaries without exposing their values", () => {
  for (const field of ["access", "refresh", "accountId", "clientSecret", "client_secret", "privateKey", "sessionToken"]) {
    const f = fixture();
    try {
      const value = ["private", field, "export", "canary", "90871"].join("-");
      fs.writeFileSync(
        path.join(f.source, "auth.json"),
        JSON.stringify({ provider: { [field]: value } }),
      );
      fs.writeFileSync(
        path.join(f.source, "extensions/leak.ts"),
        "// " + value,
      );
      const result = f.run();
      assert.notEqual(result.status, 0);
      assert.ok(!`${result.stdout}${result.stderr}`.includes(value));
      assert.ok(!fs.existsSync(f.output));
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(f.source, "auth.json"))).provider[
          field
        ],
        value,
      );
    } finally {
      fs.rmSync(f.dir, { recursive: true, force: true });
    }
  }
});

test("credential headers and bare authorization tokens cannot leak into public source or diagnostics", () => {
  for (const [header, scheme] of [
    ['X-API-Key', ''], ['X-Auth-Token', ''], ['Ocp-Apim-Subscription-Key', ''],
    ['Authorization', 'Bearer '], ['authorization', 'bEaReR '], ['Authorization', 'Token '],
    ['Authorization', 'Basic '], ['Proxy-Authorization', 'ApiKey '],
  ]) {
    const f = fixture();
    const value = ['opaque', 'fixture', 'credential', 'a19bd2e043'].join('-');
    try {
      fs.writeFileSync(path.join(f.source, 'models.json'), JSON.stringify({ providers: { fixture: {
        baseUrl: 'https://api.example.com/v1', headers: { [header]: scheme + value },
      } } }));
      fs.writeFileSync(path.join(f.source, 'extensions/diagnostic.md'), 'Synthetic diagnostic marker: ' + value);
      const result = f.run();
      assert.notEqual(result.status, 0, header + scheme);
      assert.equal(`${result.stdout}${result.stderr}`.includes(value), false, 'matched values stay out of diagnostics');
      assert.equal(fs.existsSync(f.output), false, 'rejected staged output is never published');
      assert.equal(JSON.parse(fs.readFileSync(path.join(f.source, 'models.json'))).providers.fixture.headers[header], scheme + value);
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  }
});

test("ordinary provider endpoints, headers and environment references remain exportable", () => {
  const f = fixture();
  try {
    const endpoint = 'https://api.example.com/v1';
    fs.writeFileSync(path.join(f.source, 'models.json'), JSON.stringify({ providers: { fixture: {
      baseUrl: endpoint, description: 'Public endpoint documentation',
      headers: { 'HTTP-Referer': endpoint, 'User-Agent': 'public-example-client', 'X-API-Key': 'EXAMPLE_API_KEY' },
    } } }));
    fs.writeFileSync(path.join(f.source, 'extensions/README.md'), `${endpoint}\npublic-example-client\nEXAMPLE_API_KEY\nPublic endpoint documentation`);
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(fs.readFileSync(path.join(f.output, 'agent/extensions/README.md'), 'utf8'), /api\.example\.com/);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});
test("exporter refuses symlinked copy roots and allowlisted compatibility files", () => {
  const f = fixture();
  try {
    const outsideExtensions = path.join(f.dir, "outside-extensions");
    fs.renameSync(path.join(f.source, "extensions"), outsideExtensions);
    fs.symlinkSync(outsideExtensions, path.join(f.source, "extensions"));
    const linkedRoot = f.run();
    assert.notEqual(linkedRoot.status, 0);
    assert.equal(fs.existsSync(f.output), false);
    assert.ok(fs.existsSync(path.join(outsideExtensions, "live-models.ts")));
    fs.unlinkSync(path.join(f.source, "extensions"));
    fs.renameSync(outsideExtensions, path.join(f.source, "extensions"));

    const compatibility = path.join(f.source, "scripts/compatibility");
    fs.mkdirSync(compatibility, { recursive: true });
    fs.writeFileSync(path.join(f.source, "scripts/core-update.mjs"), "// fixture\n");
    for (const name of CORE_COMPATIBILITY_TESTS)
      fs.writeFileSync(path.join(compatibility, name), "// public fixture\n");
    const outsidePrivate = path.join(f.dir, "PRIVATE-NOTES.mjs");
    fs.writeFileSync(outsidePrivate, "// private target bytes\n");
    const linkedName = CORE_COMPATIBILITY_TESTS[0];
    fs.unlinkSync(path.join(compatibility, linkedName));
    fs.symlinkSync(outsidePrivate, path.join(compatibility, linkedName));
    const linkedFile = f.run();
    assert.notEqual(linkedFile.status, 0);
    assert.equal(fs.existsSync(f.output), false);
    assert.equal(fs.readFileSync(outsidePrivate, "utf8"), "// private target bytes\n");
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});
test("exporter refuses nonempty destinations and preserves existing files", () => {
  const f = fixture();
  try {
    fs.mkdirSync(f.output);
    fs.writeFileSync(path.join(f.output, "existing.txt"), "keep");
    assert.notEqual(f.run().status, 0);
    assert.equal(
      fs.readFileSync(path.join(f.output, "existing.txt"), "utf8"),
      "keep",
    );
    assert.deepEqual(fs.readdirSync(f.output), ["existing.txt"]);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});
test("clean fixture exports without copying private configuration", () => {
  const f = fixture();
  try {
    fs.writeFileSync(
      path.join(f.source, "auth.json"),
      JSON.stringify({
        provider: {
          access: ["private", "credential", "not", "in", "source"].join("-"),
        },
      }),
    );
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.ok(
      fs.existsSync(path.join(f.output, "agent/extensions/live-models.ts")),
    );
    assert.ok(!fs.existsSync(path.join(f.output, "agent/auth.json")));
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("portable inference service templates ship without private units or model state", () => {
  const f = fixture();
  try {
    const units = path.join(f.source, "scripts/systemd");
    fs.mkdirSync(units);
    // The retired SmolLM unit is no longer a portable template: like a
    // personal unit it stays private (the local LM unit is generated at install).
    const names = ["pi-mini-preprocessor.service"];
    const privateUnits = ["personal-task.service", "pi-smol-preprocessor.service"];
    for (const name of [...names, ...privateUnits])
      fs.writeFileSync(
        path.join(units, name),
        "[Service]\nExecStart=%h/.pi/agent/scripts/worker\n",
      );
    fs.writeFileSync(
      path.join(f.source, "extensions/manifest.json"),
      JSON.stringify({
        supportFiles: [...names, ...privateUnits].map(
          (name) => "scripts/systemd/" + name,
        ),
      }),
    );
    fs.mkdirSync(path.join(f.source, "local-models"));
    fs.writeFileSync(
      path.join(f.source, "local-models/runtime.json"),
      JSON.stringify({ apiKey: "TEST_PRIVATE_RUNTIME_CANARY" }),
    );
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      fs.readdirSync(path.join(f.output, "agent/scripts/systemd")).sort(),
      names,
    );
    assert.equal(
      fs.existsSync(path.join(f.output, "agent/local-models")),
      false,
    );
    assert.deepEqual(
      JSON.parse(
        fs.readFileSync(path.join(f.output, "agent/extensions/manifest.json")),
      ).supportFiles,
      names.map((name) => "scripts/systemd/" + name),
    );
    fs.rmSync(f.output, { recursive: true });
    fs.unlinkSync(path.join(units, names[0]));
    fs.symlinkSync(
      path.join(f.source, "local-models/runtime.json"),
      path.join(units, names[0]),
    );
    const linked = f.run();
    assert.notEqual(linked.status, 0);
    assert.equal(
      fs.existsSync(f.output),
      false,
      "a symlink must never copy private state through a service name",
    );
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});
test("a registered capability catalog cannot publish without its inventory generator", () => {
  const f = fixture();
  try {
    fs.writeFileSync(
      path.join(f.source, "extensions/manifest.json"),
      JSON.stringify({ supportFiles: [], lib: ["harness-capabilities.ts"] }),
    );
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Capability inventory generator missing/);
    assert.equal(fs.existsSync(f.output), false);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});
test("exporter refuses a hardcoded home path in executable source but sanitizes docs", () => {
  const f = fixture();
  try {
    const literal = path.join(
      os.homedir(),
      ".pi/agent/extensions/pi-lens/dist/index.js",
    );
    fs.mkdirSync(path.join(f.source, "scripts/lib"), { recursive: true });
    fs.mkdirSync(path.join(f.source, "skills/example"), { recursive: true });
    fs.writeFileSync(
      path.join(f.source, "scripts/lib/example.mjs"),
      `const DIST = ${JSON.stringify(literal)};\n`,
    );
    fs.writeFileSync(
      path.join(f.source, "skills/example/SKILL.md"),
      `Install under ${os.homedir()}/.pi/agent and read the notes.\n`,
    );
    const rejected = f.run();
    assert.notEqual(rejected.status, 0);
    assert.match(`${rejected.stdout}${rejected.stderr}`, /Hardcoded home path/);
    assert.ok(!fs.existsSync(f.output));

    // Documentation keeps the privacy substitution instead of failing.
    fs.rmSync(path.join(f.source, "scripts/lib/example.mjs"));
    const accepted = f.run();
    assert.equal(accepted.status, 0, accepted.stderr);
    const shipped = fs.readFileSync(
      path.join(f.output, "agent/skills/example/SKILL.md"),
      "utf8",
    );
    assert.ok(shipped.includes("/home/example/.pi/agent"));
    assert.ok(!shipped.includes(os.homedir()));
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("template dependency installs are omitted from both exported roots", () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.templates, "node_modules/.bin"), {
      recursive: true,
    });
    fs.symlinkSync(
      "/unreadable/dependency",
      path.join(f.templates, "node_modules/.bin/tool"),
    );
    fs.writeFileSync(
      path.join(f.templates, "node_modules/generated.js"),
      "generated dependency",
    );
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(f.output, "node_modules")), false);
    assert.equal(
      fs.existsSync(path.join(f.output, "release-template/node_modules")),
      false,
    );
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("fork export selects the installation's owned source and rejects linked metadata", () => {
  for (const linked of [false, true]) {
    const f = fixture();
    try {
      fs.writeFileSync(path.join(f.templates, "package.json"), JSON.stringify({ workspaces: ["core/*"] }));
      for (const [directory, body] of [[path.join(f.dir, "core"), "template baseline"], [path.join(f.source, "runtime/core"), "owned local fix"]]) {
        fs.mkdirSync(path.join(directory, "coding-agent/src"), { recursive: true });
        fs.writeFileSync(path.join(directory, "identity.json"), JSON.stringify({ releaseAuthority: "yunusemrejr/yunuspi" }));
        fs.writeFileSync(path.join(directory, "coding-agent/package.json"), JSON.stringify({ name: "@yunuspi/coding-agent" }));
        fs.writeFileSync(path.join(directory, "coding-agent/src/cli.js"), `// ${body}\n`);
        const assets = path.join(directory, "coding-agent/src/core/export-html");
        fs.mkdirSync(assets, { recursive: true });
        for (const ext of ["html", "css"]) fs.writeFileSync(path.join(assets, `template.${ext}`), `/* ${body} */`);
      }
      const skillAssets = path.join(f.source, "skills/motion-graphics-production/assets");
      fs.mkdirSync(skillAssets, { recursive: true });
      fs.writeFileSync(path.join(skillAssets, "timeline-starter.html"), "<p>synthetic timeline</p>");
      fs.writeFileSync(path.join(skillAssets, "private-session.html"), "<p>must remain excluded</p>");
      if (linked) {
        const manifest = path.join(f.source, "runtime/core/coding-agent/package.json");
        fs.unlinkSync(manifest);
        fs.symlinkSync(path.join(f.dir, "core/coding-agent/package.json"), manifest);
      }
      const result = f.run();
      if (linked) {
        assert.notEqual(result.status, 0);
        assert.equal(fs.existsSync(f.output), false);
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(fs.readFileSync(path.join(f.output, "core/coding-agent/src/cli.js"), "utf8"), "// owned local fix\n");
        for (const ext of ["html", "css"]) assert.equal(fs.readFileSync(path.join(f.output, `core/coding-agent/src/core/export-html/template.${ext}`), "utf8"), "/* owned local fix */");
        assert.equal(fs.readFileSync(path.join(f.output, "agent/skills/motion-graphics-production/assets/timeline-starter.html"), "utf8"), "<p>synthetic timeline</p>");
        assert.equal(fs.existsSync(path.join(f.output, "agent/skills/motion-graphics-production/assets/private-session.html")), false);
      }
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  }
});
