import { createHash } from 'node:crypto';

/**
 * Where an ephemeral block rides in the request.
 *
 * A block at the tail is re-sent fresh on every call but never breaks the cached prefix. A block that stays at
 * its first boundary is free while unchanged, yet when its content changes or it retires it vanishes from that
 * boundary and the provider re-bills everything appended since. Each such change costs about one call's growth
 * (~2k tokens) times the calls since placement, so a block smaller than that growth is cheaper at the tail on
 * every change schedule; only a large block is worth keeping in place. Measured with the cache probe: a UI
 * verification note and a UI reference note, both small, retired from mid-history and re-billed the transcript.
 */
export const STICKY_MIN_CHARS = 6_000;

// Retain only a digest, never a second copy of the conversation. An unchanged
// large ephemeral message stays at its first boundary while tool continuations append.
// Changed evidence, rewritten history and every small block belong at the current tail.
export function createContextAnchor(options: { stickyMinChars?: number } = {}) {
  const stickyMinChars = options.stickyMinChars ?? STICKY_MIN_CHARS;
  let previous: { epoch: unknown; content: string; count: number; digest: string } | undefined;
  const digest = (messages: unknown[]) => createHash('sha256').update(JSON.stringify(messages)).digest('hex');
  return (messages: any[], injection: any, epoch: unknown) => {
    const content = JSON.stringify(injection);
    if (content.length < stickyMinChars) {
      previous = undefined;
      return [...messages, injection];
    }
    let count = messages.length;
    if (previous && previous.epoch === epoch && previous.content === content &&
        previous.count <= messages.length && digest(messages.slice(0, previous.count)) === previous.digest) {
      count = previous.count;
    }
    previous = { epoch, content, count, digest: digest(messages.slice(0, count)) };
    return [...messages.slice(0, count), injection, ...messages.slice(count)];
  };
}
