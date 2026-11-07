import { createInterface } from 'node:readline';

process.stdout.write('KIRO READY\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  process.stdout.write(`GOT:${line}\n`);
});
