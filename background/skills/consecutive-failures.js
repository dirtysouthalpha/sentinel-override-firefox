// background/skills/consecutive-failures.js
// Fires when the agent has failed 3+ steps in a row regardless of cause.
// Different from per-failure-type skills above — this catches the general
// case where the agent is stuck in some pattern not explicitly named.
// Recovery: tell the LLM to STEP BACK, reconsider the goal, and either
// pick a fundamentally different approach OR finish honestly with what's known.

import { getErrorMessage } from '../error-utils.js';

const MIN_CONSECUTIVE_FAILURES = 3;
const DEFAULT_MAX_STEPS = 100;

export const consecutiveFailures = {
  id: 'consecutive-failures',
  description: 'Recovery when 3+ consecutive failures regardless of type — force strategy shift',
  priority: 40,

  matches(ctx) {
    try {
      if (!ctx) return false;
      const failureCount = ctx.consecutiveFailures || 0;
      return failureCount >= MIN_CONSECUTIVE_FAILURES;
    } catch (error) {
      console.error('Error in consecutiveFailures.matches:', getErrorMessage(error));
      return false;
    }
  },

  autoApply(_ctx) {
    // Don't auto-apply at 3 failures — give the LLM one more chance with
    // the directive. If failures keep climbing past 5, the existing stall
    // detector takes over with RESCAN_AND_REPLAN.
    return null;
  },

  promptInjection(ctx) {
    try {
      const failureCount = ctx.consecutiveFailures || 0;
      const maxSteps = (typeof ctx.dynamicMaxSteps === 'number' ? ctx.dynamicMaxSteps : DEFAULT_MAX_STEPS);
      const currentStep = ctx.stepCount || 0;
      const stepsRemaining = Math.max(0, maxSteps - currentStep);

      return `You have failed ${failureCount} consecutive steps. The pattern you're trying is not working. STOP and pick a fundamentally different approach:

1. **Step back from the page.** Use \`execute_js\` to inspect the page structure: \`{type:'execute_js', key:'page_struct', code:'return Array.from(document.querySelectorAll("main, [role=main], section, article, [class*=container]")).map(e=>({tag:e.tagName, cls:e.className.substring(0,80), text:e.innerText.substring(0,100)})).slice(0,15)'}\` — this gives you a structural map you can reason over.

2. **Check the network.** The data you want may be in an API response, not the DOM: \`{type:'read_network_requests', limit:30, filter:'json'}\`.

3. **Re-read the goal.** Is there a part you've been ignoring? Are you on the right URL for this step?

4. **Finish honestly.** You have ${stepsRemaining} steps remaining. If the remaining budget can't realistically complete the goal, call \`finish\` with what you've collected and clear "[MISSING DATA — X]" markers for the gaps. Better to ship a partial honest report than burn the budget flailing.

Do NOT repeat the action that just failed. The user can see the failure pattern in the activity stream and will judge progress by your next move.`;
    } catch (error) {
      console.error('Error in consecutiveFailures.promptInjection:', getErrorMessage(error));
      return 'Error generating prompt for consecutive failures recovery.';
    }
  }
};