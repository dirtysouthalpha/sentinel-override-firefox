// background/dom-tools.js — Free pre-LLM DOM query tools
// Zero token cost for simple DOM queries (browser-use pattern)

export function buildSearchPageJs(query, contextChars = 80) {
  return `(function() {
    const q = ${JSON.stringify(query.toLowerCase())};
    const body = document.body.innerText || '';
    const idx = body.toLowerCase().indexOf(q);
    if (idx === -1) return JSON.stringify({ found: false, query: ${JSON.stringify(query)} });
    const start = Math.max(0, idx - ${contextChars});
    const end = Math.min(body.length, idx + q.length + ${contextChars});
    return JSON.stringify({ found: true, context: body.substring(start, end).replace(/\\s+/g, ' ').trim(), position: idx, totalLength: body.length });
  })()`;
}

export function buildFindElementsJs(selector) {
  return `(function() {
    const els = document.querySelectorAll(${JSON.stringify(selector)});
    const results = [];
    for (let i = 0; i < Math.min(els.length, 50); i++) {
      const el = els[i]; const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      results.push({ index: i, tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || '').substring(60), rect: { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) } });
    }
    return JSON.stringify({ count: results.length, elements: results });
  })()`;
}

export function buildGetPageStructureJs() {
  return `(function() {
    const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map(h => ({ level: parseInt(h.tagName[1]), text: (h.innerText || '').substring(80).trim() })).filter(h => h.text);
    return JSON.stringify({ title: document.title, url: location.href, headings: headings.slice(0, 30) });
  })()`;
}

export function buildGetFormFieldsJs() {
  return `(function() {
    const fields = [];
    const inputs = document.querySelectorAll('input, textarea, select');
    for (let i = 0; i < Math.min(inputs.length, 30); i++) {
      const el = inputs[i]; const r = el.getBoundingClientRect();
      fields.push({ index: i, tag: el.tagName.toLowerCase(), type: el.type || '', name: el.name || '', label: (el.placeholder || el.getAttribute('aria-label') || '').substring(60), rect: { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) } });
    }
    return JSON.stringify({ count: fields.length, fields });
  })()`;
}

export function buildGetTextContentJs(selector) {
  return `(function() {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return JSON.stringify({ found: false });
    return JSON.stringify({ found: true, text: (el.innerText || '').substring(2000).trim() });
  })()`;
}
