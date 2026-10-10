// node:test reporter for CI: one GitHub annotation per failed test, so a red shard names its tests
// in the unauthenticated check-run annotations instead of only "Process completed with exit code 1".
import path from 'node:path';

const escape = text => String(text ?? '').replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/:/g, '%3A').replace(/,/g, '%2C');

export function annotation(data, cwd = process.cwd()) {
  const error = data.details?.error;
  const message = String(error?.cause?.message ?? error?.message ?? error ?? 'failed').split('\n').find(Boolean) ?? 'failed';
  const file = data.file ? path.relative(cwd, data.file.replace(/^file:\/\//, '')) : '';
  return `::error${file ? ` file=${escape(file)}` : ''},title=${escape(data.name)}::${escape(message.slice(0, 300))}\n`;
}

export default async function* ciFailureReporter(source) {
  for await (const event of source) {
    if (event.type === 'test:fail' && event.data.details?.type !== 'suite') yield annotation(event.data);
  }
}
