// Minimal static file server for the gitignored out/ dir, used to preview the
// webview bundle in a browser (playwright-cli blocks file:// navigation).

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';

const root = join(process.cwd(), 'out');
const port = Number(process.argv[2] ?? 5174);
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.map': 'application/json',
};

const server = createServer(async (req, res) => {
  try {
    const url = (req.url ?? '/').split('?')[0];
    const file = url === '/' ? 'preview.html' : decodeURIComponent(url.replace(/^\//, ''));
    const body = await readFile(join(root, file));
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`preview server: http://127.0.0.1:${port}/preview.html`);
});
