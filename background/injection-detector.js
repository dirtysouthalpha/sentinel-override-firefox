// Sentinel Override v3 — Ingest-time prompt-injection detector (roadmap 2.3).
//
// Page-derived text is untrusted. It reaches the model inside
// <UNTRUSTED_PAGE_CONTENT> (llm-client.js), which tells the model to treat it
// as data — but the tag is only a request. This module is the mechanical half:
// it scans text at the moment it is ingested, elides instruction-shaped spans,
// and reports what it found so the run can surface it.
//
// Deliberately flag-and-mark rather than block. Blocking page text would
// strand legitimate reading: an extraction task on a page that happens to
// quote "ignore previous instructions" (a tutorial about prompt injection, a
// security write-up) would otherwise never complete. Eliding the matched span
// removes the directive while preserving the surrounding content.
//
// False-positive discipline matters more than recall here. Every pattern below
// must be instruction-shaped — an imperative directed at the reader — rather
// than a topic mention. `docs/AUDIT_2026-05-06.md` prescribed exactly this
// check ("ignore previous|disregard prior|admin override|new instructions:")
// and it was never implemented; this is that check, widened.

// ──────────────────────────────────────────────────────────────
// Patterns
// ──────────────────────────────────────────────────────────────
// `re` is applied with the `g` flag so repeated directives in one page are all
// reported; `index`/`length` come from the match so the span can be elided.

