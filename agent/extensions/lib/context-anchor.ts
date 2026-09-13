import { createHash } from 'node:crypto';

// Retain only a digest, never a second copy of the conversation. An unchanged
// ephemeral message stays at its first boundary while tool continuations append.
// Changed evidence or rewritten history belongs at the current tail.
export function createContextAnchor() {
  let previous: { epoch: unknown; content: string; count: number; digest: string } | undefined;
  const digest = (messages: unknown[]) => createHash('sha256').update(JSON.stringify(messages)).digest('hex');
  return (messages: any[], injection: any, epoch: unknown) => {
    const content = JSON.stringify(injection);
    let count = messages.length;
    if (previous && previous.epoch === epoch && previous.content === content &&
        previous.count <= messages.length && digest(messages.slice(0, previous.count)) === previous.digest) {
      count = previous.count;
    }
    previous = { epoch, content, count, digest: digest(messages.slice(0, count)) };
    return [...messages.slice(0, count), injection, ...messages.slice(count)];
  };
}
