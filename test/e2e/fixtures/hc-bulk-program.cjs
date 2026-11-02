// Child of hc-client.e2e.mjs: after one stdin line, writes argv[2] numbered lines in paced bursts so
// the line count measures hc's credit window, not ConPTY repainting.
const total = Number(process.argv[2]);
process.stdout.write('HC-READY\n');
process.stdin.once('data', () => {
  let n = 0;
  const tick = () => {
    let s = '';
    for (let i = 0; i < 40 && n < total; i++) {
      n++;
      const id = String(n).padStart(6, '0');
      s += `L${id}:${id.repeat(13)}\n`;
    }
    process.stdout.write(s, () => {
      if (n < total) setTimeout(tick, 10);
      else process.stdout.write('HC-BULK-END\n', () => setTimeout(() => process.exit(0), 200));
    });
  };
  tick();
});
