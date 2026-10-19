// node:test reporter for CI: one GitHub annotation per failed test, so a red shard names its tests
// in the unauthenticated check-run annotations instead of only "Process completed with exit code 1".
import path from 'node:path';

const escape = text => String(text ?? '').replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/:/g, '%3A').replace(/,/g, '%2C');

export function annotation(data, cwd = process.cwd()) {
  const error = data.details?.error;
  const lines = String(error?.cause?.message ?? error?.message ?? error ?? 'failed').split('\n').filter(Boolean);
  // A crashed child prints Node's source location ("node:internal/fs/cp/cp-sync:138") before the error itself;
  // a red shard is only diagnosable from the unauthenticated annotations if the error line is the one shown.
  const message = (/^node:|^file:\/\/|^\s+at /.test(lines[0] ?? '') ? lines.find(line => /^(?:\w*Error|\w+Exception)\b/.test(line)) : undefined) ?? lines[0] ?? 'failed';
  const file = data.file ? path.relative(cwd, data.file.replace(/^file:\/\//, '')) : '';
  // GitHub's workflow-command syntax is `::error prop=a,prop=b::message`: the properties follow a space, not a comma.
  return `::error ${[file ? `file=${escape(file)}` : '', `title=${escape(data.name)}`].filter(Boolean).join(',')}::${escape(message.slice(0, 300))}\n`;
}

export default async function* ciFailureReporter(source) {
  for await (const event of source) {
    if (event.type === 'test:fail' && event.data.details?.type !== 'suite') yield annotation(event.data);
  }
}
