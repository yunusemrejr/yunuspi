/** Exact owned pre-transport diagnostics, not a generic provider-error parser.
 * Whole-message anchoring deliberately rejects remote JSON/HTTP wrappers or a
 * quoted local diagnostic inside a provider response. Ambiguous text stays a
 * provider failure; only these known local catalog errors are reconciled. */
export function isLocalModelResolutionFailure(error: unknown): boolean {
	if (typeof error !== "string" || error.length > 8192) return false;
	const text = error.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim();
	return /^(?:Error: )?Model "[^"\r\n]{1,512}" not found\. Use --list-models to see available models\.$/.test(text)
		|| /^(?:Error: )?Unknown provider "[^"\r\n]{1,512}"\. Use --list-models to see available providers(?:\/models)?\.$/.test(text)
		|| /^(?:Error: )?route [^\s\x00-\x1f\x7f]{1,512} not in registry at launch$/.test(text);
}
