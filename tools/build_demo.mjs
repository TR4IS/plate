// Builds the public browser-only demo of Plate into another folder (the website), served under a sub-path.
//   node tools/build_demo.mjs <out-dir> [base]      e.g.  node tools/build_demo.mjs ../ascii-galaxy-test/plate /plate
// The demo is the real app from public/ with three changes: every absolute path gets the base in front, the
// service worker is left out, and demo/demo-mock.js answers the app's /api requests inside the browser.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [outArg, baseArg = '/plate'] = process.argv.slice(2);
if (!outArg) {
  console.error('usage: node tools/build_demo.mjs <out-dir> [base]');
  process.exit(1);
}
const OUT = path.resolve(outArg);
const BASE = '/' + baseArg.replace(/^\/+|\/+$/g, '');
const PUBLIC = path.join(ROOT, 'public');

if (OUT === PUBLIC || OUT.startsWith(PUBLIC + path.sep)) throw new Error('refusing to build into public/');
fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(PUBLIC, OUT, { recursive: true, filter: (src) => path.basename(src) !== 'sw.js' });
fs.copyFileSync(path.join(ROOT, 'demo', 'demo-mock.js'), path.join(OUT, 'js', 'demo-mock.js'));

function edit(rel, change) {
  const file = path.join(OUT, rel);
  const before = fs.readFileSync(file, 'utf8');
  const after = change(before);
  if (after === before) throw new Error(`nothing changed in ${rel}: the app moved on, update build_demo.mjs`);
  fs.writeFileSync(file, after);
}
const rebase = (s) => s.replace(/(["'`(])\/(css|js|icons|exercises|manifest\.webmanifest)\b/g, `$1${BASE}/$2`);

edit('index.html', (s) =>
  rebase(s)
    .replace('<title>Plate</title>', '<title>Plate demo</title>')
    .replace(/\s*<link rel="manifest"[^>]*>/, '')
    .replace(
      '<script src="' + BASE + '/js/theme.js"></script>',
      `<script src="${BASE}/js/demo-mock.js" data-base="${BASE}"></script>\n    <script src="${BASE}/js/theme.js"></script>`,
    ),
);
edit('manifest.webmanifest', (s) => rebase(s).replace(/"start_url"\s*:\s*"\/"/, `"start_url": "${BASE}/"`).replace(/"scope"\s*:\s*"\/"/, `"scope": "${BASE}/"`));
edit('js/exercises.js', rebase);
edit('js/views/auth.js', rebase);
// No service worker in the demo: it would cache the site's root scope.
edit('js/main.js', (s) => s.replace(/if \('serviceWorker' in navigator && window\.isSecureContext\)/, 'if (false)'));

let files = 0;
let bytes = 0;
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else {
      files += 1;
      bytes += fs.statSync(full).size;
    }
  }
})(OUT);
console.log(`demo built at ${OUT} (base ${BASE}): ${files} files, ${(bytes / 1e6).toFixed(1)} MB`);
