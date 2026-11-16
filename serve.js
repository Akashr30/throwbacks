#!/usr/bin/env node
// Throwbacks local server — plain node http/fs, no packages, no package.json.
//
// Run:  node serve.js
// Then open the printed http://127.0.0.1:<port>/ URL.
//
// Binds to 127.0.0.1 by DEFAULT — a private logbook, unreachable from
// other devices. `node serve.js --lan` explicitly opts in to LAN access
// (binds 0.0.0.0); even then only the app's static files are served —
// each visitor loads their own data into their own browser tab.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const LAN = process.argv.includes('--lan');
const HOST = LAN ? '0.0.0.0' : '127.0.0.1'; // local-only unless opted in

const BASE_PORT = 8770;
const PORT_TRIES = 6; // base port + next 5

// Serve from the script's own directory so launch location doesn't matter.
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  // Path-traversal safety, step 1: reject any '..' segment in the RAW
  // request path — the URL parser below silently normalizes dot segments
  // (even percent-encoded ones) away, so it must not see them first.
  let rawDecoded;
  try {
    rawDecoded = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  if (rawDecoded.split('/').includes('..')) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  if (urlPath === '/') urlPath = '/throwbacks.html';
  const resolved = path.resolve(ROOT, '.' + path.posix.normalize('/' + urlPath));
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(resolved, (err, stat) => {
    if (err || stat.isDirectory()) {
      // Directory listing OFF; missing files 404.
      res.writeHead(err ? 404 : 403).end(err ? 'Not found' : 'Directory listing disabled');
      return;
    }
    const type = MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      // Always revalidate: edits to the app files show up on plain reload.
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(resolved).pipe(res);
  });
});

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
      : 'xdg-open';
  // Never fail to start just because auto-open failed.
  try {
    execFile(cmd, process.platform === 'win32' ? ['', url] : [url], () => {});
  } catch { /* ignore */ }
}

// Announce exactly once, reading the ACTUAL bound port from the socket
// (retries must not stack stale callbacks).
server.once('listening', () => {
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/`;
  console.log(`Throwbacks serving ${ROOT}`);
  console.log(`  → ${url}`);
  if (LAN) {
    console.log('  ⚠ LAN mode: other devices on your network can open the app.');
    console.log('    (They load THEIR data into THEIR browser — nothing of yours is served.)');
    for (const ifaces of Object.values(os.networkInterfaces())) {
      for (const i of ifaces || []) {
        if (i.family === 'IPv4' && !i.internal) console.log(`  → share: http://${i.address}:${port}/`);
      }
    }
  } else {
    console.log('  (local-only: bound to 127.0.0.1 — run with --lan to allow your network)');
  }
  console.log('  Ctrl-C to stop.');
  openBrowser(url);
});

function listen(port, triesLeft) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && triesLeft > 0) {
      console.log(`Port ${port} is taken, trying ${port + 1}…`);
      listen(port + 1, triesLeft - 1);
    } else {
      console.error(`No free port found (last tried ${port}). Stop whatever is using it and retry.`);
      process.exit(1);
    }
  });
  server.listen(port, HOST);
}

process.on('SIGINT', () => {
  console.log('\nThrowbacks server stopped.');
  process.exit(0);
});

listen(BASE_PORT, PORT_TRIES - 1);
