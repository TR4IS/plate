import http from 'node:http';
import { DATA_DIR, HOST, PORT, VERSION } from './config.js';
import { db } from './db.js';
import { HttpError, applySecurityHeaders, sendJson, serveServiceWorker, serveStatic } from './http.js';
import { handleApi } from './api.js';
import { aiConfig, PROVIDER_INFO } from './ai.js';

const server = http.createServer(async (req, res) => {
  applySecurityHeaders(req, res);
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    res.writeHead(400).end();
    return;
  }

  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
    if (url.pathname === '/sw.js') {
      serveServiceWorker(req, res);
      return;
    }
    if (await serveStatic(req, res, url.pathname)) return;
    // Anything that isn't a file is a screen inside the app.
    if (!/\.\w+$/.test(url.pathname) && (await serveStatic(req, res, '/index.html'))) return;
    throw new HttpError(404, 'Not found.');
  } catch (err) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (err instanceof HttpError) {
      sendJson(res, err.status, { error: err.message, ...err.extra }, err.status === 413 ? { Connection: 'close' } : {});
      return;
    }
    console.error(`[${new Date().toISOString()}] ${req.method} ${url.pathname}`, err);
    sendJson(res, 500, { error: 'Something went wrong on the server.' });
  }
});

server.listen(PORT, HOST, () => {
  const config = aiConfig();
  const aiLine = config.ready
    ? `${PROVIDER_INFO[config.provider]?.label || config.provider} (${config.models[config.provider] || 'test'})`
    : 'not connected yet - add a key in Settings';
  console.log(`Plate ${VERSION} is running on http://${HOST}:${PORT}`);
  console.log(`  data folder: ${DATA_DIR}`);
  console.log(`  AI: ${aiLine}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  // Don't hang on a phone that keeps its connection open.
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
