import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, it } from 'vitest';

const execute = promisify(execFile);
let root: string;
let host: string;
beforeAll(async () => {
  const scratch = path.join(tmpdir(), 'Codex-scratch');
  fs.mkdirSync(scratch, { recursive: true });
  root = fs.mkdtempSync(path.join(scratch, 'conduit-search-worker-'));
  host = path.join(root, 'host.js');
  for (const [source, output] of [
    ['src/content-search-fs.ts', host],
    ['src/content-search-worker.ts', path.join(root, 'content-search-worker.js')],
  ]) {
    const result = await build({
      entryPoints: [source],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      write: false,
    });
    fs.writeFileSync(output, result.outputFiles[0].contents);
  }
});
afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

it('bounds catastrophic regex execution while host timers keep running', async () => {
  const fixture = path.join(root, 'pathological.txt');
  fs.writeFileSync(fixture, `${'a'.repeat(80)}!`);
  const program = `
    const {searchContentFs}=require(process.argv[1]);
    let ticks=0;
    const timer=setInterval(()=>ticks++,20);
    const start=Date.now();
    searchContentFs(process.argv[2],{text:'(a+)+$',regex:true},undefined,[{abs:process.argv[3],rel:'pathological.txt'}]).then(result=>{
      clearInterval(timer);
      console.log(JSON.stringify({result,ticks,elapsed:Date.now()-start}));
    });
  `;
  const execution = await execute(process.execPath, ['-e', program, host, root, fixture], {
    timeout: 4500,
  }).then(
    ({ stdout }) => JSON.parse(stdout),
    () => null,
  );
  expect(execution).not.toBe(null);
  expect(execution.result.truncated).toBe(true);
  expect(execution.ticks).toBeGreaterThan(10);
  expect(execution.elapsed).toBeLessThan(4000);
});

it('preserves JavaScript regex results, invalid-pattern errors, and the literal path', async () => {
  const fixture = path.join(root, 'normal.txt');
  fs.writeFileSync(fixture, 'Foo foo\nfood\n');
  const program = `
    const {searchContentFs}=require(process.argv[1]);
    const files=[{abs:process.argv[3],rel:'normal.txt'}];
    (async()=>{
      const regex=await searchContentFs(process.argv[2],{text:'(?<=F)oo',regex:true,matchCase:true},undefined,files);
      const literal=await searchContentFs(process.argv[2],{text:'foo',matchCase:true},undefined,files);
      const invalid=await searchContentFs(process.argv[2],{text:'[',regex:true},undefined,files);
      console.log(JSON.stringify({regex,literal,invalid}));
    })();
  `;
  const { stdout } = await execute(process.execPath, ['-e', program, host, root, fixture], {
    timeout: 4500,
  });
  const results = JSON.parse(stdout);
  expect(results.regex.files[0].matches).toEqual([{ line: 1, column: 2, lineText: 'Foo foo' }]);
  expect(results.literal.files[0].matches).toEqual([
    { line: 1, column: 5, lineText: 'Foo foo' },
    { line: 2, column: 1, lineText: 'food' },
  ]);
  expect(results.invalid.files).toEqual([]);
  expect(results.invalid.error).toBeTruthy();
});

it('bounds queued searches, cancels active and queued work, and accepts later requests', async () => {
  const fixture = path.join(root, 'cancellation.txt');
  fs.writeFileSync(fixture, `${'a'.repeat(80)}!`);
  const program = `
    const {searchContentFs}=require(process.argv[1]);
    const files=[{abs:process.argv[3],rel:'cancellation.txt'}];
    let cancelled=false;
    const start=Date.now();
    const searches=Array.from({length:12},()=>searchContentFs(process.argv[2],{text:'(a+)+$',regex:true},()=>cancelled,files));
    setTimeout(()=>cancelled=true,100);
    (async()=>{
      const results=await Promise.all(searches);
      const elapsed=Date.now()-start;
      const next=await searchContentFs(process.argv[2],{text:'!',regex:true},undefined,files);
      console.log(JSON.stringify({results,elapsed,next}));
    })();
  `;
  const { stdout } = await execute(process.execPath, ['-e', program, host, root, fixture], {
    timeout: 4500,
  });
  const { results, elapsed, next } = JSON.parse(stdout);
  expect(results.filter((result: { error?: string }) => result.error)).toHaveLength(2);
  expect(results.every((result: { truncated: boolean }) => result.truncated)).toBe(true);
  expect(elapsed).toBeLessThan(1500);
  expect(next.files[0].matches[0].column).toBe(81);
});

it('settles a worker startup failure and releases its slot', async () => {
  const workerFile = path.join(root, 'content-search-worker.js');
  const savedWorker = fs.readFileSync(workerFile);
  fs.unlinkSync(workerFile);
  try {
    const program = `
      const {searchContentFs}=require(process.argv[1]);
      (async()=>{
        const results=[];
        for(let i=0;i<3;i++)results.push(await searchContentFs(process.argv[2],{text:'x',regex:true}));
        console.log(JSON.stringify(results));
      })();
    `;
    const { stdout } = await execute(process.execPath, ['-e', program, host, root], {
      timeout: 4500,
    });
    const results = JSON.parse(stdout);
    expect(results).toHaveLength(3);
    expect(results.every((result: { error?: string }) => Boolean(result.error))).toBe(true);
  } finally {
    fs.writeFileSync(workerFile, savedWorker);
  }
});
