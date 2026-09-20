import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const agent = [path.join(root, "agent"), path.resolve(root, ".."), path.resolve(root, "../..")]
  .find((dir) => existsSync(path.join(dir, "extensions/sys-probe.ts")));
assert.ok(agent, "find live or exported agent sources");
const { default: register, deviceFacts, hostSafetyFacts, runSysProbe } = await import(pathToFileURL(path.join(agent, "extensions/sys-probe.ts")));
const { sessionDependencySignals, deviceKind, defaultRouteInterfaces } = await import(pathToFileURL(path.join(agent, "extensions/lib/sys-probe.ts")));
const { workspaceFacts } = await import(pathToFileURL(path.join(agent, "scripts/workspace-facts.mjs")));

async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yunuspi-environment-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test("session and route facts omit addresses and retain control-channel uncertainty", () => {
  const session = sessionDependencySignals({ SSH_CONNECTION: "PRIVATE-IP", DISPLAY: "PRIVATE-DISPLAY", TMUX: "PRIVATE-SOCKET", WSL_INTEROP: "PRIVATE-PATH", TOKEN: "PRIVATE-TOKEN" });
  assert.equal(session.ssh, true);
  assert.equal(session.graphical, true);
  assert.equal(session.multiplexedTerminal, true);
  assert.equal(session.wsl, true);
  assert.equal(sessionDependencySignals({}).connectivityRequired, "unknown");
  assert.doesNotMatch(JSON.stringify(session), /PRIVATE/);
  const v4 = [
    "Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT",
    "wlan0 00000000 01020304 0003 0 0 100 00000000 0 0 0",
    "eth0 00000000 00000000 0001 0 0 100 FF000000 0 0 0",
    "lo 00000000 00000000 0201 0 0 0 00000000 0 0 0",
  ].join("\n");
  assert.deepEqual(defaultRouteInterfaces(v4), ["wlan0"]);
  assert.deepEqual(defaultRouteInterfaces(`${"0".repeat(32)} 00 ${"0".repeat(32)} 00 ${"1".repeat(32)} 00000001 00000000 00000000 00000003 wlan0`, true), ["wlan0"]);
  assert.equal(defaultRouteInterfaces(null), null);
  assert.equal(defaultRouteInterfaces(Array.from({ length: 33 }, (_, i) => `net${i} 00000000 00000000 0003 0 0 100 00000000 0 0 0`).join("\n")), null, "an oversized default-route set remains unknown");
  for (const name of ["ttyUSB0", "ttyACM0", "ttyAMA0", "gpiochip0", "i2c-1", "spidev0.1", "dri/renderD128"]) assert.ok(deviceKind(name));
  for (const name of ["sda", "mem", "tty", "../ttyUSB0", "ttyUSB0.bak"]) assert.equal(deviceKind(name), null);
});

test("malformed or incomplete route metadata stays unknown; valid empty tables remain distinct", () => {
  const header = "Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT\n";
  const row = "wlan0 00000000 01020304 0003 0 0 100 00000000 0 0 0\n";
  assert.deepEqual(defaultRouteInterfaces(header), []);
  assert.deepEqual(defaultRouteInterfaces("", true), []);
  for (const malformed of ["", "permission denied", header + "partial", row.replace("0003", "1oops"), row + "corrupt row", "x".repeat(4097)])
    assert.equal(defaultRouteInterfaces(malformed), null, malformed.slice(0, 40));
  const v6 = `${"0".repeat(32)} 00 ${"0".repeat(32)} 00 ${"1".repeat(32)} 00000001 00000000 00000000 00000003 wlan0`;
  assert.equal(defaultRouteInterfaces(v6.replace('00000003 wlan0', '0000000z wlan0'), true), null);
  assert.equal(defaultRouteInterfaces(v6 + '\npartial', true), null);
});

