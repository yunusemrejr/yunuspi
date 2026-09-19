import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..'), path.resolve(root, '../..')].find(p => fs.existsSync(path.join(p, 'extensions/filesystem-safety.ts')));
assert.ok(agent);
const filename = path.join(agent, 'extensions/filesystem-safety.ts');
const source = fs.readFileSync(filename, 'utf8')
  .replace(/import \{\s*getAgentDir,[\s\S]*?from "@yunuspi\/coding-agent";/, `const getAgentDir=()=>${JSON.stringify(agent)};`)
  .replace(/from "(\.\/?[^"\n]+)"/g, (_, ref) => `from ${JSON.stringify(new URL(ref, pathToFileURL(filename)).href)}`);
const { default: register, assessShellMutation } = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
const {hostOperationRisk, sessionAncestorPids} = await import(pathToFileURL(path.join(agent, 'extensions/lib/host-operation-safety.ts')));
const assess = command => assessShellMutation(command, '/tmp/host-safety-fixture', {});

test('dangerous host commands are blocked before execution, including wrappers and substitutions', () => {
  for (const command of [
    'nmcli radio wifi off', 'sudo -u root nmcli networking off', 'doas nmcli dev disconnect wlan0',
    "bash -lc 'nmcli con down example'", 'env -S "rfkill block wifi"',
    'timeout 5 /usr/sbin/ip link set dev wlan0 down', 'ip route del default', 'ip addr flush dev wlan0',
    'printf "%s" "$(nmcli radio all off)"', 'ACTION=off; nmcli radio wifi "$ACTION"',
    'systemctl restart NetworkManager.service', 'systemctl stop sshd', 'systemctl isolate multi-user.target',
    'systemctl start poweroff.target', 'service networking restart', 'loginctl terminate-user example',
    'reboot', 'shutdown -h now', 'systemctl suspend', 'netplan apply', 'ifdown wlan0',
    'iptables -F', 'iptables -P INPUT DROP', 'nft flush ruleset', 'ufw reset',
    'kill -- -1', 'kill 0', `kill -9 ${process.pid}`, `kill ${process.ppid}`,
    'pkill node', "pkill -f '[p]i'", 'killall bash', 'wipefs --all /dev/sda',
    'blkdiscard /dev/nvme0n1', 'modprobe -r iwlwifi', 'stress-ng --vm 8',
    'nmcli con del example', 'nmcli dev dis wlan0', 'nmcli dev wifi hotspot',
    'nmcli -f GENERAL dev dis wlan0', 'nmcli networking of', 'nmcli radio wifi of',
    'systemctl kexec', 'systemctl switch-root /tmp/fixture-root', 'systemctl start sleep.target',
    'systemctl start suspend-then-hibernate.target', 'systemctl freeze user.slice',
    'wpa_cli -i wlan0 disconnect', 'iwconfig wlan0 txpower off',
    'iptables-nft -F', 'ip6tables-legacy -P INPUT DROP',
    "nft list ruleset ';' flush ruleset", 'nft list ruleset -f fixture.nft',
    'kill -- -1 --help', `kill ${process.pid} -l`, 'killall -- -0',
    'wipefs --all -- /dev/fixture --no-act',
    'shutdown -h now -- -c', 'pkill -s 0 node', 'pkill -0 --signal TERM node',
    'killall -0 -s TERM node', `kill --signal 0 --timeout 1000 KILL ${process.pid}`,
    'sudo --user root nmcli radio wifi off', 'timeout --signal TERM --kill-after 2 5 nmcli radio wifi off',
    'setsid nmcli radio wifi off', 'busybox reboot',
    'systemctl --signal KILL kill user.slice', 'systemctl --job-mode replace stop NetworkManager',
    'stdbuf -o L nmcli radio wifi off', 'nice --adjustment 5 nmcli radio wifi off',
    'find . -name fixture -exec nmcli dev disconnect wlan0 \\;',
    'find . -name fixture -exec bash -c "nmcli radio wifi off" \\;',
    'find . -name fixture -exec sudo --user root rfkill block wifi \\;',
    'printf node | xargs -n 1 pkill',
    'printf 12345 | xargs kill',
  ]) assert.equal(assess(command)?.level, 'block', command);
});

