/** Remove the exact first frame emitted by the trusted mounted launcher. */
export function createMountedReadyParser(prefix: Buffer): (chunk: Buffer) => Buffer | "pending" | "invalid" {
	let matched = 0;
	return (chunk) => {
		const length = Math.min(chunk.length, prefix.length - matched);
		if (!chunk.subarray(0, length).equals(prefix.subarray(matched, matched + length))) return "invalid";
		matched += length;
		return matched === prefix.length ? chunk.subarray(length) : "pending";
	};
}
