'use strict';
// Manifest sanity: parses, and every file it (or the popup/report pages) references exists.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

test('manifest.json parses and is manifest_version 3', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(typeof manifest.name, 'string');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, '128.0');
});

test('background scripts exist', () => {
  for (const f of manifest.background.scripts) assert.ok(exists(f), `missing ${f}`);
});

test('content_scripts js/css files exist', () => {
  for (const cs of manifest.content_scripts) {
    for (const f of cs.js || []) assert.ok(exists(f), `missing ${f}`);
    for (const f of cs.css || []) assert.ok(exists(f), `missing ${f}`);
  }
});

test('icons (action, sidebar, top-level) exist', () => {
  const sets = [manifest.icons, manifest.action.default_icon, manifest.sidebar_action.default_icon];
  for (const set of sets) for (const f of Object.values(set)) assert.ok(exists(f), `missing ${f}`);
});

test('sidebar/popup panel and web_accessible_resources exist', () => {
  assert.ok(exists(manifest.sidebar_action.default_panel));
  if (manifest.action.default_popup) assert.ok(exists(manifest.action.default_popup));
  for (const war of manifest.web_accessible_resources || []) {
    for (const f of war.resources || []) {
      if (!f.includes('*')) assert.ok(exists(f), `missing ${f}`);
    }
  }
});

test('every <script src> and <link href> in extension HTML pages exists', () => {
  const pages = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));
  assert.ok(pages.length > 0);
  for (const page of pages) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    const refs = [...html.matchAll(/<(?:script|link)[^>]*(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    for (const ref of refs) {
      if (/^(https?:|data:|#)/.test(ref)) continue;
      assert.ok(exists(ref), `${page} references missing ${ref}`);
    }
  }
});
