// background/skills/selector-miss.js
// Fires when a click/type/hover result is "Element not found" — the LLM's
// chosen selector didn't resolve to anything. Common on SPAs where the DOM
// changes between observation and dispatch.
// Recovery: re-read the page (deterministic). The element list will be
// fresh and the LLM can pick a target that actually exists.

export const selectorMiss = {
  id: 'selector-miss',
  description: 'Recovery when click/type/hover hit a selector that does not resolve',
  priority: 70,

  matches(ctx) {
    if (!ctx || !ctx.lastResult || !ctx.lastActionFailed) return false;
    const r = (typeof ctx.lastResult === 'string' ? ctx.lastResult : String(ctx.lastResult)).toLowerCase();
    return /element not found|no element|not in element list/.test(r) ||
           r.startsWith('error: element');
  },

  autoApply(_ctx) {
    // Deterministic re-observation. The next LLM call gets a fresh elements
    // array; the previous selector's failure is in history so the LLM won't
    // re-emit it.
    return { type: 'read_page', _autoAppliedBy: 'selector-miss' };
  },

  promptInjection(ctx) {
    const lastSel = (typeof ctx.lastCommand === 'object' && ctx.lastCommand !== null && (ctx.lastCommand.selector || ctx.lastCommand.ref)) || '(unknown)';
    return `The selector / ref you used (\`${lastSel}\`) didn't resolve to a visible element. The page may have changed under you (SPA re-renders, lazy-loaded panels, async loading). Strategies, in order:
1. Re-read the page (auto-applied) and pick a NEW target from the fresh element list — do NOT re-emit the same selector.
2. If you see the element you wanted but a different selector, use its \`ref:\` from the observation instead of the old CSS selector — refs survive DOM shuffles.
3. If the element doesn't appear at all, it may need: a scroll to bring it into view, a wait_for_text for a known loading-complete signal, or a click on a parent menu/tab to reveal it.
4. If you're confident the element should exist, try \`execute_js\` with \`document.querySelector('your-pattern')\` to inspect directly — sometimes the DOM has the element but the observer skipped it.`;
  }
};