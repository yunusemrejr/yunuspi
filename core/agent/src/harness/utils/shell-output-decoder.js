/** Decode each shell pipe separately and merge complete text in arrival order. */
export function createShellOutputDecoder() {
    const decoders = new Map();
    return {
        append(data, source) {
            // Unlabelled custom operations retain their original single stream.
            const lane = source === "stdout" || source === "stderr" ? source : undefined;
            const previous = decoders.get(lane);
            if (typeof data === "string") {
                decoders.delete(lane);
                return (previous?.decode() ?? "") + data;
            }
            if (data.length === 0) return "";
            const decoder = previous ?? new TextDecoder();
            // At finish, pending suffixes follow the order of their last bytes.
            decoders.delete(lane);
            decoders.set(lane, decoder);
            return decoder.decode(data, { stream: true });
        },
        finish() {
            let text = "";
            for (const decoder of decoders.values()) text += decoder.decode();
            decoders.clear();
            return text;
        },
    };
}
