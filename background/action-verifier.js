// background/action-verifier.js — Action verification and self-healing
import { getErrorMessage } from './error-utils.js';

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

export async function capturePageFingerprint(tabId, cdpExecuteJs) {
  try {
    const result = await cdpExecuteJs(tabId, `
      (() => {
        let h = 0x811c9dc5;
        const t = (document.body.innerText || '').substring(0, 5000);
        for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193); }
        return JSON.stringify({ url: location.href, title: document.title, bodyHash: (h >>> 0).toString(36) });
      })()
    `, { returnByValue: true });
    if (result && result.result && result.result.value) return JSON.parse(result.result.value);
  } catch (_e) {}
  return null;
}

export async function verifyPageChanged(tabId, cdpExecuteJs, beforeFingerprint, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(400);
    const after = await capturePageFingerprint(tabId, cdpExecuteJs);
    if (!after) continue;
    if (after.bodyHash !== beforeFingerprint.bodyHash) return true;
    if (after.url !== beforeFingerprint.url) return true;
    if (after.title !== beforeFingerprint.title) return true;
  }
  return false;
}

export async function ensureElementVisible(tabId, cdpExecuteJs, x, y) {
  try {
    const result = await cdpExecuteJs(tabId, `
      (() => {
        const el = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)});
        if (!el) return JSON.stringify({ x: ${Math.round(x)}, y: ${Math.round(y)}, scrolled: false });
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), scrolled: true });
      })()
    `, { returnByValue: true });
    if (result && result.result && result.result.value) return JSON.parse(result.result.value);
  } catch (_e) {}
  return { x, y, scrolled: false };
}

export async function verifiedClick(tabId, cdpExecuteJs, cdpDispatchClickFn, x, y, options = {}) {
  const maxAttempts = options.maxAttempts || 3;
  const expectedChange = options.expectedChange !== false;
  const description = options.description || `Click at (${Math.round(x)}, ${Math.round(y)})`;
  const beforeFingerprint = expectedChange ? await capturePageFingerprint(tabId, cdpExecuteJs) : null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await cdpDispatchClickFn(tabId, x, y, { ...options, description: description + (attempt > 1 ? ` (attempt ${attempt})` : '') });
    if (!result.ok) { await sleep(500 * attempt); continue; }
    if (!expectedChange) return { ok: true, method: 'cdp_direct', attempts: attempt };
    await sleep(300);
    if (beforeFingerprint) {
      const changed = await verifyPageChanged(tabId, cdpExecuteJs, beforeFingerprint, 2000);
      if (changed) return { ok: true, method: 'cdp_direct', attempts: attempt };
    } else { return { ok: true, method: 'cdp_direct', attempts: attempt }; }
    if (attempt < maxAttempts) {
      const adjusted = await ensureElementVisible(tabId, cdpExecuteJs, x, y);
      if (adjusted.scrolled) {
        const retryResult = await cdpDispatchClickFn(tabId, adjusted.x, adjusted.y, { ...options, description: description + ` (scroll-retry ${attempt})` });
        if (retryResult.ok) {
          await sleep(300);
          if (beforeFingerprint) { if (await verifyPageChanged(tabId, cdpExecuteJs, beforeFingerprint, 2000)) return { ok: true, method: 'cdp_scroll_retry', attempts: attempt + 1 }; }
          else { return { ok: true, method: 'cdp_scroll_retry', attempts: attempt + 1 }; }
        }
      }
    }
    if (attempt < maxAttempts) await sleep(800);
  }
  return { ok: false, method: 'all_strategies_exhausted', attempts: maxAttempts, error: `Click verification failed after ${maxAttempts} attempts` };
}
