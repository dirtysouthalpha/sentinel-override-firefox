// Sentinel Override v20.1 — Semantic Find (Claude-in-Chrome parity upgrade)
//
// A `find` tool for the agent loop: the LLM asks for "the checkout button" /
// "the email input" in natural language and gets back matching elements with
// refs, instead of burning context scanning the full element list.
//
// Match pipeline (cheapest first, semantic escalation last):
//   1. Heuristic scan — text/ariaLabel/placeholder/title/selector substring
//      match over the current observation. Free. Handles most asks.
//   2. Synonym expansion — role synonym table (submit→button, email→textbox…)
//      rescored against the same elements. Free.
//   3. Nested-LLM disambiguation (opt-in) — when heuristics return nothing or
//      are ambiguous, ask the active provider's small/fast model to pick the
//      best ref from the candidate list. One cheap call, capped, cached per
//      (query, url).
//
// Everything here is pure/classified so tests run without a browser.

// ---------- Heuristic scoring ----------

const ROLE_SYNONYMS = new Map(Object.entries({
  button: ['button', 'submit', 'btn', 'cta', 'action'],
  link: ['link', 'anchor', 'url'],
  textbox: ['textbox', 'input', 'field', 'text field', 'entry', 'search box', 'searchbox'],
  email: ['email', 'e-mail', 'mail'],
  password: ['password', 'pass', 'pwd'],
  checkbox: ['checkbox', 'check', 'tick', 'toggle'],
  radio: ['radio', 'option button'],
  dropdown: ['dropdown', 'select', 'combobox', 'list box', 'listbox'],
  tab: ['tab'],
  menu: ['menu', 'menuitem', 'menu item'],
  search: ['search', 'search box', 'searchbox', 'query'],
  file: ['file', 'upload', 'file input'],
  slider: ['slider', 'range'],
  switch: ['switch', 'toggle switch'],
}));

const TAG_ROLES = new Map(Object.entries({
  BUTTON: 'button',
  A: 'link',
  INPUT: 'textbox',
  TEXTAREA: 'textbox',
  SELECT: 'dropdown',
  SUMMARY: 'button',
  LABEL: 'label',
}));

/**
 * Normalize a natural-language query to lowercase tokens (no punctuation).
 * @param {string} q
 * @returns {string}
 */