test("host safety metadata distinguishes default Wi-Fi and battery state without credentials or identifiers", async (t) => {
  const dir = await temporary(t);
  const write = async (name, text) => {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), text);
  };
  await write("sys/class/net/wlan0/operstate", "up\n");
  await fs.mkdir(path.join(dir, "sys/class/net/wlan0/wireless"));
  await write("sys/class/net/lo/operstate", "unknown\n");
  await write("proc/net/route", "wlan0 00000000 11223344 0003 0 0 100 00000000 0 0 0\n");
  await write("sys/class/power_supply/BAT0/type", "Battery\n");
  await write("sys/class/power_supply/BAT0/capacity", "12\n");
  await write("sys/class/power_supply/BAT0/status", "Discharging\n");
  await write("sys/class/power_supply/BAT0/serial_number", "PRIVATE-SERIAL");
  await write("sys/class/power_supply/AC/type", "Mains\n");
  await write("sys/class/power_supply/AC/online", "0\n");
  const facts = await hostSafetyFacts(undefined, dir);
  assert.deepEqual(facts.network.interfaces.find((x) => x.name === "wlan0"), { name: "wlan0", state: "up", wireless: true, defaultV4: true, defaultV6: null });
  assert.equal(facts.power.supplies.find((x) => x.name === "BAT0").capacityPercent, 12);
  assert.equal(facts.power.supplies.find((x) => x.name === "BAT0").status, "Discharging");
  assert.equal(facts.power.supplies.find((x) => x.name === "AC").online, false);
  assert.doesNotMatch(JSON.stringify(facts), /PRIVATE|11223344/);
  await write("sys/class/power_supply/BAT0/capacity", "200");
  assert.equal((await hostSafetyFacts(undefined, dir)).power.supplies.find((x) => x.name === "BAT0").capacityPercent, null);
  await write("proc/net/route", "x".repeat(5000));
  assert.equal((await hostSafetyFacts(undefined, dir)).network.interfaces[0].defaultV4, null);
  await write("proc/net/route", "partial route metadata");
  assert.equal((await hostSafetyFacts(undefined, dir)).network.interfaces[0].defaultV4, null);
  await fs.unlink(path.join(dir, "sys/class/power_supply/BAT0/status"));
  await fs.symlink("serial_number", path.join(dir, "sys/class/power_supply/BAT0/status"));
  const linked = await hostSafetyFacts(undefined, dir);
  assert.equal(linked.power.supplies.find((x) => x.name === "BAT0").status, null);
  assert.doesNotMatch(JSON.stringify(linked), /PRIVATE-SERIAL/);
  for (let i = 0; i < 40; i++) await fs.mkdir(path.join(dir, `sys/class/net/test${i}`));
  const bounded = await hostSafetyFacts(undefined, dir);
  assert.ok(bounded.truncated);
  assert.ok(bounded.network.interfaces.length <= 32);
  const missing = await hostSafetyFacts(undefined, path.join(dir, "missing"));
  assert.equal(missing.network.available, false);
  assert.equal(missing.power.available, false);
  await assert.rejects(hostSafetyFacts(AbortSignal.abort(), dir));
});

test("read-only discovery never executes inherited PATH wrappers", async (t) => {
  const dir = await temporary(t);
  const previous = process.env.PATH;
  t.after(() => { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; });
  for (const name of ['ps', 'git'])
    await fs.writeFile(path.join(dir, name), '#!/bin/sh\n: > "${0%/*}/executed"\nprintf "PRIVATE-WRAPPER\\n"\n', {mode:0o700});
  process.env.PATH = dir;
  const processes = await runSysProbe('processes', 2);
  const workspace = await workspaceFacts(dir);
  assert.ok(processes.rows.length > 0 && processes.rows.length <= 2);
  assert.doesNotMatch(JSON.stringify([processes, workspace]), /PRIVATE-WRAPPER/);
  await assert.rejects(fs.stat(path.join(dir, 'executed')), {code:'ENOENT'});
});

