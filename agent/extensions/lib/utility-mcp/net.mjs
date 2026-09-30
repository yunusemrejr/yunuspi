import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import { domainToASCII } from 'node:url';

function host(value) {
  // domainToASCII uses URL host parsing and can silently discard a /path.
  // Reject separators before normalization so a CIDR never becomes one IP.
  if (typeof value !== 'string' || !value || /[\s/\\@?#*%\[\]]/.test(value)) throw Error('Expected one hostname or IP, not a URL, range or CIDR');
  if (net.isIP(value)) return value;
  if (value.includes(':')) throw Error('Ports belong in the separate port argument');
  const name = domainToASCII(value);
  if (!name || name.length > 253 || !name.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part))) throw Error('Expected one hostname or IP, not a URL, range or CIDR');
  return name;
}
export async function netProbe(args, signal) {
  signal?.throwIfAborted();
  if (args.action === 'diagnose') return netDiagnose(args, signal);
  if (!['dns', 'tcp', 'tls', 'ssh'].includes(args.action)) throw Error('Unsupported network action');
  if (args.protocol !== undefined || args.path !== undefined) throw Error('protocol/path apply only to diagnose');
  const target = host(args.host), start = performance.now();
  if (args.action === 'dns') {
    const type = args.record_type ?? 'A';
    const records = await timed(dns.resolve(target, type), args.timeout_ms ?? 3500, signal);
    return { host: target, record_type: type, records, latency_ms: Math.round((performance.now() - start) * 100) / 100, cacheable: false };
  }
  if (!args.port) throw Error('tcp/tls/ssh requires one explicit port');
  const address = net.isIP(target) ? { address: target, family: net.isIP(target) } : await timed(dns.lookup(target), args.timeout_ms ?? 3500, signal);
  assertAddress(address.address);
  // Connect exactly once, to the resolved address. No host/port enumeration or
  // protocol payloads. Unverified TLS is used only to inspect the certificate;
  // authorizationError remains visible and is never reported as valid.
  return await new Promise(resolve => {
    const servername = args.servername ? host(args.servername) : net.isIP(target) ? undefined : target;
    const options = { host: address.address, family: address.family, port: args.port };
    const socket = args.action === 'tls' ? tls.connect({ ...options, servername, rejectUnauthorized: false }) : net.connect(options);
    const base = () => ({ host: target, address: address.address, port: args.port, latency_ms: Math.round((performance.now() - start) * 100) / 100, cacheable: false });
    let settled = false, connected = false;
    socket.once('connect', () => { connected = true; });
    const failed = error => ({ connected: args.action === 'ssh' ? connected : false, error, ...(args.action === 'ssh' ? { ssh_identified: false, host_key_verified: false, authenticated: false } : {}) });
    const deadline = setTimeout(() => done(failed('timeout')), args.timeout_ms ?? 3500);
    const cancelled = () => done(failed('cancelled'));
    const done = result => { if (settled) return; settled = true; clearTimeout(deadline); signal?.removeEventListener('abort', cancelled); socket.destroy(); resolve({ ...base(), ...result }); };
    signal?.addEventListener('abort', cancelled, { once: true });
    if (signal?.aborted) return cancelled();
    if (args.action === 'ssh') {
      let bytes = Buffer.alloc(0);
      socket.on('data', chunk => {
        if (bytes.length + chunk.length > 4096) return done({ connected, ssh_identified: false, error: 'banner_limit', host_key_verified: false, authenticated: false });
        bytes = Buffer.concat([bytes, chunk]);
        for (const line of bytes.toString('latin1').split('\n').slice(0, -1)) {
          if (!line.startsWith('SSH-')) continue;
          const banner = line.replace(/\r$/, '');
          if (!/^SSH-(?:2\.0|1\.99)-[\x21-\x7e]+(?: [\x20-\x7e]*)?$/.test(banner) || banner.length > 253) return done({ connected, ssh_identified: false, error: 'invalid_ssh_banner', host_key_verified: false, authenticated: false });
          return done({ connected, ssh_identified: true, banner, host_key_verified: false, authenticated: false });
        }
      });
      socket.once('end', () => done({ connected, ssh_identified: false, error: 'closed_before_banner', host_key_verified: false, authenticated: false }));
    }
    socket.setTimeout(3500, () => done(failed('timeout')));
    socket.once('error', error => done(failed(error.code ?? 'connection_failed')));
    socket.once(args.action === 'tls' ? 'secureConnect' : 'connect', () => {
      if (args.action === 'ssh') return;
      if (args.action !== 'tls') return done({ connected: true });
      const chain = [], seen = new Set();
      let cert = socket.getPeerCertificate(true);
      const identityError = cert?.raw ? tls.checkServerIdentity(servername ?? target, cert) : null;
      while (cert?.raw && chain.length < 10 && !seen.has(cert.fingerprint256)) {
        seen.add(cert.fingerprint256);
        chain.push({ subject: cert.subject, san: cert.subjectaltname ?? null, issuer: cert.issuer, valid_from: cert.valid_from, expires: cert.valid_to, fingerprint_sha256: cert.fingerprint256 });
        cert = cert.issuerCertificate;
      }
      done({ connected: true, authorized: socket.authorized && !identityError, protocol: socket.getProtocol(), chain,
        chain_errors: [...new Set([socket.authorizationError, identityError?.code].filter(Boolean).map(String))] });
    });
  });
}

