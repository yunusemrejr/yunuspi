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
  if (!args.port) throw Error('tcp/tls requires one explicit port');
  const address = net.isIP(target) ? { address: target, family: net.isIP(target) } : await dns.lookup(target);
  // Connect exactly once, to the resolved address. No host/port enumeration or
  // protocol payloads. Unverified TLS is used only to inspect the certificate;
  // authorizationError remains visible and is never reported as valid.
  return await new Promise(resolve => {
    const servername = args.servername ? host(args.servername) : net.isIP(target) ? undefined : target;
    const options = { host: address.address, family: address.family, port: args.port };
    const socket = args.action === 'tls' ? tls.connect({ ...options, servername, rejectUnauthorized: false }) : net.connect(options);
    const base = () => ({ host: target, address: address.address, port: args.port, latency_ms: Math.round((performance.now() - start) * 100) / 100, cacheable: false });
    const done = result => { socket.destroy(); resolve({ ...base(), ...result }); };
    socket.setTimeout(3500, () => done({ connected: false, error: 'timeout' }));
    socket.once('error', error => done({ connected: false, error: error.code ?? 'connection_failed' }));
    socket.once(args.action === 'tls' ? 'secureConnect' : 'connect', () => {
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
