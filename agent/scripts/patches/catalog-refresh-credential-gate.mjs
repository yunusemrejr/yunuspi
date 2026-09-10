// Catalog-refresh credential-gate patch — re-applied by verify-harness.mjs [9].
// Lives OUTSIDE node_modules so it survives `npm update`; the patched files
// (pi-ai models.js + pi bundle chunk) do not.
//
// WHAT: the ModelsImpl.refresh() method in pi-ai gates ALL network catalog
// refreshes behind `if (!credential) return;` after resolveRefreshCredential().
// For providers that use withRemoteCatalog (pi.dev catalog), no provider API
// key is needed — the catalog is fetched from pi.dev. But since providers
// without a configured key (baseten, deepseek, etc.) return undefined from
// resolveRefreshCredential(), their network refresh is SKIPPED entirely.
//
// The result: those provider catalogs go stale (checkedAt never updates)
// while providers with a key (together, cerebras) refresh correctly.
//
// FIX: remove the credential gate. The provider.refreshModels() callback
// decides for itself whether it can operate without credentials.
// withRemoteCatalog's fetchModels works fine without one.
//
// Files patched (2):
//   1. pi-ai/dist/models.js — SDK path (readable source)
//   2. bundle chunk-MNAIPA3J.js — pi binary runtime path (minified)
//
// Idempotent: no-op when the PI_CATALOG_REFRESH_CREDENTIAL_GATE marker is
// present. Exits 0 on success/no-op, 1 on anchor mismatch (upstream refactor
// — patch needs updating).
// CLI: node catalog-refresh-credential-gate.mjs [--fix]   (default: report only)

import * as fs from "node:fs";
import { execSync } from "node:child_process";
import * as path from "node:path";

const MARKER = "PI_CATALOG_REFRESH_CREDENTIAL_GATE";

function piCoreDir() {
  if (process.env.PI_HARNESS_PATCH_TEST_CORE)
    return process.env.PI_HARNESS_PATCH_TEST_CORE;
  try {
    return path.join(
      execSync("npm root -g", { encoding: "utf-8" }).trim(),
      "@earendil-works",
      "pi-coding-agent",
    );
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Target 1: pi-ai/dist/models.js (SDK path, readable source)
// ---------------------------------------------------------------------------

function piAiModelsPath() {
  return path.join(
    piCoreDir() || "",
    "node_modules",
    "@earendil-works",
    "pi-ai",
    "dist",
    "models.js",
  );
}

const SDK_ANCHOR = [
  "                const credential = await this.resolveRefreshCredential(provider, storedCredential, signal);",
  "                if (!credential)",
  "                    return;",
  "                await this.runProviderRefreshPhase(provider, credential, true, options.force, generation, signal);",
].join("\n");

const SDK_REPLACEMENT = [
  "                const credential = await this.resolveRefreshCredential(provider, storedCredential, signal);",
  `                // ${MARKER}: removed if(!credential)return; gate — remote catalog`,
  "                // providers (withRemoteCatalog) fetch from pi.dev and do not need",
  "                // provider credentials. provider.refreshModels() decides whether it",
  "                // can operate without a credential.",
  "                await this.runProviderRefreshPhase(provider, credential, true, options.force, generation, signal);",
].join("\n");

// ---------------------------------------------------------------------------
// Target 2: bundle chunk (minified; runtime path for the `pi` binary)
// ---------------------------------------------------------------------------

function findBundleChunk() {
  const dir = path.join(piCoreDir() || "", "dist", "bundle", "chunks");
  try {
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".js"))) {
      const p = path.join(dir, f);
      let src;
      try {
        src = fs.readFileSync(p, "utf8");
      } catch {
        continue;
      }
      if (src.includes(BUNDLE_ANCHOR) || src.includes(BUNDLE_REPLACEMENT)) {
        return p;
      }
    }
  } catch {
    /* no chunks dir */
  }
  return null;
}

const BUNDLE_ANCHOR =
  ";let credential=await this.resolveRefreshCredential(provider,storedCredential,signal);credential&&await this.runProviderRefreshPhase(provider,credential,!0,options.force,generation,signal)";

const BUNDLE_REPLACEMENT =
  ";let credential=await this.resolveRefreshCredential(provider,storedCredential,signal);/*" +
  MARKER +
  "*/await this.runProviderRefreshPhase(provider,credential,!0,options.force,generation,signal)";

// ---------------------------------------------------------------------------
// Target table
// ---------------------------------------------------------------------------

function makeStaticTarget(name, file, anchor, replacement, fingerprint) {
  return {
    name,
    file,
    exists: () => fs.existsSync(file),
    isApplied: () => {
      try {
        const src = fs.readFileSync(file, "utf8");
        return fingerprint
          ? src.includes(fingerprint)
          : src.includes(replacement);
      } catch {
        return false;
      }
    },
    apply: () => {
      const src = fs.readFileSync(file, "utf8");
      if (src.includes(anchor)) {
        const patched = src.replace(anchor, replacement);
        if (patched === src || !patched.includes(MARKER)) {
          throw new Error(
            `patch application produced no change in ${file} — manual review needed`,
          );
        }
        fs.writeFileSync(file, patched);
        return;
      }
      throw new Error(
        `anchor mismatch in ${file} — upstream refactor, patch needs updating`,
      );
    },
  };
}

export function targets() {
  const sdkModels = piAiModelsPath();
  const chunk = findBundleChunk();
  if (!fs.existsSync(sdkModels) || !chunk) {
    throw new Error(
      "catalog refresh: required SDK/runtime target missing — upstream layout changed",
    );
  }
  const out = [];

  if (sdkModels && fs.existsSync(sdkModels)) {
    out.push(
      makeStaticTarget(
        "sdk: pi-ai models.js refresh credential gate",
        sdkModels,
        SDK_ANCHOR,
        SDK_REPLACEMENT,
      ),
    );
  }

  if (chunk) {
    out.push(
      makeStaticTarget(
        "bundle: models refresh credential gate",
        chunk,
        BUNDLE_ANCHOR,
        BUNDLE_REPLACEMENT,
        // fingerprint: the marker string since the full replacement may shift
        // if other patches re-anchor around this area
        `/*${MARKER}*/`,
      ),
    );
  }

  return out;
}

// ---------------------------------------------------------------------------
// CLI (only when run directly — verify-harness imports targets() and must not
// be killed by our process.exit)
// ---------------------------------------------------------------------------

if (
  process.argv[1] &&
  process.argv[1].endsWith("catalog-refresh-credential-gate.mjs")
) {
  const FIX = process.argv.includes("--fix");
  let failures = 0;
  for (const t of targets()) {
    if (t.isApplied()) {
      console.log(`  ✓ ${t.name}: patch present`);
    } else if (!t.exists()) {
      console.log(`  · ${t.name}: target file missing — skipped`);
    } else if (FIX) {
      try {
        t.apply();
        console.log(`  ✓ ${t.name}: patch applied`);
      } catch (e) {
        failures++;
        console.log(`  ✗ ${t.name}: apply failed — ${e.message}`);
      }
    } else {
      failures++;
      console.log(`  ✗ ${t.name}: patch MISSING — run with --fix`);
    }
  }
  console.log(
    failures === 0 ? `RESULT: PASS` : `RESULT: ${failures} issue(s) found`,
  );
  process.exit(failures === 0 ? 0 : 1);
}
