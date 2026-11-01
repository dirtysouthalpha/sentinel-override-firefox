'use strict';
// Pure helper behaviour, loaded in a vm context with a stub window.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadInWindow(rel, extra = {}) {
  const window = { location: { href: 'about:blank' }, ...extra };
  window.window = window;
  const ctx = vm.createContext(window);
  vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), ctx, { filename: rel });
  // The context has its own Date builtin; expose it so tests can freeze the clock.
  Object.defineProperty(window, '__vmDate', { value: vm.runInContext('Date', ctx), enumerable: false });
  return window;
}

// ---- popup-modules/helpers.js ----
const helpersWin = loadInWindow('popup-modules/helpers.js');
const H = helpersWin.Helpers;

test('helpers: getErrorMessage handles strings, errors, objects, falsy', () => {
  assert.equal(H.getErrorMessage('boom'), 'boom');
  assert.equal(H.getErrorMessage(new Error('bad')), 'bad');
  assert.equal(H.getErrorMessage({ message: 'obj' }), 'obj');
  assert.equal(H.getErrorMessage(null), '');
  assert.equal(H.getErrorMessage(undefined), '');
  assert.equal(H.getErrorMessage(42), '42');
  assert.equal(helpersWin.getErrorMessage, H.getErrorMessage, 'bare global alias kept');
});

test('helpers: formatDuration formats s / m s / h m', () => {
  assert.equal(H.formatDuration(0, 1000), '');
  assert.equal(H.formatDuration(1000, 1000 + 45_000), '45s');
  assert.equal(H.formatDuration(1000, 1000 + 5 * 60_000 + 7_000), '5m 7s');
  assert.equal(H.formatDuration(1000, 1000 + 2 * 3_600_000 + 3 * 60_000), '2h 3m');
});

test('helpers: relativeTime and formatCountdown relative to a frozen clock', () => {
  const NOW = 1_700_000_000_000;
  const realNow = helpersWin.__vmDate.now;
  helpersWin.__vmDate.now = () => NOW;
  try {
    assert.equal(H.relativeTime(0), 'Never');
    assert.equal(H.relativeTime(NOW - 10_000), 'Just now');
    assert.equal(H.relativeTime(NOW - 5 * 60_000), '5m ago');
    assert.equal(H.relativeTime(NOW - 3 * 3_600_000), '3h ago');
    assert.equal(H.relativeTime(NOW - 2 * 86_400_000), '2d ago');

    assert.equal(H.formatCountdown(0), 'Not scheduled');
    assert.equal(H.formatCountdown(NOW - 1), 'Overdue');
    assert.equal(H.formatCountdown(NOW + 15 * 60_000), '15m away');
    assert.equal(H.formatCountdown(NOW + 3_600_000 + 5 * 60_000), '1h 5m away');
    assert.equal(H.formatCountdown(NOW + 2 * 86_400_000 + 3 * 3_600_000), '2d 3h away');
  } finally {
    helpersWin.__vmDate.now = realNow;
  }
});

// ---- content/dom-utils.js ----
const domWin = loadInWindow('content/dom-utils.js', { document: { defaultView: null } });
const dom = domWin.__sentinelUtils.dom;

function el(tag, { parent = null, prev = null, style = {}, attrs = {}, disabled } = {}) {
  const e = {
    tagName: tag.toUpperCase(),
    parentElement: parent,
    previousElementSibling: prev,
    isConnected: true,
    disabled,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    ownerDocument: { defaultView: { getComputedStyle: () => ({ pointerEvents: 'auto', ...style }) } },
  };
  return e;
}

test('dom-utils: getNthOfTypePath counts same-tag siblings and stops at root', () => {
  const html = el('html');
  const body = el('body', { parent: html });
  const div1 = el('div', { parent: body });
  const p1 = el('p', { parent: body, prev: div1 });
  const div2 = el('div', { parent: body, prev: p1 });
  const span = el('span', { parent: div2 });
  assert.equal(dom.getNthOfTypePath(span), 'body:nth-of-type(1) > div:nth-of-type(2) > span:nth-of-type(1)');
  assert.equal(dom.getNthOfTypePath(html), '');
});

test('dom-utils: checkInteractable reports the blocking reason', () => {
  assert.equal(dom.checkInteractable(null, 'click'), 'Element not found');
  const detached = el('button'); detached.isConnected = false;
  assert.equal(dom.checkInteractable(detached, 'click'), 'Element is detached from DOM');
  assert.equal(dom.checkInteractable(el('button', { style: { pointerEvents: 'none' } }), 'click'), 'Element is pointer-events:none');
  assert.equal(dom.checkInteractable(el('button', { style: { pointerEvents: 'none' } }), 'type'), null, 'pointer-events only matters for click');
  assert.equal(dom.checkInteractable(el('button', { disabled: true }), 'click'), 'Element is disabled');
  assert.equal(dom.checkInteractable(el('button', { attrs: { 'aria-disabled': 'true' } }), 'click'), 'Element is aria-disabled');
  assert.equal(dom.checkInteractable(el('button'), 'click'), null);
});

// ---- content/wait-utils.js ----
test('wait-utils: sleep resolves after the delay; checkCondition navigation + unknown type', async () => {
  const waitWin = loadInWindow('content/wait-utils.js', {
    setTimeout,
    document: { body: { innerText: 'hello world' }, querySelector: () => null },
  });
  const wait = waitWin.__sentinelUtils.wait;
  const t0 = Date.now();
  await wait.sleep(20);
  assert.ok(Date.now() - t0 >= 15);
  assert.equal(wait.checkCondition({ type: 'wait_for_text', text: 'world' }), true);
  assert.equal(wait.checkCondition({ type: 'wait_for_text', text: 'absent' }), false);
  assert.equal(wait.checkCondition({ type: 'wait_for_navigation', currentUrl: 'about:blank' }), false);
  assert.equal(wait.checkCondition({ type: 'wait_for_navigation', currentUrl: 'http://x/' }), true);
  assert.equal(wait.checkCondition({ type: 'wait_for_element', selector: '#nope' }), false);
  assert.equal(wait.checkCondition({ type: 'bogus' }), false);
});
