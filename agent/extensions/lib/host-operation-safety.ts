/** Accident prevention for parsed host commands, not a sandbox or shell evaluator.
 * The filesystem guard owns shell parsing, substitutions and wrapper handling. */
import { readFileSync } from 'node:fs';

export type HostOperationRisk = { level: 'block' | 'review'; reason: string; target: string; resolved: boolean };

/** Read only process identity fields; never command lines or environment values. */
export function sessionAncestorPids(): number[] {
  const pids = new Set([1, process.pid, process.ppid]);
  let pid = process.ppid;
  for (let i = 0; i < 32 && pid > 1; i++) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (!Number.isSafeInteger(parent) || parent <= 0 || pids.has(parent)) break;
      pids.add(parent); pid = parent;
    } catch { break; }
  }
  return [...pids];
}

/** The session's own running background tasks, published by
 * pi-background-tasks, so a blocked kill names the one-call safe path. */
const OWNED_TASKS = Symbol.for('yunus-pi.bg-owned-tasks.v1');
function ownedTaskHint(): string {
  try {
    const tasks = (globalThis as any)[OWNED_TASKS]?.() as Array<{ id: string; name?: string; pid?: number; port?: number }> | undefined;
    if (!tasks?.length) return '';
    return `. Your own running background tasks stop cleanly with bg_kill: ${tasks.slice(0, 5).map(task =>
      `bg_kill ${JSON.stringify(task.name || task.id)} (${task.id}${task.pid ? `, pid ${task.pid}` : ''}${task.port ? `, port ${task.port}` : ''})`).join('; ')}`;
  } catch { return ''; }
}

