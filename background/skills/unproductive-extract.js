// background/skills/unproductive-extract.js
// Fires when extract / extract_list / execute_js with a key returns empty,
// null, or an error string. The v3.13.0 retry ladder already handles the
// execute_js side; this skill adds a directive layer for extract/extract_list
// so the LLM stops re-trying the same selector pattern.

const UNPRODUCTIVE_PATTERNS = [
  /JS returned an empty array/i,
  /JS returned an empty object/i,
  /JS returned null/i,
  /JS returned a non-serializable value/i,
  /memory hygiene/i,
  /rejected: value too short/i,
  /rejected: duplicates existing key/i,
];

export const unproductiveExtract = {
  id: 'unproductive-extract',
  description: 'Recovery when extract / execute_js returns empty / null / unparseable data',
  priority: 60,

  matches(ctx) {
    if (!ctx || !ctx.lastResult || !ctx.lastCommand) return false;
    const t = ctx.lastCommand.type;
    if (t !== 'extract' && t !== 'extract_list' && t !== 'execute_js') return false;
    const r = typeof ctx.lastResult === 'string' ? ctx.lastResult : String(ctx.lastResult);
    return Array.isArray(UNPRODUCTIVE_PATTERNS) && UNPRODUCTIVE_PATTERNS.some(re => re.test(r));
  },

  autoApply(_ctx) {
    // Not deterministic — the LLM needs to choose between regex on body text,
    // network-request inspection, or fall-through to read_page. Let the
    // promptInjection guide it.
    return null;
  },

  promptInjection(ctx) {
    const lastKey = (ctx.lastCommand && ctx.lastCommand.key) || '(unknown)';
    return `Your extraction returned no useful data (empty / null / non-serializable). Do NOT retry the same approach. Pick a different strategy:

1. **Body-text regex** — when the data is text on the page but in a structure the selector missed:
   \`{type:'execute_js', key:'${lastKey}', code:'const t=document.body.innerText; const m=t.match(/<your-pattern>/); return m?m[1]:null;'}\`

2. **Underlying API capture** — when the page renders data from XHR/fetch:
   \`{type:'read_network_requests', url_includes:'<api-host-substring>', filter:'json', limit:30}\`
   Then parse the JSON response in a follow-up execute_js.

3. **Visible-text harvest** — when the page is an SPA and querySelector returns nothing:
   \`{type:'execute_js', key:'${lastKey}', code:'return Array.from(document.querySelectorAll("h1,h2,h3,p,td,li,a")).map(e=>e.innerText.trim()).filter(t=>t.length>5).slice(0,40).join("\\n")'}\`

4. **Honest fall-through** — if the data simply isn't available, record a note: \`{type:'note', text:'[MISSING DATA — could not extract X via DOM/network]'}\` and move on. Don't burn 5 more steps on a hopeless extraction.`;
  }
};