// These addresses have no legitimate one-endpoint application readiness use.
// Check the resolved address too: a public-looking name must not bypass this.
function assertAddress(value) {
  const family = net.isIP(value);
  if (!family) throw Error('Invalid resolved address');
  if (family === 4) {
    const [a, b] = value.split('.').map(Number);
    if (a === 0 || a >= 224 || a === 169 && b === 254) throw Error('Network target blocked: unspecified, link-local/metadata or multicast address');
  } else {
    const normalized = new URL(`http://[${value}]/`).hostname.slice(1, -1);
    if (normalized.startsWith('::ffff:')) {
      const parts = normalized.slice(7).split(':');
      const bytes = parts.flatMap(p => [parseInt(p, 16) >> 8, parseInt(p, 16) & 255]);
      if (bytes.length !== 4) throw Error('Invalid mapped address');
      return assertAddress(bytes.join('.'));
    }
    if (normalized === '::' || /^(?:fe[89ab]|ff)/i.test(normalized)) throw Error('Network target blocked: unspecified, link-local/metadata or multicast address');
  }
}

function timed(pending, milliseconds, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (method, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); method(value); };
    const failure = code => Object.assign(Error(code), { code });
    const abort = () => done(reject, failure('cancelled'));
    const timer = setTimeout(() => done(reject, failure('timeout')), Math.max(1, milliseconds));
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve(pending).then(value => done(resolve, value), error => done(reject, error));
    if (signal?.aborted) abort();
  });
}
const elapsed = start => Math.round((performance.now() - start) * 100) / 100;
const errorCode = error => /^[A-Z_0-9]{1,80}$/.test(error?.code) ? error.code : ['timeout', 'cancelled'].includes(error?.code) ? error.code : 'probe_failed';

