/**
 * Local stand-in for the Apps Script backend: the real apps-script/Code.gs, run on in-memory fake
 * Google services (apps-script/test/gas-harness.mjs). For developing/testing the admin page and the
 * game's admin-command handling without touching the live spreadsheet.
 *
 *   npm run mock-backend                       -> http://localhost:8787/exec   (admin PIN 1234)
 *   game:  http://localhost:8080/?backend=http://localhost:8787/exec
 *   admin: http://localhost:8080/admin.html?backend=http://localhost:8787/exec
 *
 * (`?backend=` is honoured by dev builds only.) Everything is in memory: restart to reset.
 */
import http from 'node:http';
import { loadBackend } from '../../apps-script/test/gas-harness.mjs';

const PORT = Number(process.env.PORT) || 8787;
const backend = loadBackend({ realClock: true, legacyPin: '1234' });

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

function send(res, status, body) {
    res.writeHead(status, { ...CORS, 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS);
        res.end();
        return;
    }

    if (req.method === 'GET') {
        send(res, 200, backend.get());
        return;
    }

    if (req.method === 'POST') {
        let raw = '';
        req.on('data', chunk => { raw += chunk; });
        req.on('end', () => send(res, 200, backend.postRaw(raw)));
        return;
    }

    send(res, 405, { ok: false, error: 'method_not_allowed' });
});

server.listen(PORT, () => {
    console.log(`Mock backend on http://localhost:${PORT}/exec  (admin PIN 1234, in-memory)`);
});
