'use strict';
// Every JS file in the extension parses. Browser scripts are never executed here;
// `node --check` only parses. ES modules are checked via a temp .mjs copy.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DIRS = ['', 'background', 'background/platforms', 'background/skills', 'content', 'popup-modules', 'compat', 'lib'];

function listJs() {
  const out = [];
  for (const d of DIRS) {
    const abs = path.join(ROOT, d);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) {
      if (f.endsWith('.js') && fs.statSync(path.join(abs, f)).isFile()) out.push(path.join(d, f));
    }
  }
  return out;
}

function check(file) {
  return spawnSync(process.execPath, ['--check', file], { cwd: ROOT, encoding: 'utf8' });
}

const files = listJs();
assert.ok(files.length > 50, `expected many JS files, found ${files.length}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'so-syntax-'));

for (const file of files) {
  test(`parses: ${file}`, () => {
    let r = check(file);
    if (r.status !== 0 && /import|export/.test(r.stderr)) {
      // ES module (e.g. compat/firefox-entry.js, background/*.js): re-check as .mjs
      const copy = path.join(tmp, file.replace(/[\\/]/g, '__') + '.mjs');
      fs.copyFileSync(path.join(ROOT, file), copy);
      r = check(copy);
    }
    assert.equal(r.status, 0, r.stderr);
  });
}