/** A single socket supplies all requested layers, preserving earlier evidence. */
export async function netDiagnose(args, signal) {
  signal?.throwIfAborted();
  const target = host(args.host), protocol = args.protocol ?? 'tcp';
  if (!['tcp', 'tls', 'http', 'https'].includes(protocol)) throw Error('Unsupported diagnosis protocol');
  if (!Number.isSafeInteger(args.port) || args.port < 1 || args.port > 65535) throw Error('diagnose requires one explicit port');
  if (args.record_type !== undefined) throw Error('record_type applies only to dns');
  const useTls = ['tls', 'https'].includes(protocol), useHttp = ['http', 'https'].includes(protocol);
  if (args.servername !== undefined && !useTls) throw Error('servername requires TLS');
  const servername = args.servername ? host(args.servername) : net.isIP(target) ? undefined : target;
  if (useHttp ? typeof args.path !== 'string' || !/^\/[A-Za-z0-9/_~.!$&'()*+,;=:@-]*$/.test(args.path) || args.path.startsWith('//') || args.path.length > 512 : args.path !== undefined) throw Error('http/https require one explicit public pathname, no query, fragment or encoded characters');
  const timeout = args.timeout_ms ?? 4500;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 4500) throw Error('timeout_ms must be 100–4500');
  const started = performance.now(), expires = started + timeout;
  const phases = [], names = ['dns', 'tcp', ...(useTls ? ['tls'] : []), ...(useHttp ? ['http'] : [])];
  let address, attempts = 0;
  const phase = (name, status, facts = {}) => phases.push({ phase: name, status, ...facts });
  const finish = () => {
    for (const name of names) if (!phases.some(p => p.phase === name)) phase(name, 'skipped', { reason: 'previous_phase_failed' });
    const failed = phases.find(p => ['failed', 'blocked', 'cancelled'].includes(p.status));
    const http = phases.find(p => p.phase === 'http');
    const reason = failed ? `${failed.phase}:${failed.error ?? failed.reason}` : http && !http.ready ? `http:${http.classification}` : 'requested_layers_ready';
    const next = failed?.phase === 'dns' ? 'Check this hostname in the current resolver/NSS scope; no address was connected.' : failed?.phase === 'tcp' ? 'Check the exact listener and route/firewall evidence; this result cannot identify which policy dropped traffic.' : failed?.phase === 'tls' ? 'Check the server certificate chain, hostname, expiry and clock; do not bypass trust to send application data.' : http && !http.ready ? 'Inspect the exact application route and service state; HEAD support and authorization may differ from user requests.' : 'No repair indicated by the requested layers; application functionality and other addresses remain untested.';
    return { action: 'diagnose', host: target, ...(address ? { address: address.address } : {}), port: args.port, protocol, ready: !failed && (!http || http.ready), reason, phases, next_checks: [next], connection_attempts: attempts, latency_ms: elapsed(started), cacheable: false, executed_changes: false, scope: 'One explicit endpoint, one selected address, one connection; no retries, scanning, credentials, redirects or response bodies. No application functionality claim.' };
  };
  const dnsStart = performance.now();
  try {
    address = net.isIP(target) ? { address: target, family: net.isIP(target) } : await timed(dns.lookup(target), expires - performance.now(), signal);
    assertAddress(address.address);
    phase('dns', net.isIP(target) ? 'not_needed' : 'ok', { source: net.isIP(target) ? 'literal_ip' : 'system_lookup', family: address.family, latency_ms: elapsed(dnsStart) });
  } catch (error) {
    phase('dns', signal?.aborted ? 'cancelled' : /target blocked/.test(error?.message) ? 'blocked' : 'failed', { error: /target blocked/.test(error?.message) ? 'unsafe_address' : errorCode(error), latency_ms: elapsed(dnsStart) });
    return finish();
  }
  if (signal?.aborted || performance.now() >= expires) { phase('tcp', signal?.aborted ? 'cancelled' : 'failed', { error: signal?.aborted ? 'cancelled' : 'timeout' }); return finish(); }
  return new Promise(resolve => {
    let socket, settled = false, phaseStart = performance.now(), active = 'tcp', response = Buffer.alloc(0);
    const done = () => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); socket?.destroy(); resolve(finish()); };
    const fail = code => { if (settled) return; if (!phases.some(p => p.phase === active)) phase(active, code === 'cancelled' ? 'cancelled' : 'failed', { error: code, latency_ms: elapsed(phaseStart) }); done(); };
    const abort = () => fail('cancelled');
    const timer = setTimeout(() => fail('timeout'), Math.max(1, expires - performance.now()));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) return abort();
    const httpRequest = () => {
      active = 'http'; phaseStart = performance.now();
      const name = servername ?? target;
      const hostHeader = (net.isIP(name) === 6 ? `[${name}]` : name) + ':' + args.port;
      // No configurable method, headers, payload, proxy, cookies or redirects.
      socket.write(`HEAD ${args.path} HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`);
      socket.on('data', chunk => {
        if (settled) return;
        // Keep only headers even if a server sends a body in the same chunk.
        response = Buffer.concat([response, chunk.subarray(0, Math.max(0, 16385 - response.length))]);
        const complete = response.indexOf('\r\n\r\n');
        if (complete < 0) return response.length > 16384 ? fail('header_limit') : undefined;
        if (complete + 4 > 16384) return fail('header_limit');
        response = response.subarray(0, complete + 4);
        const line = response.subarray(0, response.indexOf('\r\n')).toString('latin1');
        const match = /^HTTP\/1\.[01] ([1-5]\d\d)(?: [\x20-\x7e]*)?$/.exec(line);
        if (!match) return fail('invalid_http_response');
        const status = Number(match[1]);
        if (status < 200) return fail('unsupported_informational_response');
        const classification = status < 300 ? 'ready' : status < 400 ? 'redirect_not_followed' : [401,403].includes(status) ? 'authorization_required' : status === 404 ? 'route_not_found' : status === 405 ? 'head_not_supported' : status === 429 ? 'rate_limited' : status >= 500 ? 'application_unavailable' : 'application_rejected';
        phase('http', 'ok', { status_code: status, ready: status < 300, classification, latency_ms: elapsed(phaseStart) }); done();
      });
    };
    try {
      attempts++;
      const options = { host: address.address, family: address.family, port: args.port };
      socket = useTls ? tls.connect({ ...options, servername, rejectUnauthorized: false, ca: tls.rootCertificates, ALPNProtocols: useHttp ? ['http/1.1'] : undefined }) : net.connect(options);
      socket.once('connect', () => {
        if (settled) return;
        phase('tcp', 'ok', { latency_ms: elapsed(phaseStart) });
        if (useTls) { active = 'tls'; phaseStart = performance.now(); }
        else if (useHttp) httpRequest();
        else done();
      });
      if (useTls) socket.once('secureConnect', () => {
        if (settled) return;
        const certificate = socket.getPeerCertificate();
        const identity = certificate?.raw ? tls.checkServerIdentity(servername ?? target, certificate) : { code: 'NO_PEER_CERTIFICATE' };
        const errors = [...new Set([socket.authorizationError, identity?.code].filter(Boolean).map(String))];
        const authorized = socket.authorized && !identity;
        phase('tls', authorized ? 'ok' : 'failed', { authorized, protocol: socket.getProtocol(), ...(authorized ? {} : { error: 'certificate_validation_failed', validation_errors: errors }), expires: certificate.valid_to ?? null, latency_ms: elapsed(phaseStart) });
        if (authorized && useHttp) httpRequest(); else done();
      });
      socket.once('error', error => fail(errorCode(error)));
      socket.once('end', () => fail('closed_before_phase_complete'));
      socket.once('close', () => { if (!settled) fail('closed_before_phase_complete'); });
    } catch (error) { fail(errorCode(error)); }
  });
}


export function sshPlan(args) {
  const target = host(args.host);
  if (!/^[a-z_][a-z0-9_.-]{0,63}$/i.test(args.user)) throw Error('Expected a simple explicit SSH username');
  // -F /dev/null suppresses both user and system config, including Match exec
  // and ProxyCommand. This function only constructs argv; it never spawns SSH.
  const argv = ['-F', '/dev/null', '-p', String(args.port),
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no',
    '-o', 'IdentitiesOnly=yes', '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'PermitLocalCommand=no',
    '-o', 'ProxyCommand=none', '-o', 'ProxyJump=none', '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
    '-o', 'ConnectTimeout=5', '-o', 'ConnectionAttempts=1', '-o', 'RequestTTY=no', '--', `${args.user}@${target}`];
  return { executable: 'ssh', argv, target: { host: target, user: args.user, port: args.port }, executed: false,
    config_read: false, credentials_read: false, network_connected: false,
    requires: ['Existing trusted known_hosts entry', 'User-authorized execution through the normal shell policy'],
    limitations: ['Configuration aliases, jump hosts and custom identities are deliberately not resolved', 'A plan does not verify identity, connectivity or authentication'] };
}
