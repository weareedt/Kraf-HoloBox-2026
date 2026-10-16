#!/usr/bin/env node
/**
 * KRAF kiosk static server. Zero dependencies, offline, localhost only.
 *
 * Two things here are load-bearing and must not be "simplified":
 *
 *  1. HTTP Range / 206 support. A naive createReadStream server breaks <video>
 *     seeking in Chrome and can break playback outright. This is the single most
 *     common way a hand-written static server fails for media.
 *
 *  2. GET /api/manifest enriches content.json by stat()-ing every asset it
 *     references, injecting `bytes` and `exists`. That gives the loading screen a
 *     byte-exact denominator, and gives the product viewer its "is the FBX here
 *     yet?" signal — without anyone hand-maintaining a file list.
 */

import { createReadStream, existsSync, statSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');
const CONTENT = join(ROOT, 'content');
const PORT = Number(process.env.KRAF_PORT ?? 8765);
const HOST = '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.srt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.fbx': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.bin': 'application/octet-stream',
};

/* ---------------------------------------------------------------- manifest */

/** Walk the manifest and collect every string that looks like an asset path. */
function collectAssetPaths(node, out = []) {
  if (typeof node === 'string') {
    // A frame PATTERN such as "frame-{i:02}.webp" is a template, not a file — skip it,
    // or every turntable would be reported as a missing asset.
    if (/^artists\/.+\.(mp4|webm|png|jpg|webp|srt|fbx|glb)$/i.test(node) && !node.includes('{')) out.push(node);
  } else if (Array.isArray(node)) {
    for (const v of node) collectAssetPaths(v, out);
  } else if (node && typeof node === 'object') {
    for (const v of Object.values(node)) collectAssetPaths(v, out);
  }
  return out;
}

function buildManifest() {
  const raw = JSON.parse(readFileSync(join(CONTENT, 'content.json'), 'utf8'));
  const assets = {};
  for (const rel of new Set(collectAssetPaths(raw))) {
    const abs = join(CONTENT, rel);
    let bytes = 0, exists = false;
    try { const s = statSync(abs); bytes = s.size; exists = s.isFile(); } catch { /* absent */ }
    assets[rel] = { bytes, exists };
  }
  return { ...raw, assets };
}

/* ------------------------------------------------------------------ static */

function resolveSafe(base, urlPath) {
  const clean = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, '');
  const abs = join(base, clean);
  // reject traversal outside the base
  return abs === base || abs.startsWith(base + sep) ? abs : null;
}

/**
 * Validator for conditional requests. Cheap and exact enough: any edit changes the
 * mtime, the size, or both.
 */
const etagOf = (stat) => `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;

function serveFile(req, res, file) {
  const stat = statSync(file);
  const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
  const range = req.headers.range;

  /* Caching policy.
   *
   * Everything is "no-cache", which does NOT mean "do not store" — it means the
   * browser must revalidate before reuse. With an ETag that costs one 304 on
   * localhost and nothing is transferred.
   *
   * The previous policy ("immutable, max-age=1 year") was actively harmful here: the
   * kiosk runs from a PERSISTENT Chrome profile, so an edited app.js or app.css was
   * pinned for a year and updates silently never arrived. It is invisible during
   * development, because a fresh profile has an empty cache and always fetches the
   * newest file — which is exactly how it went unnoticed.
   */
  const etag = etagOf(stat);
  const lastModified = new Date(stat.mtimeMs).toUTCString();
  const cacheHeaders = {
    'Cache-Control': 'no-cache',
    ETag: etag,
    'Last-Modified': lastModified,
  };

  const ifNoneMatch = req.headers['if-none-match'];
  const ifModifiedSince = req.headers['if-modified-since'];
  const fresh = (ifNoneMatch && ifNoneMatch === etag) ||
    (!ifNoneMatch && ifModifiedSince && Date.parse(ifModifiedSince) >= Math.floor(stat.mtimeMs / 1000) * 1000);
  if (fresh && !range) {
    res.writeHead(304, cacheHeaders);
    return res.end();
  }

  // Media must be range-servable, or Chrome cannot seek.
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      let start = m[1] === '' ? null : Number(m[1]);
      let end = m[2] === '' ? null : Number(m[2]);
      if (start === null) {                       // suffix form: bytes=-N
        const n = end ?? 0;
        start = Math.max(0, stat.size - n);
        end = stat.size - 1;
      } else {
        end = end === null ? stat.size - 1 : Math.min(end, stat.size - 1);
      }
      if (!Number.isFinite(start) || start > end || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        return res.end();
      }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        ...cacheHeaders,
      });
      if (req.method === 'HEAD') return res.end();
      return createReadStream(file, { start, end }).pipe(res);
    }
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
    ...cacheHeaders,
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

/* ------------------------------------------------------------------ router */

const server = createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}`);
    let path = url.pathname;

    if (path === '/api/manifest') {
      const body = JSON.stringify(buildManifest());
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
      });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }

    if (path === '/') path = '/index.html';

    // /content/* serves the asset tree; everything else serves web/
    const isContent = path.startsWith('/content/');
    const file = isContent
      ? resolveSafe(CONTENT, path.slice('/content/'.length))
      : resolveSafe(WEB, path);

    if (!file || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(`404 ${path}`);
    }
    serveFile(req, res, file);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`500 ${err.message}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`KRAF kiosk serving  http://${HOST}:${PORT}`);
  console.log(`  web     ${WEB}`);
  console.log(`  content ${CONTENT}`);
});
