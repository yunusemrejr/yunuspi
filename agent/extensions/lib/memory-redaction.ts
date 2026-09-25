/** Shared local-index and remote-embedding boundary. Never log the originals. */
const KEYS = /(?:sk-(?:ant-|proj-)?|ghp_|gho_|github_pat_|glpat-|xox[abprs]-|AKIA)[A-Za-z0-9_-]{12,}|-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?(?:-----END[^-]*PRIVATE KEY-----|$)|\b[A-Za-z0-9+/_-]{48,}={0,2}/g;
const SECRET_NAME = /(?:^|[_-])(?:api[_-]?key|password|passwd|secret|token|credential|authorization|auth)(?:$|[_-])/i;
export function redactSecrets(text: string, env: Record<string, string | undefined> = process.env, extra: string[] = []): string {
  let safe = text.replace(KEYS, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/\b(?:authorization|proxy-authorization)\s*[:=]\s*[^\r\n]+/gi, 'authorization: [redacted]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, '[redacted]')
    .replace(/(["']?(?:[\w-]*(?:api[_-]?key|password|passwd|secret|token|credentials?))["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&}\n]+)/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@');
  const secrets = [...Object.entries(env).filter(([name, value]) => SECRET_NAME.test(name) && typeof value === 'string' && value.length >= 4).map(([, value]) => value!), ...extra.filter(value => value.length >= 4)];
  for (const secret of new Set(secrets)) safe = safe.replaceAll(secret, '[redacted]');
  return safe;
}
export function sensitiveMemoryPath(value: string): boolean {
  return /(?:^|[/\\])(?:\.env(?:\.[^/\\]+)?|(?:auth|credentials?|secrets?)(?:\.[^/\\]+)?|id_(?:rsa|ed25519|ecdsa))$|\.(?:pem|key|p12|pfx)$/i.test(value);
}
