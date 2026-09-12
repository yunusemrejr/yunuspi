/** Defense in depth for private intelligence: credentials are not knowledge. */
export function safeText(value, max = 500) {
  let text = String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  text = text
    .replace(
      /\b(?:sk-|ghp_|github_pat_|glpat[-_])[A-Za-z0-9_-]{12,}/g,
      "[redacted]",
    )
    .replace(
      /(\b(?:password|passwd|secret|api[_ -]?key|access[_ -]?token|authorization)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|\S+)/gi,
      "$1[redacted]",
    )
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/https?:\/\/[^\s<>"']+/gi, (url) => {
      try {
        const u = new URL(url);
        u.username = "";
        u.password = "";
        u.search = "";
        u.hash = "";
        return u.href;
      } catch {
        return "[invalid URL]";
      }
    });
  return text.slice(0, max);
}
export function secretFile(file) {
  return /(?:^|\/)(?:\.env(?:\.(?!example$|sample$|template$)[^/]*)?|id_rsa|id_ed25519|credentials(?:\.[^/]*)?|auth\.json|settings\.json|models\.json)$|\.(?:pem|key|p12|pfx)$/i.test(
    file,
  );
}