test('diagnostics, quoted data, ordinary app operations and managed process signals remain usable', () => {
  for (const command of [
    'nmcli device status', 'nmcli radio wifi', 'nmcli networking connectivity check', 'rfkill list',
    'ip route show', 'ip link show', 'systemctl status NetworkManager', 'systemctl restart example-web.service',
    'systemctl --user restart pi-smol-preprocessor.service', 'ss -tulpn',
    'iptables -L -n', 'nft list ruleset', 'ufw status', 'shutdown -c', 'reboot --help',
    'kill -0 12345', 'kill -l', 'pkill -0 node', 'wipefs -n --all /dev/sda', 'wipefs /dev/sda',
    "printf '%s' 'nmcli radio wifi off'", "grep 'reboot' README.md", '# shutdown now\nip route',
    'arduino-cli board list', 'arduino-cli compile sketch', 'npm test', 'node --test tests/small.test.mjs',
    'nmcli con show down', 'nmcli -f NAME con show', 'nmcli dev wifi list',
    'systemctl status reboot', 'systemctl show "$UNIT"', 'ifconfig -v wlan0',
    'nft -a -j list ruleset', 'iptables -C INPUT -j ACCEPT',
    'firewall-cmd --permanent --zone=public --list-all', 'modprobe --show-depends iwlwifi',
    'wpa_cli -i wlan0 status', 'iwconfig wlan0', 'nmcli dev show "$IFACE"',
    'nmcli dev wifi list ifname "$IFACE"', 'pkill --signal 0 node', 'killall -s 0 node', 'killall -l',
    'find . -name "*.tmp" -exec rm -- {} \\;',
    'find . -name "*.tmp" -exec nmcli dev show {} \\;',
    'setsid nmcli dev status', 'busybox true', 'sudo --user root nmcli dev status',
    'printf wlan0 | xargs nmcli device show',
  ]) assert.equal(assess(command), undefined, command);
  assert.equal(hostOperationRisk('kill', ['-TERM', '424242'], [1, 123, 456]), undefined);
  assert.equal(hostOperationRisk('kill', ['-0', '123'], [123]), undefined);
  assert.ok(sessionAncestorPids().includes(process.pid));
});

test('firmware mutations and elevated test entrypoints require exact-invocation review', () => {
  for (const command of ['esptool --port /dev/ttyUSB0 write_flash 0x0 image.bin',
    'arduino-cli upload --port /dev/ttyACM0 sketch', 'pio run -t upload',
    'avrdude -p m328p -U flash:w:image.hex:i', 'sudo pytest tests/device_test.py', 'sudo bash test-host.sh',
    'python3 -m esptool --port /dev/fixture write_flash 0x0 firmware.bin']) {
    assert.equal(assess(command)?.level, 'review', command);
  }
  for (const command of ['nmcli radio wifi "$MODE"', 'systemctl "$ACTION" NetworkManager', 'ip link "$ACTION" wlan0',
    'find . -name fixture -exec nmcli radio wifi {} \\;', 'printf off | xargs nmcli radio wifi'])
    assert.equal(assess(command)?.level, 'review', command);
  assert.equal(assess('avrdude -n -p m328p -U flash:w:image.hex:i'), undefined);
});

test('bash and background hooks enforce the same preflight without executing or offering a network bypass', async () => {
  const handlers = new Map();
  register({on(name, fn) { const list=handlers.get(name)??[]; list.push(fn); handlers.set(name,list); }});
  let confirmations = 0;
  const ctx = {cwd:'/tmp/host-safety-fixture',hasUI:true,ui:{notify(){},confirm(){confirmations++;return true;}}};
  for (const toolName of ['bash','bg_run']) {
    const results = [];
    for (const fn of handlers.get('tool_call')) results.push(await fn({toolName,input:{command:'nmcli radio wifi off'}},ctx));
    assert.ok(results.some(result=>result?.block));
  }
  assert.equal(confirmations,0,'host connectivity disruption is not made safe by an in-session click');
});