export function hostOperationRisk(name: string, values: readonly (string | undefined)[],
  ancestors?: readonly number[]): HostOperationRisk | undefined {
  const args = values.map(value => value ?? ''), has = (...words: string[]) => args.some(arg => words.includes(arg));
  const options = args.slice(0, args.includes('--') ? args.indexOf('--') : args.length);
  const flag = (...words: string[]) => options.some(arg => words.includes(arg));
  const commandArgs = (valueFlags: string[]) => {
    let i = 0;
    while (args[i]?.startsWith('-')) {
      const option = args[i++];
      if (option === '--') break;
      if (valueFlags.includes(option)) i++;
    }
    return args.slice(i);
  };
  const prefix = (word: string | undefined, choices: string[]) => {
    const matches = word ? choices.filter(choice => choice.startsWith(word)) : [];
    return matches.length === 1 ? matches[0] : word;
  };
  const risk = (reason: string, level: 'block' | 'review' = 'block'): HostOperationRisk => ({level, reason, target: name, resolved: values.every(value => value !== undefined)});
  const unresolved = () => risk('A host-control operation is unresolved. Establish its exact operation and target from read-only evidence before running it', 'review');
  const network = () => risk('Host connectivity could be lost, including provider access and remote control. Inspect sys_probe host and the active route first; test in a disposable network namespace or use an operator-controlled recovery path outside this session');
  // Only an unambiguous leading diagnostic is a generic exemption: later
  // --help may be an option value (e.g. nft -f --help), not a help request.
  // The service script itself recognizes these flags in every argument slot.
  if (name !== 'kill' && ['--help','--version'].includes(args[0]) || name === 'service' && flag('--help','--version')) return;
  if (/^(?:reboot|poweroff|halt|shutdown|suspend|hibernate)$/.test(name)) {
    if (name === 'shutdown' && flag('-c', '--show')) return;
    return risk('Power or sleep operations interrupt the harness and other work. Keep this session running; use a separate operator workflow after saving work');
  }
  if (name === 'systemctl') {
    const [verb, ...units] = commandArgs(['-H','--host','-M','--machine','-t','--type','-p','--property','-s','--signal','--kill-whom','--kill-who','--job-mode','-n','--lines','-o','--output','--root']);
    if (['status','show','help','list-units','list-unit-files','is-active','is-enabled','is-failed','list-dependencies'].includes(verb)) return;
    if (['reboot', 'poweroff', 'halt', 'suspend', 'hibernate', 'hybrid-sleep', 'suspend-then-hibernate', 'soft-reboot', 'kexec', 'switch-root', 'isolate', 'rescue', 'emergency', 'exit'].includes(verb))
      return risk('This system or session lifecycle operation can terminate the harness or its control surface');
    if (verb === 'start' && units.some(arg => /^(?:reboot|poweroff|halt|suspend|hibernate|hybrid-sleep|suspend-then-hibernate|sleep|shutdown|kexec|exit|rescue|emergency)\.target$/.test(arg)))
      return risk('Starting this target interrupts the host session');
    if (['stop', 'restart', 'try-restart', 'reload-or-restart', 'reload-or-try-restart', 'kill', 'freeze', 'mask', 'disable'].includes(verb) &&
      units.some(arg => /[*?\[]|^(?:NetworkManager|networking|network|systemd-networkd|systemd-resolved|wpa_supplicant|iwd|connman|ssh|sshd|dbus|systemd-logind|display-manager|gdm3?|sddm|lightdm|user|session)(?:[.@-]|$)|^(?:pi|yunuspi)(?:\.service)?$/i.test(arg)))
      return network();
    if (values.includes(undefined)) return unresolved();
  }
  if (name === 'service' && has('stop', 'restart', 'try-restart', 'force-reload', '--full-restart') && /^(?:network|NetworkManager|wpa_supplicant|iwd|ssh|sshd|dbus|gdm|sddm|lightdm)/i.test(args[0])) return network();
  if (name === 'loginctl' && args.some(arg => /^(?:terminate|kill)-(?:session|user|seat)$/.test(arg)))
    return risk('Terminating a login session can kill the harness, desktop and remote access');
  if (name === 'nmcli') {
    const words = commandArgs(['-f','--fields','-g','--get-values','-m','--mode','-c','--colors','-e','--escape','-w','--wait']);
    const object = prefix(words[0], ['general','networking','radio','connection','device','agent','monitor','help']);
    const verbs = object === 'connection' ? ['show','up','down','add','modify','clone','edit','delete','monitor','reload','load','import','export','migrate']
      : object === 'device' ? ['status','show','set','up','connect','reapply','modify','down','disconnect','delete','monitor','wifi','lldp','checkpoint']
      : object === 'general' ? ['status','hostname','permissions','logging','reload'] : ['on','off','connectivity'];
    const verb = prefix(words[1], verbs);
    if (['show','status','monitor','permissions','connectivity','export','lldp'].includes(verb ?? '') || ['monitor','help','agent'].includes(object ?? '')) return;
    if (object === 'radio' && words.length >= 3 && prefix(words[2], ['on','off']) === 'off') return network();
    if (object === 'networking' && verb === 'off') return network();
    if (object === 'general' && verb === 'reload') return network();
    if (['connection','device'].includes(object ?? '') && ['up','down','add','modify','clone','edit','delete','reapply','reload','load','import','migrate','connect','disconnect','set','checkpoint'].includes(verb ?? '')) return network();
    if (object === 'device' && verb === 'wifi' && ['connect','hotspot'].includes(prefix(words[2], ['list','rescan','connect','hotspot','show-password']) ?? '')) return network();
    if (object === 'device' && verb === 'wifi' && ['list','rescan','show-password'].includes(prefix(words[2], ['list','rescan','connect','hotspot','show-password']) ?? '')) return;
    if (values.includes(undefined)) return unresolved();
  }
  if (name === 'rfkill' && has('block', 'toggle')) return network();
  if (name === 'ip') {
    if (options.some(arg => /^--?(?:b|ba|bat|batc|batch)(?:=|$)/.test(arg))) return network();
    const [object, verb, action] = commandArgs(['-n','-netns','--netns','-f','-family','--family','-rcvbuf','-l','-loops']);
    // These documented families put the operation after a sub-object. Keep
    // their verbs scoped so a selector/device called `set` stays ordinary data.
    const nested = [
      ['xfrm', ['state'], ['add','update','allocspi','delete','deleteall','flush']],
      ['xfrm', ['policy'], ['add','update','delete','deleteall','flush','set','setdefault']],
      ['mptcp', ['endpoint'], ['add','delete','change','flush']],
      ['mptcp', ['limits'], ['set']],
      ['sr', ['hmac','tunsrc'], ['set']],
      ['ioam', ['namespace'], ['add','delete','set']],
      ['ioam', ['schema'], ['add','delete']],
      ['nexthop', ['bucket'], []],
      ['link', ['property'], ['add','delete']],
    ] as const;
    const family = nested.find(([kind, children]) => object && kind.startsWith(object) && verb && children.some(child => child.startsWith(verb)));
    if (family) {
      if (action && family[2].some(operation => operation.startsWith(action))) return network();
      if (action && ['show','list','get','getdefault','count','help'].some(operation => operation.startsWith(action))) return;
      if (values.includes(undefined)) return unresolved();
      return;
    }
    const link = Boolean(object) && 'link'.startsWith(object);
    // ip accepts abbreviated verbs. In `ip link`, `s` means set; for
    // route/address it means show. Only command positions are operations.
    if (verb && (['show','list','get','help'].includes(verb) || !link && 'show'.startsWith(verb))) return;
    if (verb && ['add','change','replace','delete','flush','set','restore'].some(word => word.startsWith(verb))) return network();
    if (values.includes(undefined)) return unresolved();
  }
  if (name === 'ifdown' || name === 'netplan' && has('apply', 'try') || name === 'networkctl' && has('down', 'delete', 'reconfigure', 'reload', 'renew')) return network();
  if (name === 'ifconfig' && args.filter(arg => !['-a','-s','-v'].includes(arg)).length > 1) return network();
  if (name === 'iwconfig' && args.length > 1) return network();
  if (name === 'wpa_cli' && has('disconnect','terminate','disable_network','remove_network','select_network','set_network','reconfigure','reassociate','interface_remove')) return network();
  if (name === 'route' && has('add', 'del', 'delete') || name === 'iw' && has('disconnect', 'connect', 'set', 'del')) return network();
  if (/^(?:ip6?tables(?:-(?:legacy|nft))?(?:-restore)?|nft|ufw|firewall-cmd)$/.test(name)) {
    const nftDisplay = (arg: string) => /^-[nNscaeSupyjtT]+$|^--(?:handle|stateless|terse|service|reversedns|guid|numeric(?:-priority|-protocol|-time)?|echo|json)$/.test(arg);
    const readOnly = name === 'nft' ? flag('--check', '-c') || args.every(arg => !/[;\n]/.test(arg) && (!arg.startsWith('-') || nftDisplay(arg))) && ['list','monitor','get'].includes(args.filter(arg => !nftDisplay(arg))[0])
      : name === 'ufw' ? ['status', 'show'].includes(args[0]) || flag('--dry-run')
      : name === 'firewall-cmd' ? args.every(arg => /^--(?:get-|list-|query-|info-|path-|state$|check-config$|permanent$|quiet$|(?:zone|policy|service|ipset|icmptype)=)/.test(arg))
      : !name.endsWith('-restore') && flag('-L', '--list', '-S', '--list-rules', '-C', '--check') && !flag('-A', '-I', '-D', '-F', '-P', '-X', '-N', '-E', '-R', '-Z', '--append', '--insert', '--delete', '--flush', '--policy', '--new-chain', '--rename-chain', '--replace', '--zero');
    if (!readOnly) return network();
  }
  if (name === 'kill') {
    let signal = 'TERM', i = 0;
    if (['-l', '-L', '--list', '--table', '--help'].includes(args[0])) return;
    if (args[0] === '-s' || args[0] === '--signal') { signal = args[1]; i = 2; }
    else if (/^--signal=/.test(args[0] ?? '')) { signal = args[0].slice(9); i = 1; }
    else if (/^-(?:\d+|(?:SIG)?[A-Z]+)$/.test(args[0] ?? '')) { signal = args[0].slice(1); i = 1; }
    if (signal === '0' && !flag('--timeout')) return;
    const targets = args.slice(i).filter(arg => arg !== '--');
    const protectedPids = ancestors ?? sessionAncestorPids();
    if (targets.some(arg => !/^\d+$/.test(arg) || Number(arg) === 0 || protectedPids.includes(Number(arg))))
      return risk(`This signal may terminate the harness, an ancestor or a process group. Inspect sys_probe processes and target an exact unrelated PID; use process/bg tools to stop their own managed jobs${ownedTaskHint()}`);
  }
  if (name === 'pkill' || name === 'killall') {
    // pkill -s selects a session; only killall uses -s for a signal. A probe
    // cannot hide a later explicit terminating signal in the same invocation.
    const signals: string[] = [];
    for (let i=0; i<options.length; i++) {
      const arg=options[i];
      if (arg === '--signal' || name === 'killall' && arg === '-s') signals.push(options[++i] ?? '');
      else if (arg.startsWith('--signal=')) signals.push(arg.slice(9));
      else if (/^-(?:\d+|(?:SIG)?[A-Z][A-Z0-9+-]+)$/.test(arg)) signals.push(arg.slice(1));
    }
    if (signals.length && signals.every(signal => signal === '0') || name === 'killall' && flag('-l','--list')) return;
    return risk(`Name/pattern-wide process termination can kill this harness or unrelated applications. Inspect sys_probe processes and use an exact unrelated PID or the owning managed-job tool${ownedTaskHint()}`);
  }
  if (name === 'wipefs') {
    let noAct = false, erases = false;
    for (let i = 0; i < options.length; i++) {
      const option = options[i];
      if (option === '--no-act') noAct = true;
      if (option === '--all' || option === '--offset' || option.startsWith('--offset=')) erases = true;
      if (['--offset','--output','--types'].includes(option)) { i++; continue; }
      if (/^-[^-]/.test(option)) for (let at = 1; at < option.length; at++) {
        if (option[at] === 'n') noAct = true;
        if (option[at] === 'a' || option[at] === 'o') erases = true;
        // Offset/output/type consume the remaining cluster or next operand.
        if ('oOt'.includes(option[at])) { if (at === option.length - 1) i++; break; }
      }
    }
    if (erases && !noAct) return risk('Erasing device signatures can destroy mounted storage. Use a read-only listing or --no-act and a separate operator-controlled device workflow');
  }
  if (name === 'modprobe' && flag('-c','--showconfig','--show-config','--show-depends','--show-modversions','--dump-modversions')) return;
  if (['blkdiscard', 'mkswap', 'swapon', 'swapoff', 'modprobe', 'rmmod'].includes(name) && !flag('--show', '--list', '--dry-run', '-n'))
    return risk('Raw storage, swap or kernel-driver changes can damage the host or interrupt its active devices; inspect the device and use an isolated or operator-controlled workflow');
  if ((/^esptool(?:\.py)?$/.test(name) && has('write_flash', 'write-flash', 'erase_flash', 'erase-flash', 'erase_region', 'erase-region')) ||
    (name === 'arduino-cli' && has('upload', 'burn-bootloader')) ||
    (/^(?:pio|platformio)$/.test(name) && args.some(arg => /^(?:upload|uploadfs|erase)$/.test(arg))) ||
    (name === 'avrdude' && !flag('-n') && args.some(arg => /:w(?::|$)/.test(arg))))
    return risk('Firmware write/erase needs the exact board, port, voltage, image and recovery method verified; sys_probe devices is metadata only and cannot validate wiring', 'review');
  if (name === 'stress' || name === 'stress-ng')
    return risk('Host stress tests can exhaust CPU, memory or thermals and disrupt this session. Use sandbox_run with explicit resource/time bounds instead');
  if (values.includes(undefined) && /^(?:service|loginctl|ip|ifconfig|iwconfig|iw|wpa_cli|networkctl|netplan|rfkill)$/.test(name) && !has('status','show','list','get')) return unresolved();
}