const INJECTION_PATTERNS = [
  // ── Override of prior instructions ──
  {
    id: 'ignore-previous',
    label: 'override of prior instructions',
    severity: 'high',
    re: /\b(?:ignore|disregard|forget|override|discard|disobey)\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|preceding|original|initial|foregoing)\s+(?:instructions?|prompts?|directions?|rules?|commands?|context|guidelines?|messages?|directives?)\b/gi,
  },
  {
    id: 'ignore-safety',
    label: 'override of safety rules',
    severity: 'high',
    re: /\b(?:ignore|disregard|forget|override|bypass|disable|turn\s+off)\s+(?:all\s+|any\s+|the\s+)?(?:safety|security|policy|policies|guardrails?|filters?|restrictions?|constraints?|limits?)\b/gi,
  },
  {
    id: 'forget-everything',
    label: 'discard-all directive',
    severity: 'high',
    re: /\bforget\s+(?:everything|all|all\s+of\s+it)\s+(?:you\s+(?:were|have\s+been)\s+(?:told|given|instructed)|above|previously|before)\b/gi,
  },
  {
    id: 'priority-override',
    label: 'precedence claim over system prompt',
    severity: 'high',
    re: /\b(?:this|the\s+following|below)\s+(?:instruction|prompt|message|directive|text)s?\s+(?:take|has|takes)\s+(?:precedence|priority)\s+over\b/gi,
  },

  // ── Fake protocol / role framing ──
  {
    id: 'fake-system-line',
    label: 'forged system/assistant line',
    severity: 'high',
    re: /^[ \t]*(?:system|assistant|developer|administrator)[ \t]*(?::|])[ \t]*\S/gim,
  },
  {
    id: 'fake-role-close-tag',
    label: 'forged role close tag',
    severity: 'high',
    re: /<\s*\/\s*(?:system|assistant|user|developer)\s*>/gi,
  },
  {
    id: 'new-instructions',
    label: 'new-instructions header',
    severity: 'high',
    re: /\b(?:new|updated|revised|additional|amended)\s+(?:instructions?|prompts?|commands?|rules?|directions?|directives?)\s*(?::|])/gi,
  },
  {
    id: 'fake-system-message',
    label: 'forged system message',
    severity: 'medium',
    re: /\b(?:system|administrator|developer|root|admin)\s+(?:message|notice|alert|directive)\s*(?::|])/gi,
  },

  // ── Concealment from the operator ──
  {
    id: 'conceal-from-user',
    label: 'instruction to conceal from the user',
    severity: 'high',
    re: /\b(?:do\s+not|don'?t|never|without)\s+(?:tell|inform|mention|reveal|notify|disclose|report)\s+(?:the\s+|this\s+to\s+the\s+)?(?:user|me|anyone|anybody|human|operator)\b/gi,
  },
  {
    id: 'hide-this',
    label: 'instruction to hide this text',
    severity: 'high',
    re: /\b(?:hide|conceal|suppress|omit)\s+(?:this|the\s+above|all\s+of\s+this)\s+(?:from|to)\s+(?:the\s+)?(?:user|human|operator|output|response)\b/gi,
  },

  // ── Extraction / exfiltration ──
  // Requires an explicit determiner ("your", "the", "all"). Without it,
  // "Show instructions for the recipe" -- ordinary web copy -- matches, and
  // every recipe page the agent reads would be mangled.
  {
    id: 'reveal-prompt',
    label: 'request to reveal the system prompt',
    severity: 'high',
    re: /\b(?:reveal|repeat|print|output|show|display|leak|dump|expose)\s+(?:me\s+)?(?:your|the|all|those|these)\s+(?:(?:system|initial|original|full|complete|own)\s+)*(?:prompt|instructions?|rules?|directives?|guidelines?)\b/gi,
  },
  {
    id: 'exfiltrate-to-remote',
    label: 'instruction to exfiltrate data',
    severity: 'high',
    // The payload noun is repeatable: "conversation history" is two words, and a
    // single optional word silently dropped the most common phrasing.
    re: /\b(?:send|email|post|upload|exfiltrate|leak|transmit)\s+(?:(?:this|the|all|your)\s+)?(?:(?:conversation|transcript|history|instructions?|prompts?|data|content)\s+){0,4}(?:to|at)\s+(?:the\s+)?(?:url|http|https|api|endpoint|webhook|server|address)\b/gi,
  },

  // ── Jailbreak mode framing ──
  {
    id: 'jailbreak-mode',
    label: 'jailbreak mode activation',
    severity: 'medium',
    re: /\b(?:enter|enable|activate|switch\s+to|jailbreak|bypass|initiate)\s+(?:developer|admin|god|debug|unrestricted|unfiltered|unlimited|root)\s+mode\b/gi,
  },
  {
    id: 'developer-mode-on',
    label: 'developer mode claim',
    severity: 'medium',
    re: /\bdeveloper\s+mode\s+(?:is\s+)?(?:enabled|activated|engaged|on|active)\b/gi,
  },
  {
    id: 'no-restrictions-roleplay',
    label: 'no-restrictions roleplay',
    severity: 'medium',
    re: /\bact\s+as\s+(?:if\s+you\s+(?:have\s+no|do\s+not\s+have|are\s+not\s+bound\s+by))\s+(?:restrictions?|rules?|guidelines?|filters?|limits?|safety|policy|policies)\b/gi,
  },
  {
    id: 'no-longer-bound',
    label: 'claim that rules no longer apply',
    severity: 'medium',
    re: /\byou\s+are\s+now\s+(?:no\s+longer|not)\s+(?:bound|required|allowed)\s+to\s+(?:follow|obey|comply\s+with|adhere\s+to)\b/gi,
  },
];

// ──────────────────────────────────────────────────────────────
// Scan
// ──────────────────────────────────────────────────────────────

// Page text can be large. The scan is a security control, not a parser, so it
// caps its work rather than reading an unbounded string on every step.
const MAX_SCAN_CHARS = 200000;
const MAX_HITS_PER_SCAN = 50;

const ELISION_MARKER = '[injection directive elided]';

function _severityRank(severity) {
  return severity === 'high' ? 2 : severity === 'medium' ? 1 : 0;
}

/**
 * Scan untrusted text for instruction-shaped spans.
 *
 * Returns a plain object so it can be asserted on directly and serialized into
 * telemetry without dragging DOM or extension types along.
 *
 * @param {string} text - Untrusted, page-derived text.
 * @param {Object} [options]
 * @param {number} [options.maxChars=MAX_SCAN_CHARS] - Cap on how much text is scanned.
 * @param {number} [options.maxHits=MAX_HITS_PER_SCAN] - Cap on reported hits.
 * @returns {{flagged: boolean, hits: Array<Object>, cleaned: string, scannedLength: number, truncated: boolean}}
 */
