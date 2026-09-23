import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import { domainToASCII } from 'node:url';

function host(value) {
  // domainToASCII uses URL host parsing and can silently discard a /path.
  // Reject separators before normalization so a CIDR never becomes one IP.
  if (/[\s/\\@?#*%\[\]]/.test(value)) throw Error('Expected one hostname or IP, not a URL, range or CIDR');
  if (net.isIP(value)) return value;
  if (value.includes(':')) throw Error('Ports belong in the separate port argument');
  const name = domainToASCII(value);
  if (!name || name.length > 253 || !name.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part))) throw Error('Expected one hostname or IP, not a URL, range or CIDR');
  return name;
}
export async function netProbe(args) {
  const target = host(args.host), start = performance.now();
  if (args.action === 'dns') {
    const type = args.record_type ?? 'A';
    const records = await dns.resolve(target, type);
    return { host: target, record_type: type, records, latency_ms: Math.round((performance.now() - start) * 100) / 100, cacheable: false };
  }
  if (!args.port) throw Error('tcp/tls/ssh requires one explicit port');
  const address = net.isIP(target) ? { address: target, family: net.isIP(target) } : await dns.lookup(target);
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
    const deadline = setTimeout(() => done(failed('timeout')), 3500);
    const done = result => { if (settled) return; settled = true; clearTimeout(deadline); socket.destroy(); resolve({ ...base(), ...result }); };
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