test("registered probes cancel safely and inspect tools/devices without executing or opening them", async (t) => {
  const dir = await temporary(t);
  const previous = process.env.PATH;
  t.after(() => { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; });
  await fs.writeFile(path.join(dir, "arduino-cli"), '#!/bin/sh\n: > "${0%/*}/executed"\n', { mode: 0o700 });
  await fs.mkdir(path.join(dir, "esptool"));
  process.env.PATH = dir;
  const definitions = [];
  register({ registerTool: (tool) => definitions.push(tool) });
  assert.equal(definitions.length, 1);
  const tool = definitions[0];
  const host = await tool.execute("fixture", { action: "host" });
  assert.notEqual(host.isError, true);
  const result = JSON.parse(host.content[0].text);
  assert.deepEqual(result.rows[0].toolchains.available, ["arduino-cli"]);
  assert.ok(result.rows[0].cpuParallelism >= 1);
  assert.equal(result.rows[0].session.connectivityRequired, "unknown");
  await assert.rejects(fs.stat(path.join(dir, "executed")), { code: "ENOENT" });
  for (const action of ["host", "devices", "listeners", "services", "processes"])
    assert.equal((await tool.execute("fixture", { action }, AbortSignal.abort())).isError, true);
  assert.equal((await tool.execute("fixture", { action: "flash" })).isError, true);
  await fs.writeFile(path.join(dir, "ttyUSB0"), "PRIVATE-DEVICE-CONTENT");
  await fs.symlink("/dev/null", path.join(dir, "ttyUSB1"));
  const devices = await deviceFacts(1, undefined, dir);
  assert.deepEqual(devices.rows, []);
  assert.doesNotMatch(JSON.stringify(devices), /PRIVATE-DEVICE-CONTENT/);
  assert.match(devices.guidance.join(" "), /Opening a serial port can reset/);
});

test("workspace deployment and embedded hints preserve unknown authority and omit config contents", async (t) => {
  const dir = await temporary(t);
  for (const marker of ["compose.yml", "vercel.json", ".cpanel.yml", "platformio.ini", "sdkconfig.defaults", "sketch.yaml", "pico_sdk_import.cmake", "west.yml"])
    await fs.writeFile(path.join(dir, marker), "PRIVATE-CONFIG\n");
  await fs.mkdir(path.join(dir, "public_html"));
  const facts = await workspaceFacts(dir);
  assert.equal(facts.environmentEvidence.length, 8);
  assert.equal(facts.authority, "unresolved");
  assert.ok(facts.environmentEvidence.every((x) => x.verified === false));
  assert.match(facts.environmentGuidance.join(" "), /compile-only.*upload/);
  assert.match(facts.environmentGuidance.join(" "), /databases and user uploads/);
  assert.doesNotMatch(JSON.stringify(facts), /PRIVATE-CONFIG/);
  assert.ok(JSON.stringify(facts).length <= facts.limits.outputChars);
  await fs.unlink(path.join(dir, "platformio.ini"));
  await fs.symlink(path.join(dir, "vercel.json"), path.join(dir, "platformio.ini"));
  assert.ok(!(await workspaceFacts(dir)).environmentEvidence.some((x) => x.candidate === "PlatformIO"));
  const generic = path.join(dir, "generic");
  await fs.mkdir(generic);
  await fs.writeFile(path.join(generic, "CMakeLists.txt"), "generic build");
  assert.deepEqual((await workspaceFacts(generic)).environmentEvidence, []);
  const spoofed = path.join(dir, 'spoofed');
  await fs.mkdir(spoofed);
  for (const name of ['package.json', 'platformio.ini', 'vercel.json']) await fs.mkdir(path.join(spoofed, name));
  for (const name of ['public_html', 'src']) await fs.writeFile(path.join(spoofed, name), 'PRIVATE-NOT-A-DIRECTORY');
  const invalidKinds = await workspaceFacts(spoofed);
  assert.deepEqual(invalidKinds.manifests, []);
  assert.deepEqual(invalidKinds.directories, []);
  assert.deepEqual(invalidKinds.environmentEvidence, []);
});
