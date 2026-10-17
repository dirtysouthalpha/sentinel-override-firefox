// background/skills/csp-blocked.js
import { getErrorMessage } from '../error-utils.js';
// Fires when an execute_js attempt was blocked by the page's Content-
// Security-Policy. The content-script path uses inline <script> injection,
// which strict-CSP sites (SentinelOne, GitHub, banks, etc.) deny. The
// content script returns "CSP_BLOCKED: page denies inline scripts..." so we
// can pattern-match it here and steer the agent to alternative actions.
//
// CDP Runtime.evaluate normally bypasses page CSP, but if the user has
// dismissed the debugger banner mid-run, the agent falls back to the
// content-script path. This skill catches that scenario.

export const cspBlocked = {
  id: 'csp-blocked',
  description: 'Recovery when execute_js is denied by the page Content-Security-Policy',
  priority: 95,

  matches(ctx) {
    try {
      if (!ctx || !ctx.lastResult) return false;
      return typeof ctx.lastResult === 'string' && /^CSP_BLOCKED:/i.test(ctx.lastResult);
    } catch (error) {
      console.error('Error in cspBlocked matches:', getErrorMessage(error));
      return false;
    }
  },

  // Deterministic recovery: read the page so the agent sees what's actually
  // rendered without needing to inject JS. The next LLM call can then pick
  // a CSP-friendly action (extract, extract_list, read_network_requests).
  autoApply(_ctx) {
    return { type: 'read_page', _autoAppliedBy: 'csp-blocked' };
  },

  promptInjection(ctx) {
    try {
      const lastKey = (ctx.lastCommand?.key) || '(no key)';

      return `Your previous execute_js was blocked by the page's Content-Security-Policy (script-src directive). The page does not allow inline scripts — DO NOT retry execute_js on this page in this manner. Available alternatives:

1. **read_page** — auto-applied this step. Use the next observation's element list + page text to pick a target.

2. **extract / extract_list** — pull text or attributes from already-observed elements:
   \`{type:'extract', selector:'<from-element-list>', key:'${lastKey}', attribute:'text'}\`
   or for multiple rows:
   \`{type:'extract_list', selector:'<row-selector>', key:'${lastKey}', fields:{title:'a',url:'a@href'}, limit:20}\`

3. **read_network_requests** — if the data is in an XHR/fetch the page already made, capture the JSON directly:
   \`{type:'read_network_requests', url_includes:'<api-host-substring>', filter:'json', limit:30}\`

4. **read_console_messages** — if the page logs JSON/diagnostic data to console:
   \`{type:'read_console_messages', filter:'<keyword>', limit:50}\`

5. **CDP path** — if you have a debugger banner showing, CDP Runtime.evaluate bypasses CSP automatically. If the banner was dismissed, ask the user to re-enable trusted-input in Settings, or proceed with the alternatives above.

DO NOT re-emit execute_js with similar code expecting different behavior — the CSP blocks the entire path, not just specific patterns.`;
    } catch (error) {
      console.error('Error in cspBlocked promptInjection:', getErrorMessage(error));
      return `Your previous execute_js was blocked by the page's Content-Security-Policy. Available alternatives: read_page, extract, extract_list, read_network_requests, read_console_messages, or CDP path. DO NOT retry execute_js.`;
    }
  }
};