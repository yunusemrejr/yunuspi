/** Safe metadata for helpers that fail before native result rows exist.
 * No prompt, path, provider response body or arbitrary error text is retained. */
export type HelperLaunchFailure = {
  error: true;
  stage: "launch";
  runtimeError?: "ReferenceError" | "TypeError" | "SyntaxError";
  diagnosticCode?: string;
  processCode?: "EACCES" | "EPERM" | "ENOENT";
  diagnosticRef: string;
};

export function helperLaunchFailure(error: unknown, diagnosticRef: string): HelperLaunchFailure {
  const runtimeError = error instanceof ReferenceError ? "ReferenceError"
    : error instanceof TypeError ? "TypeError" : error instanceof SyntaxError ? "SyntaxError" : undefined;
  const native = error as {code?: unknown; syscall?: unknown} | undefined;
  const processCode = native && typeof native.syscall === 'string' && /^spawn(?:Sync)?(?: |$)/.test(native.syscall)
    && ['EACCES','EPERM','ENOENT'].includes(String(native.code)) ? native.code as 'EACCES'|'EPERM'|'ENOENT' : undefined;
  const missing = error instanceof ReferenceError ? /^([A-Za-z_$][\w$]{0,79}) is not defined$/.exec(error.message)?.[1] : undefined;
  return { error: true, stage: "launch", diagnosticRef: missing ? `${diagnosticRef}:ReferenceError:${missing}` : diagnosticRef,
    ...(processCode ? {processCode, diagnosticCode:processCode} : {}),
    ...(runtimeError ? { runtimeError, diagnosticCode: missing ? `${runtimeError}:${missing}` : runtimeError } : {}),
  };
}

export function helperFailureGap(error: unknown, diagnosticRef: string): string {
  const row = helperLaunchFailure(error, diagnosticRef);
  return row.runtimeError
    ? `Native helper launch failed with ${row.diagnosticCode}. This is a harness error; changing provider cannot repair it. Diagnostic: ${diagnosticRef}.`
    : `Native helper launch failed before a result was returned. Diagnostic: ${diagnosticRef}; provider usage is unknown.`;
}
