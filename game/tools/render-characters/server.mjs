// Local helper for tools/render-characters: serves this folder, the unzipped Quaternius pack (/models/) and three.js
// (/node_modules/), and stores the PNGs the page POSTs to /save. Usage: see README.md.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const MODELS = path.resolve(process.env.QUATERNIUS_DIR || path.join(here, 'pack'));
const OUT = path.resolve(process.env.RENDER_OUT || path.join(here, 'out'));
fs.mkdirSync(OUT, { recursive: true });

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };

http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/save') {
        const name = path.basename(url.searchParams.get('name') || 'x.png');
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => { fs.writeFileSync(path.join(OUT, name), Buffer.concat(chunks)); res.end('ok'); });
        return;
    }
    const file = url.pathname.startsWith('/models/')
        ? path.join(MODELS, decodeURIComponent(url.pathname.slice(8)))
        : path.join(here, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; res.end('not found'); return; }
    res.setHeader('Content-Type', types[path.extname(file).toLowerCase()] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
}).listen(8090, () => console.log('render helper on http://localhost:8090  models:', MODELS, ' out:', OUT));
