// background/skills/navigate-loop.js
import { getErrorMessage } from '../error-utils.js';

// Precompile regex for blocked navigation detection (hot path in skill matching)
const BLOCKED_NAVIGATE_RE = /^BLOCKED:\s*already navigated to/i;

// Fires after the v3.20.1 navigate-loop guard catches 2+ navigates to the
// same URL. The agent is re-navigating instead of interacting with the page.
// Recovery: read the current page (deterministic) so the LLM sees what's
// actually on screen and can pick an in-page interaction.

export const navigateLoop = {
  id: 'navigate-loop',
  description: 'Recovery when agent navigates to the same URL twice (loop)',
  priority: 85,

  matches(ctx) {
    try {
      if (!ctx || !ctx.lastResult || !ctx.lastActionFailed) return false;
      const resultString = ctx.lastResult;
      if (typeof resultString !== 'string') return false;
      return BLOCKED_NAVIGATE_RE.test(resultString);
    } catch (error) {
      console.error('Error in navigateLoop matches:', getErrorMessage(error));
      return false;
    }
  },

  autoApply(ctx) {
    if (!ctx) return null;
    return { type: 'read_page', _autoAppliedBy: 'navigate-loop' };
  },

  promptInjection(ctx) {
    if (!ctx) return '';
    return `You navigated to the same URL twice in a row. The page is already loaded — do NOT navigate to it again. Instead:
1. Read the page (auto-applied this step) and look at the elements list.
2. If the page is an SPA, the menu you want may already be clickable in-page (look for nav links, sidebars, tabs).
3. If the page lacks what you need, try \`execute_js\` with a key to inspect the DOM structure: \`{type:'execute_js', key:'page_struct', code:'return document.querySelectorAll("nav, aside, [role=navigation]").length'}\`.
4. If the goal expects content that isn't here, the URL might be wrong — fall through to \`note\` recording what IS here, then \`finish\` honestly with "[MISSING DATA — page does not contain expected X]".`;
  }
};