export function normalizeQuery(q) {
  return String(q || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Detect (roleToken, labelTokens) from a query like "the submit button".
 * Returns { role: string|null, label: string } — label is the remaining text.
 * @param {string} query
 * @returns {{role: string|null, label: string}}
 */
export function parseQuery(query) {
  const norm = normalizeQuery(query);
  if (!norm) return { role: null, label: '' };
  const words = norm.split(' ');
  let role = null;
  let roleIdx = -1;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    for (const [roleName, syns] of ROLE_SYNONYMS) {
      if (syns.includes(w)) { role = roleName; roleIdx = i; break; }
    }
    if (role) break;
  }
  // Drop the role word (and a preceding article) from the label.
  let labelWords = words.slice(0, roleIdx).concat(words.slice(roleIdx + 1));
  labelWords = labelWords.filter(w => !['the', 'a', 'an', 'for', 'of'].includes(w));
  const label = labelWords.join(' ').trim();
  return { role, label };
}

/**
 * Score one element against a parsed query. Higher is better; 0 = no match.
 * @param {Object} el - observed element ({ text, ariaLabel, selector, tag, role, type, placeholder, elementId, ref })
 * @param {{role: string|null, label: string}} parsed
 * @returns {number}
 */
export function scoreElement(el, parsed) {
  if (!el || !parsed) return 0;
  let score = 0;
  const text = String(el.text || el.textContent || '').toLowerCase();
  const aria = String(el.ariaLabel || el['aria-label'] || '').toLowerCase();
  const placeholder = String(el.placeholder || '').toLowerCase();
  const title = String(el.title || '').toLowerCase();
  const selector = String(el.selector || '').toLowerCase();
  const id = String(el.elementId || el.id || '').toLowerCase();
  const elRole = String(el.role === 'none' ? '' : (el.role || '')).toLowerCase();
  const elTag = String(el.tag || '').toUpperCase();
  const elType = String(el.type === 'none' ? '' : (el.type || '')).toLowerCase();

  // ---- Role component (0–3) ----
  let roleHit = false;
  if (parsed.role) {
    const syns = ROLE_SYNONYMS.get(parsed.role) || [parsed.role];
    const roleFields = [elRole, elType, TAG_ROLES.get(elTag) || ''];
    for (const rf of roleFields) {
      if (!rf) continue;
      if (syns.includes(rf)) { score += 3; roleHit = true; break; }
      // Partial: "email input" vs type=text box — the synonym table maps
      // email→mail; a type=email input gets a direct boost below.
      if (rf.includes(rf) && syns.some(s => rf.includes(s) || s.includes(rf))) {
        // loose match only when nothing better exists
        score += 1; roleHit = true; break;
      }
    }
    if (elType === parsed.role) { score += 2; roleHit = true; } // type=email/password/checkbox
    if (!roleHit) score -= 1; // wrong-role elements are demoted, not excluded
  }

  // ---- Label component (0–5) ----
  const label = parsed.label;
  if (label) {
    const fields = [text, aria, placeholder, title, id, selector];
    for (const f of fields) {
      if (!f) continue;
      if (f === label) { score += 5; break; }          // exact
      if (f.includes(label)) { score += 4; break; }     // substring
    }
    // Token overlap (order-free) as a weak signal, additive not break-once:
    const tokens = label.split(' ').filter(t => t.length > 2);
    if (tokens.length) {
      let hits = 0;
      for (const t of tokens) {
        if (text.includes(t) || aria.includes(t) || placeholder.includes(t) || id.includes(t)) { hits++; }
      }
      if (hits) score += Math.min(2, hits * 0.5);
    }
  } else if (!parsed.role) {
    // Neither role nor label — meaningless query.
    return 0;
  }

  return score;
}

/**
 * Heuristic find: score every element, return the list sorted best-first.
 * @param {Array} elements - observed elements from observe_page
 * @param {string} query - natural-language description
 * @param {number} [limit=5] - max results
 * @returns {Array<{el: Object, score: number}>}
 */
export function heuristicFind(elements, query, limit = 5) {
  if (!Array.isArray(elements) || !elements.length || !query) return [];
  const parsed = parseQuery(query);
  const scored = [];
  for (const el of elements) {
    const s = scoreElement(el, parsed);
    if (s > 0) scored.push({ el, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ---------- Nested-LLM disambiguation ----------

const _llmCache = new Map(); // "url::query" -> ref or null
const LLM_CACHE_MAX = 64;

/**
 * Build the compact prompt for the nested LLM. Pure function; exported for tests.
 * @param {string} query
 * @param {Array<{ref:string, desc:string}>} candidates
 * @returns {string}
 */
export function buildFindPrompt(query, candidates) {
  const lines = candidates.map(c => `${c.ref}: ${c.desc.substring(0, 80)}`);
  return [
    'You are a disambiguation helper for a browser automation agent.',
    `The agent is looking for: "${query}"`,
    'Candidate elements:',
    ...lines,
    '',
    'Reply with ONLY the ref of the best matching candidate (e.g. ref_7).',
    'If none match, reply NONE.'
  ].join('\n');
}

/**
 * Parse the nested LLM's reply. Pure; exported for tests.
 * @param {string} reply
 * @returns {string|null} ref like "ref_7", or null
 */
export function parseFindReply(reply) {
  const m = String(reply || '').match(/ref_\d+/i);
  return m ? m[0].toLowerCase() : null;
}

/**
 * Nested-LLM disambiguation. Returns a ref or null. Never throws.
 * @param {string} query
 * @param {Array<Object>} elements - observed elements
 * @param {Object} deps - { callLLM: async (prompt) => string } injected for tests
 * @param {string} [pageUrl=''] - cache key component
 * @returns {Promise<string|null>}
 */
export async function llmFind(query, elements, deps, pageUrl = '') {
  if (!deps || typeof deps.callLLM !== 'function' || !Array.isArray(elements) || !elements.length) return null;
  const cacheKey = `${pageUrl}::${normalizeQuery(query)}`;
  if (_llmCache.has(cacheKey)) return _llmCache.get(cacheKey);

  const candidates = elements.slice(0, 40).map((el, i) => ({
    ref: el.ref || `ref_${i + 1}`,
    desc: [el.tag, el.role !== 'none' ? el.role : '', el.text || el.ariaLabel || el.placeholder || ''].filter(Boolean).join(' | ')
  }));
  const prompt = buildFindPrompt(query, candidates);
  let ref = null;
  try {
    const reply = await Promise.race([
      deps.callLLM(prompt),
      new Promise((_, rej) => setTimeout(() => rej(new Error('find-llm timeout')), 8000))
    ]);
    ref = parseFindReply(reply);
    if (ref && !candidates.some(c => c.ref === ref)) ref = null; // hallucination guard
  } catch (_e) {
    ref = null; // nested LLM is best-effort; heuristics already ran
  }
  // Cache even nulls (negative cache) so repeated misses don't re-spend tokens.
  if (_llmCache.size >= LLM_CACHE_MAX) {
    const firstKey = _llmCache.keys().next().value;
    if (firstKey !== undefined) _llmCache.delete(firstKey);
  }
  _llmCache.set(cacheKey, ref);
  return ref;
}

/**
 * Full semantic find: heuristics first, nested LLM only when needed.
 * @param {Array} elements - observed elements
 * @param {string} query
 * @param {Object} [opts] - { llm: {callLLM}, pageUrl, limit }
 * @returns {Promise<{results: Array<{el:Object, score:number}>, usedLLM: boolean, llmRef: string|null}>}
 */
export async function semanticFind(elements, query, opts = {}) {
  const limit = opts.limit || 5;
  let results = heuristicFind(elements, query, limit);
  let usedLLM = false;
  let llmRef = null;

  const ambiguous = results.length > 1 && results[0].score - results[1].score < 2;
  if ((!results.length || ambiguous) && opts.llm && typeof opts.llm.callLLM === 'function') {
    llmRef = await llmFind(query, elements, opts.llm, opts.pageUrl || '');
    if (llmRef) {
      usedLLM = true;
      const match = elements.find(el => el.ref === llmRef);
      if (match) results = [{ el: match, score: 10 }];
    }
  }
  return { results, usedLLM, llmRef };
}
