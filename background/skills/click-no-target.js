// background/skills/click-no-target.js
import { getErrorMessage } from '../error-utils.js';
// Fires after the v3.20.1 no-target guard catches a click/type/hover with
// no selector + no ref + no x/y. The LLM emitted an action it can't execute.
// Recovery: force a read_page (deterministic) so the next LLM call gets a
// fresh observation with real selectors to choose from.

export const clickNoTarget = {
  id: 'click-no-target',
  description: 'Recovery when click/type/hover has no target (no selector, no ref, no coords)',
  priority: 90,

  matches(ctx) {
    try {
      if (!ctx || !ctx.lastResult || !ctx.lastCommand) return false;
      if (!ctx.lastActionFailed) return false;
      const resultString = typeof ctx.lastResult === 'string' ? ctx.lastResult : '';
      return /^BLOCKED:\s*\w+\s+command has no target/i.test(resultString);
    } catch (error) {
      console.error('Error in clickNoTarget matches:', getErrorMessage(error));
      return false;
    }
  },

  // Deterministic recovery: re-read the page so the LLM gets fresh element
  // refs/selectors on its next decision. Skips an LLM round-trip entirely.
  autoApply(_ctx) {
    return { type: 'read_page', _autoAppliedBy: 'click-no-target' };
  },

  promptInjection(ctx) {
    try {
      const commandType = ctx.lastCommand?.type || 'click';
      return `Your previous ${commandType} command had no resolvable target — no selector, no ref, no coordinates. The element list in your next observation will be re-scanned. Choose a target from the observed elements list, using either:
- A "ref" id from the observation (preferred — survives DOM shuffles)
- A specific CSS selector that matches one element
- Coordinates from the screenshot ONLY for click_at on visually-targeted elements

Do NOT re-emit a command with the same missing target.`;
    } catch (error) {
      console.error('Error in clickNoTarget promptInjection:', getErrorMessage(error));
      return 'Your previous command had no resolvable target. The element list in your next observation will be re-scanned. Choose a target from the observed elements list.';
    }
  }
};