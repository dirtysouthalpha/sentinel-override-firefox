// Sentinel Override v20.1 — Universal Vision Adapter (Claude-in-Chrome parity upgrade)
//
// Goal: ANY model that claims vision support gets screenshots, with graceful
// degradation instead of hard failure. Claude in Chrome only supports
// Anthropic models; this is one of Brandon's SO can strictly beat it.
//
// Degradation ladder (cheapest transform first, applied on provider rejection):
//   full JPEG  →  grayscale JPEG  →  downscale-tile JPEG (top-left quadrant)
//   →  cropped JPEG (largest interactive-element bbox, padded)  →  text-only
//
// Learned verdicts: every 400/unsupported-vision failure and every success is
// recorded per (provider, model) in chrome.storage.local, so after one miss
// the adapter never re-sends the image to a text-only model, and after one
// hit it stops re-testing degraded variants. Persisted learning = the
// extension gets smarter about YOUR fleet's models over time.
//
// Pure core (verdicts, ladder, prompt building) is exported for tests; the
// chrome-dependent learn/record functions tolerate missing chrome APIs.

import { getErrorMessage } from './error-utils.js';

// ---------- Learned verdicts ----------

const VERDICT_KEY = 'vision_adapter_verdicts';
const VERDICTS_MAX = 200;

function verdictKey(providerId, model) {
  return `${String(providerId || 'unknown')}::${String(model || 'unknown')}`;
}

/** Load the verdict table. Safe without chrome (tests). */
export async function loadVerdicts(storage) {
  const st = storage || (typeof chrome !== 'undefined' && chrome.storage ? chrome.storage.local : null);
  if (!st) return {};
  try {
    const got = await new Promise((resolve) => {
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(_t);
        resolve(v || {});
      };
      const _t = setTimeout(() => done({}), 150); // broken impls can never hang us
      try {
        const r = st.get([VERDICT_KEY], (res) => done(res));
        if (r && typeof r.then === 'function') r.then((res) => done(res), () => done({}));
      } catch (_e) { done({}); }
    });
    const t = got && got[VERDICT_KEY];
    return (t && typeof t === 'object') ? t : {};
  } catch (_e) {
    return {};
  }
}

/** Persist one verdict: 'vision' | 'textonly'. Safe without chrome. */
export async function recordVerdict(providerId, model, verdict, storage) {
  const st = storage || (typeof chrome !== 'undefined' && chrome.storage ? chrome.storage.local : null);
  if (!st) return;
  try {
    const verdicts = await loadVerdicts(st);
    // LRU-ish trim
    const keys = Object.keys(verdicts);
    if (keys.length >= VERDICTS_MAX && !verdicts[verdictKey(providerId, model)]) {
      delete verdicts[keys[0]];
    }
    verdicts[verdictKey(providerId, model)] = { verdict, at: Date.now() };
    await new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; clearTimeout(_t); resolve(); } };
      const _t = setTimeout(done, 150); // promise-style mocks never call the cb
      try {
        const r = st.set({ [VERDICT_KEY]: verdicts }, () => done());
        if (r && typeof r.then === 'function') r.then(done, done);
      } catch (_e) { done(); }
    });
  } catch (_e) { /* learning is best-effort */ }
}

/** Look up a learned verdict. Returns 'vision' | 'textonly' | null. */
export async function getLearnedVerdict(providerId, model, storage) {
  const verdicts = await loadVerdicts(storage);
  const v = verdicts[verdictKey(providerId, model)];
  return v ? v.verdict : null;
}

/**
 * Classify a provider rejection: is this a "vision not supported" error?
 * Exported for tests. Conservative: only clearly vision-related 400s count.
 * @param {number} status - HTTP status
 * @param {string} bodyText - error body
 * @returns {boolean}
 */
export function isVisionRejection(status, bodyText) {
  if (status !== 400 && status !== 422) return false;
  const b = String(bodyText || '').toLowerCase();
  const MARKERS = [
    'image', 'vision', 'multimodal', 'content type', 'content_type',
    'input_format', 'not supported.*image', 'does not support.*image',
    'unsupported.*content', 'image_url', 'media type', 'base64'
  ];
  return MARKERS.some(m => { try { return new RegExp(m).test(b); } catch (_e) { return b.includes(m); } });
}

// ---------- Degradation ladder ----------
//
// Image transforms use OffscreenCanvas when available (service worker),
// falling back to document.createElement('canvas') in windowed contexts.
// Every rung returns null (=> give up on this rung) rather than throwing.

