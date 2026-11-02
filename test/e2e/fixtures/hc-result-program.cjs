// Child of hc-client.e2e.mjs: prints HC-RESULT once stdin carries "go", or HC-TIMEOUT after 30 s.
process.stdout.write('HC-READY\n');
let done = false;
const timer = setTimeout(() => {
  if (!done) {
    process.stderr.write('HC-TIMEOUT\n');
    process.exit(2);
  }
}, 30000);
process.stdin.on('data', (d) => {
  if (!done && d.includes('go')) {
    done = true;
    clearTimeout(timer);
    process.stdout.write('HC-RESULT\n', () => process.exit(0));
  }
});
