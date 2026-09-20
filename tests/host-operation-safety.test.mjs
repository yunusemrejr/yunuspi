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
    'env --split-string="nmcli radio wifi off"', "env -S'nmcli radio wifi off'",
    'env --argv0 fixture nmcli radio wifi off', 'env -- "MODE=off" sh -c \'nmcli radio wifi "$MODE"\'',
    'exec -a fixture nmcli radio wifi off', 'sudo "-u" root nmcli radio wifi off',
    'printf fixture | xargs sudo nmcli radio wifi off',
    'printf fixture | xargs env -S "nmcli radio wifi off"',
    'printf fixture | xargs -E STOP nmcli radio wifi off',
    'ip link s dev wlan0 down', 'ip route d default', 'ip -n fixture link s wlan0 down',
    'ip link property a dev wlan0 altname fixture', 'ip -batch fixture.commands', 'ip -b fixture.commands',
    'wipefs -o0 /dev/fixture', 'service networking --full-restart', 'service networking try-restart',
    'systemctl --property --help stop NetworkManager', 'systemctl -p --version stop NetworkManager',
    'nft -f --help', 'nft --file --version', 'ip -batch --help',
    'nmcli --wait --help radio wifi off',
    'sudo -ublack nmcli radio wifi off', 'sudo -gblack nmcli radio wifi off',
    'sudo -uhello nmcli networking off', 'sudo -phello nmcli networking off',
    'wipefs -tminix -a /dev/fixture', 'wipefs -t minix -a /dev/fixture',
    'wipefs --types minix --all /dev/fixture', 'wipefs --output --no-act --all /dev/fixture',
    'command -v "$(nmcli radio wifi off)"',
    'env LABEL="$UNRESOLVED" nmcli networking off', 'env -- LABEL="$UNRESOLVED" nmcli networking off',
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
    'command -v reboot', 'command -pV reboot', 'sudo -l reboot', 'sudo -nl reboot', 'sudo --list nmcli radio wifi off',
    'ip link show dev set', 'ip route show table flush', 'ip route s', 'ip addr s',
    'wipefs -an /dev/fixture', 'wipefs -na /dev/fixture',
    'env --split-string="nmcli device status"', 'env --argv0 fixture nmcli device status',
    'exec -a fixture nmcli device status', 'sudo "-u" root nmcli device status',
    'printf fixture | xargs sudo nmcli device show', 'printf fixture | xargs env nmcli device show',
    'env -- MODE=status sh -c \'nmcli device "$MODE"\'', 'nft --help', 'systemctl -q --help',
    'service networking stop --help',
    'env LABEL="$UNRESOLVED" nmcli device status', 'env -- LABEL="$UNRESOLVED" nmcli device status',
  ]) assert.equal(assess(command), undefined, command);
  assert.equal(hostOperationRisk('kill', ['-TERM', '424242'], [1, 123, 456]), undefined);
  assert.equal(hostOperationRisk('kill', ['-0', '123'], [123]), undefined);
  assert.ok(sessionAncestorPids().includes(process.pid));
});

test('wrapper parsing retains ordinary filesystem scope and option terminators', () => {
  for (const command of [
    'env --split-string="rm /etc/host-safety-fixture"',
    'env -- FILE=/etc/host-safety-fixture sh -c \'rm "$FILE"\'',
    'exec -a fixture rm /etc/host-safety-fixture',
    'timeout --signal TERM 5 nice -n 5 rm /etc/host-safety-fixture',
    'command -- rm /etc/host-safety-fixture',
    'sudo -- rm /etc/host-safety-fixture',
  ]) assert.equal(assess(command)?.level, 'block', command);
  for (const command of [
    'env -- FILE=/tmp/host-safety-fixture/output.txt sh -c \'rm "$FILE"\'',
    'env --split-string="rm /tmp/host-safety-fixture/output.txt"',
    'exec -a fixture rm /tmp/host-safety-fixture/output.txt',
    'timeout 5 nice --adjustment 5 rm /tmp/host-safety-fixture/output.txt',
    'command -- rm /tmp/host-safety-fixture/output.txt',
  ]) assert.equal(assess(command), undefined, command);
  assert.equal(assess('env -- "MODE=$UNKNOWN" sh -c \'nmcli radio wifi "$MODE"\'')?.level, 'review');
  assert.equal(assessShellMutation('env -u "TARGET" sh -c \'rm -rf "${TARGET:-/}"\'', '/tmp/host-safety-fixture', { TARGET: '/tmp/host-safety-fixture/output' })?.level, 'block', 'quoted env unset keys must not preserve stale safe values');
});

test('nested ip object families classify their operation and preserve read-only selectors', () => {
  for (const command of [
    'ip xfrm state flush', 'ip xfrm policy flush', 'ip x s f', 'ip x p d dir out',
    'ip xfrm policy setdefault in block', 'ip xfrm state deleteall',
    'ip mptcp endpoint flush', 'ip mpt e f', 'ip mptcp limits set subflows 1', 'ip mpt l s subflows 1',
    'ip sr tunsrc set 2001:db8::1', 'ip s t s 2001:db8::1', 'ip sr hmac set 1 sha256',
    'ip ioam namespace set 1 schema none', 'ip io n s 1 schema none', 'ip ioam schema del 1',
    'ip --netns fixture -6 xfrm state flush', 'ip -n fixture -f inet6 sr tunsrc set 2001:db8::1',
  ]) assert.equal(assess(command)?.level, 'block', command);
  for (const command of [
    'ip xfrm state list', 'ip xfrm state count', 'ip x s c', 'ip xfrm policy getdefault',
    'ip x p l dev set', 'ip xfrm policy count', 'ip mptcp endpoint show', 'ip mpt e sh',
    'ip mptcp limits show', 'ip mpt l sh', 'ip sr hmac show', 'ip sr tunsrc show', 'ip s t sh',
    'ip ioam namespace show', 'ip io schema show', 'ip nexthop bucket list dev set',
    'ip nexthop bucket get id 1 index 0', 'ip next b l dev flush',
    'ip --netns fixture -6 xfrm state count', 'ip -n fixture -f inet6 sr tunsrc show',
  ]) assert.equal(assess(command), undefined, command);
  assert.equal(assess('ip xfrm state "$ACTION"')?.level, 'review');
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
