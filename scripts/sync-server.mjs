#!/usr/bin/env node
/**
 * sync-server.mjs — Mini HTTP server local que corre en tu PC.
 *
 * Expone endpoints:
 *   GET  /status → responde OK si esta corriendo (el dashboard verifica esto).
 *   POST /sync   → corre actualizar.cmd (sync + commit + push) y devuelve el output.
 *
 * El dashboard (que corre en Vercel/GH Pages) llama a http://localhost:3131 desde
 * el botón "Sincronizar" del header. Los browsers modernos permiten HTTPS → localhost
 * porque localhost se considera secure context.
 *
 * Cómo arrancarlo: doble-click a sync-server.cmd o `node scripts/sync-server.mjs`.
 * Para que arranque solo con Windows, poné un acceso directo del .cmd en la carpeta
 * Startup (Win+R → shell:startup).
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 3131;
const REPO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const CMD_SCRIPT = join(REPO_DIR, 'actualizar.cmd');

// Origenes que pueden llamar al servidor (CORS)
const ALLOWED_ORIGINS = [
  'https://dashboards-ganaderos.vercel.app',
  'https://bbocangel-ai.github.io',
  'http://localhost:4321',
  'http://localhost:3000',
];

let syncing = false;

function setCors(res, origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader('Access-Control-Allow-Origin', allowed);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
}

function runActualizar() {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const proc = spawn('cmd.exe', ['/c', CMD_SCRIPT], {
      cwd: REPO_DIR,
      windowsHide: true,
    });
    let out = '';
    let err = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('close', code => {
      resolve({
        code,
        duration_ms: Date.now() - startedAt,
        stdout: out.slice(-4000),
        stderr: err.slice(-2000),
      });
    });
  });
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  setCors(res, origin);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, version: '1.0', syncing }));
    return;
  }

  if (req.url === '/sync' && req.method === 'POST') {
    if (syncing) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Ya hay un sync corriendo' }));
      return;
    }
    syncing = true;
    console.log(`[${new Date().toISOString()}] Sync iniciado por ${origin || 'unknown'}`);
    try {
      const result = await runActualizar();
      syncing = false;
      const success = result.code === 0;
      console.log(`[${new Date().toISOString()}] Sync ${success ? 'OK' : 'FAIL'} en ${Math.round(result.duration_ms/1000)}s`);
      res.writeHead(success ? 200 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: success,
        duration_s: Math.round(result.duration_ms / 1000),
        stdout: result.stdout,
        stderr: result.stderr,
      }));
    } catch (e) {
      syncing = false;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  ============================================');
  console.log('  Sync server corriendo en http://localhost:' + PORT);
  console.log('  ============================================');
  console.log('');
  console.log('  Dejá esta ventana abierta.');
  console.log('  Cuando aprietes "Sincronizar" en el dashboard, corre aquí.');
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Ya hay algo en el puerto ${PORT}. Cerrá el otro sync-server.`);
  } else {
    console.error('Error:', err.message);
  }
  process.exit(1);
});