function makeCanvas(width, height) {
  try {
    if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
    if (typeof document !== 'undefined' && document.createElement) {
      const c = document.createElement('canvas');
      c.width = width; c.height = height;
      return c;
    }
  } catch (_e) { /* fall through */ }
  return null;
}

function canvasToJpegUrl(canvas, quality) {
  try {
    if (typeof canvas.convertToBlob === 'function') {
      // OffscreenCanvas path — convert blob -> data URL via FileReader
      return canvas.convertToBlob({ type: 'image/jpeg', quality }).then((blob) => new Promise((resolve) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || ''));
        fr.onerror = () => resolve('');
        fr.readAsDataURL(blob);
      }));
    }
    if (typeof canvas.toDataURL === 'function') {
      return Promise.resolve(canvas.toDataURL('image/jpeg', quality));
    }
  } catch (_e) { /* fall through */ }
  return Promise.resolve('');
}

function loadImage(base64OrDataUrl) {
  return new Promise((resolve) => {
    const src = base64OrDataUrl.startsWith('data:') ? base64OrDataUrl : `data:image/jpeg;base64,${base64OrDataUrl}`;
    try {
      if (typeof createImageBitmap === 'function') {
        fetch(src).then(r => r.blob()).then(b => createImageBitmap(b)).then(bmp => resolve(bmp)).catch(() => resolve(null));
        return;
      }
      if (typeof Image !== 'undefined') {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = src;
        return;
      }
    } catch (_e) { /* fall through */ }
    resolve(null);
  });
}

/**
 * Rung 2: grayscale + optional re-encode (some text-only models reject color
 * JPEGs with the same error; grayscale shrinks payload ~30%).
 * @returns {Promise<string>} data URL or '' on failure
 */
export async function degradeToGrayscale(base64Image) {
  try {
    const bmp = await loadImage(base64Image);
    if (!bmp) return '';
    const w = bmp.width || 1, h = bmp.height || 1;
    const canvas = makeCanvas(w, h);
    if (!canvas) return '';
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    ctx.filter = 'grayscale(1)';
    ctx.drawImage(bmp, 0, 0);
    return await canvasToJpegUrl(canvas, 0.7);
  } catch (_e) { return ''; }
}

/**
 * Rung 3: tile mode — keep only the top-left quadrant at 0.75 scale.
 * Most agent-relevant chrome (nav, forms, primary CTA) lives top-left;
 * halves pixel count when providers cap resolution.
 * @returns {Promise<string>} data URL or ''
 */
export async function degradeToTile(base64Image) {
  try {
    const bmp = await loadImage(base64Image);
    if (!bmp) return '';
    const w = bmp.width || 1, h = bmp.height || 1;
    const canvas = makeCanvas(Math.max(1, Math.floor(w / 2)), Math.max(1, Math.floor(h / 2)));
    if (!canvas) return '';
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    ctx.drawImage(bmp, 0, 0, Math.floor(w / 2), Math.floor(h / 2), 0, 0, Math.floor(w / 2), Math.floor(h / 2));
    return await canvasToJpegUrl(canvas, 0.7);
  } catch (_e) { return ''; }
}

/**
 * Rung 4: bbox crop — crop to the union of interesting element bboxes
 * (padded 40px), scaled to max 1024px wide. elements = observed elements
 * with { bbox: {x,y,w,h} }.
 * @returns {Promise<string>} data URL or ''
 */
export async function degradeToCrop(base64Image, elements) {
  try {
    if (!Array.isArray(elements) || !elements.length) return '';
    const bmp = await loadImage(base64Image);
    if (!bmp) return '';
    const iw = bmp.width || 1, ih = bmp.height || 1;
    // Union bbox in page coords — screenshots are viewport captures, and
    // element bboxes are page-absolute, so clamp to image size.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const el of elements) {
      const b = el && el.bbox;
      if (!b || typeof b.x !== 'number' || typeof b.y !== 'number') continue;
      const bw = b.w || b.width || 0, bh = b.h || b.height || 0;
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + bw); maxY = Math.max(maxY, b.y + bh);
    }
    if (minX === Infinity) return '';
    const PAD = 40;
    minX = Math.max(0, minX - PAD); minY = Math.max(0, minY - PAD);
    maxX = Math.min(iw, maxX + PAD); maxY = Math.min(ih, maxY + PAD);
    const cw = maxX - minX, ch = maxY - minY;
    if (cw <= 0 || ch <= 0) return '';
    const scale = Math.min(1, 1024 / cw);
    const canvas = makeCanvas(Math.max(1, Math.floor(cw * scale)), Math.max(1, Math.floor(ch * scale)));
    if (!canvas) return '';
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    ctx.drawImage(bmp, minX, minY, cw, ch, 0, 0, canvas.width, canvas.height);
    return await canvasToJpegUrl(canvas, 0.7);
  } catch (_e) { return ''; }
}

