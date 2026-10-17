import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { PUBLIC_DIR } from './config.js';

/** An error whose message is safe to show to the person using the app. */
export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function isHttps(req) {
  return req.headers['x-forwarded-proto'] === 'https' || Boolean(req.socket.encrypted);
}

export function clientIp(req) {
  const forwarded = req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function applySecurityHeaders(req, res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  // Browsers only honour these two on a secure address (and complain in the console otherwise).
  if (isHttps(req)) {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  }
}

export function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export async function readJson(req, limitBytes) {
  const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'Requests must be JSON.');
  const declared = Number(req.headers['content-length']);
  if (declared > limitBytes) throw new HttpError(413, 'That upload is too large.');

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new HttpError(413, 'That upload is too large.');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'The request was not valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Expected a JSON object.');
  return value;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.webmanifest', '.svg', '.txt', '.md']);
const LONG_CACHE = /^\/(exercises\/img|icons)\//;

// ---- service worker ----------------------------------------------------------------------

const SHELL_ROOTS = ['index.html', 'manifest.webmanifest', 'css', 'js', 'icons', 'exercises/index.json', 'exercises/steps.json'];

/** Every file the app needs to start offline, with a tag that changes when the file does. */
function listShell() {
  const files = [];
  const walk = (rel) => {
    const stat = fs.statSync(path.join(PUBLIC_DIR, rel));
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(path.join(PUBLIC_DIR, rel)).sort()) walk(`${rel}/${name}`);
    } else if (!/\.(LICENSE|md)$/.test(rel)) {
      files.push({ url: `/${rel}`, tag: `${stat.size}-${Math.round(stat.mtimeMs)}` });
    }
  };
  for (const root of SHELL_ROOTS) walk(root);
  return files;
}

/**
 * sw.js is a template: the list of app files and a version derived from them are filled in here,
 * so phones pick up a new release by themselves and nobody has to maintain the list by hand.
 */
export function serveServiceWorker(req, res) {
  const files = listShell();
  const version = crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 12);
  const urls = ['/', ...files.map((file) => file.url).filter((url) => url !== '/index.html')];
  const body = fs
    .readFileSync(path.join(PUBLIC_DIR, 'sw.js'), 'utf8')
    .replace('__VERSION__', version)
    .replace('/*__SHELL__*/', urls.map((url) => JSON.stringify(url)).join(', '));
  res.writeHead(200, {
    'Content-Type': 'text/javascript; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

// path -> { etag, gzip } so each text asset is compressed once per version.
const gzipCache = new Map();

/** Serve a file from public/. Resolves false when there is nothing to serve at that path. */
export async function serveStatic(req, res, urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return false;
  }
  if (rel.includes('\0')) return false;
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(PUBLIC_DIR, rel);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return false;

  let stat;
  try {
    stat = await fs.promises.stat(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const ext = path.extname(file).toLowerCase();
  const etag = `W/"${stat.size.toString(36)}-${Math.round(stat.mtimeMs).toString(36)}"`;
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    ETag: etag,
    // Code is always revalidated so an update shows up on the next launch; photos never change.
    'Cache-Control': LONG_CACHE.test(rel.replaceAll('\\', '/')) ? 'public, max-age=2592000' : 'no-cache',
  };

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }

  const wantsGzip = COMPRESSIBLE.has(ext) && stat.size > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  if (COMPRESSIBLE.has(ext)) headers.Vary = 'Accept-Encoding';

  if (wantsGzip) {
    let entry = gzipCache.get(file);
    if (!entry || entry.etag !== etag) {
      entry = { etag, gzip: zlib.gzipSync(await fs.promises.readFile(file), { level: 8 }) };
      gzipCache.set(file, entry);
    }
    headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = entry.gzip.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : entry.gzip);
    return true;
  }

  headers['Content-Length'] = stat.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  await new Promise((resolve) => {
    const stream = fs.createReadStream(file);
    stream.on('error', () => {
      res.destroy();
      resolve();
    });
    stream.on('end', resolve);
    stream.pipe(res);
  });
  return true;
}