function scanForInjection(text, options = {}) {
  const empty = {
    flagged: false,
    hits: [],
    cleaned: '',
    scannedLength: 0,
    truncated: false,
  };
  if (typeof text !== 'string' || text.length === 0) return empty;

  const maxChars = Number.isFinite(options.maxChars) && options.maxChars > 0
    ? Math.floor(options.maxChars)
    : MAX_SCAN_CHARS;
  const maxHits = Number.isFinite(options.maxHits) && options.maxHits > 0
    ? Math.floor(options.maxHits)
    : MAX_HITS_PER_SCAN;

  const truncated = text.length > maxChars;
  const scanned = truncated ? text.slice(0, maxChars) : text;

  const hits = [];
  for (const pattern of INJECTION_PATTERNS) {
    // A regex literal with /g is stateful across .exec calls (lastIndex). Reset
    // it per scan so repeated calls on the same module-level pattern stay pure.
    pattern.re.lastIndex = 0;
    let match;
    while ((match = pattern.re.exec(scanned)) !== null) {
      hits.push({
        id: pattern.id,
        label: pattern.label,
        severity: pattern.severity,
        index: match.index,
        length: match[0].length,
        match: match[0],
      });
      if (hits.length >= maxHits) break;
      // Zero-width guard: a pattern that can match the empty string would spin here.
      if (match[0].length === 0) {
        pattern.re.lastIndex += 1;
      }
    }
    if (hits.length >= maxHits) break;
  }

  // Overlapping spans: keep the higher-severity one, then the longer one. Without
  // this a single "ignore previous instructions" can be reported by two patterns
  // and eliding the first shifts the second's index.
  hits.sort((a, b) => a.index - b.index || b.length - a.length);
  const deduped = [];
  let coveredUntil = -1;
  for (const hit of hits) {
    if (hit.index < coveredUntil) continue;
    deduped.push(hit);
    coveredUntil = hit.index + hit.length;
  }

  deduped.sort((a, b) => _severityRank(b.severity) - _severityRank(a.severity));

  return {
    flagged: deduped.length > 0,
    hits: deduped,
    cleaned: deduped.length > 0 ? _elideSpans(scanned, deduped) : scanned,
    scannedLength: scanned.length,
    truncated,
  };
}

/**
 * Replace each flagged span with a marker. Spans are applied back-to-front so
 * earlier offsets stay valid as later ones are spliced out.
 *
 * @param {string} text
 * @param {Array<{index: number, length: number}>} spans
 * @returns {string}
 */
function _elideSpans(text, spans) {
  const ordered = [...spans].sort((a, b) => b.index - a.index);
  let out = text;
  for (const span of ordered) {
    if (!Number.isFinite(span.index) || !Number.isFinite(span.length)) continue;
    if (span.index < 0 || span.index + span.length > out.length) continue;
    out = out.slice(0, span.index) + ELISION_MARKER + out.slice(span.index + span.length);
  }
  return out;
}

/**
 * One-line human/LLM-readable summary of what was found. Used in the prompt
 * warning and in telemetry, so it must stay a single line and must not echo the
 * matched text (re-echoing the directive is the thing we are defending against).
 *
 * @param {Array<Object>} hits
 * @returns {string}
 */
function describeInjectionFindings(hits) {
  if (!Array.isArray(hits) || hits.length === 0) return '';
  const counts = Object.create(null);
  for (const hit of hits) {
    if (!hit || typeof hit.label !== 'string') continue;
    counts[hit.label] = (counts[hit.label] || 0) + 1;
  }
  const parts = Object.keys(counts).map((label) => (counts[label] > 1 ? `${label} (x${counts[label]})` : label));
  return parts.join('; ');
}

// ──────────────────────────────────────────────────────────────
// Exports
// ──────────────────────────────────────────────────────────────
export {
  scanForInjection,
  describeInjectionFindings,
  INJECTION_PATTERNS,
  ELISION_MARKER,
  MAX_SCAN_CHARS,
  // Internal helpers exported for test coverage
  _elideSpans,
  _severityRank,
};
