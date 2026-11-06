// Tiny static file server for the browser smoke tests: serves the repo root
// the way GitHub Pages does (plain files, no build). Started by Playwright's
// `webServer` (see playwright.config.js); bound to localhost only.
//
//   node tests/e2e/server.js [port]   (default: $E2E_PORT or 41730)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.argv[2] || process.env.E2E_PORT || 41730);
const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.mp4': 'video/mp4',
};

const server = http.createServer((req, res) => {
    let rel;
    try {
        rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
        res.writeHead(400);
        return res.end();
    }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(ROOT, rel);
    // No escaping the repo root, and nothing from dot-directories (.git etc.).
    if (!file.startsWith(ROOT + path.sep) || /(^|[\\/])\./.test(path.relative(ROOT, file))) {
        res.writeHead(404);
        return res.end();
    }
    fs.stat(file, (err, st) => {
        if (err || !st.isFile()) {
            res.writeHead(404);
            return res.end();
        }
        res.writeHead(200, {
            'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
            'content-length': st.size,
            'cache-control': 'no-store',
        });
        if (req.method === 'HEAD') return res.end();
        fs.createReadStream(file).pipe(res);
    });
});

server.listen(PORT, '127.0.0.1', () => {
    console.log('e2e static server on http://127.0.0.1:' + PORT + '/');
});