/**
 * Build the text preamble sent alongside degraded images so the model knows
 * what it's looking at. Pure; exported for tests.
 * @param {'full'|'grayscale'|'tile'|'crop'|'none'} mode
 * @returns {string}
 */
export function degradationNote(mode) {
  switch (mode) {
    case 'grayscale': return '[Screenshot degraded to grayscale for this model.]';
    case 'tile': return '[Screenshot degraded to top-left quadrant for this model.]';
    case 'crop': return '[Screenshot cropped to the interactive-element region for this model.]';
    case 'none': return '[Screenshot unavailable — working text-only for this model.]';
    default: return '';
  }
}

/**
 * Run one degradation rung. mode -> new (image, mode) or null to skip.
 * @param {'full'|'grayscale'|'tile'|'crop'} mode
 * @param {string} base64Image
 * @param {Array} elements
 * @returns {Promise<{image: string, mode: string}|null>}
 */
export async function nextRung(mode, base64Image, elements) {
  switch (mode) {
    case 'full': {
      const g = await degradeToGrayscale(base64Image);
      return g ? { image: g, mode: 'grayscale' } : null;
    }
    case 'grayscale': {
      const t = await degradeToTile(base64Image);
      return t ? { image: t, mode: 'tile' } : null;
    }
    case 'tile': {
      const c = await degradeToCrop(base64Image, elements);
      return c ? { image: c, mode: 'crop' } : null;
    }
    case 'crop':
    default:
      return null; // ladder exhausted -> caller falls back to text-only
  }
}

/**
 * Decide how to attach vision for a call, honoring learned verdicts.
 * Returns { useVision, image, note }.
 * @param {Object} provider
 * @param {string} model
 * @param {string|null} base64Image
 * @param {Object} [opts] - { storage, elements }
 * @returns {Promise<{useVision: boolean, image: string|null, note: string, mode: string}>}
 */
export async function prepareVision(provider, model, base64Image, opts = {}) {
  const noVision = { useVision: false, image: null, note: degradationNote('none'), mode: 'none' };
  if (!base64Image) return noVision;
  if (!provider || typeof provider.buildVisionContent !== 'function') return noVision;

  // 1) Learned verdict wins.
  const learned = await getLearnedVerdict(provider.id, model, opts.storage);
  if (learned === 'textonly') return noVision;

  // 2) Registry verdict: known-textonly models skip without a wasted call.
  try {
    const { getModelSupportsVision } = await import('./provider-registry.js');
    if (getModelSupportsVision(provider.id, model) === false) return noVision;
  } catch (_e) { /* registry import failed — proceed optimistically */ }

  // 3) Optimistic vision at full quality.
  return { useVision: true, image: base64Image, note: '', mode: 'full' };
}

/**
 * After a 400: walk the ladder. Returns the next attempt config or
 * { giveUp: true } to fall back to text-only (and record the verdict).
 * @param {Object} params - { provider, model, status, bodyText, base64Image, elements, storage }
 * @returns {Promise<{giveUp: boolean, image?: string, mode?: string, note?: string}>}
 */
export async function onVisionRejection(params) {
  const { provider, model, status, bodyText, base64Image, elements, storage } = params;
  if (!isVisionRejection(status, bodyText)) {
    // Not a vision problem — don't learn, don't degrade.
    return { giveUp: false, passthrough: true };
  }
  const mode = params.mode || 'full';
  const next = await nextRung(mode, base64Image, elements);
  if (!next) {
    await recordVerdict(provider && provider.id, model, 'textonly', storage);
    return { giveUp: true };
  }
  return { giveUp: false, image: next.image, mode: next.mode, note: degradationNote(next.mode) };
}

/**
 * After a SUCCESSFUL vision call: record that this model takes images.
 * @param {Object} provider
 * @param {string} model
 * @param {Object} [storage]
 */
export async function onVisionSuccess(provider, model, storage) {
  const prior = await getLearnedVerdict(provider && provider.id, model, storage);
  if (prior === 'vision') return; // already learned — skip per-step storage churn
  await recordVerdict(provider && provider.id, model, 'vision', storage);
}

// Re-export for callers that already import getErrorMessage elsewhere.
export { getErrorMessage };
