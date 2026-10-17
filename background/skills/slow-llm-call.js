// background/skills/slow-llm-call.js
import { getErrorMessage } from '../error-utils.js';
// Fires when the most recent LLM call took > 25 seconds. Almost always
// means token bloat or provider slowness. Recovery is observability-focused:
// the engine has already capped per-step history result fields at 800 chars
// (v3.20.0), so the bloat is likely from the action.code or page content.
// This skill DOESN'T auto-apply — it nudges the LLM to emit a more focused
// next action (extract a specific key instead of dumping body text).

export const slowLlmCall = {
  id: 'slow-llm-call',
  description: 'Observability hint when the LLM is slow — likely prompt bloat',
  priority: 20,

  matches(ctx) {
    if (!ctx) {
      console.error('Invalid context in slowLlmCall matches');
      return false;
    }
    if (typeof ctx.lastAiCallMs !== 'number') {
      return false;
    }
    return ctx.lastAiCallMs >= 25000;
  },

  autoApply(_ctx) { 
    return null; 
  },

  promptInjection(ctx) {
    try {
      const sec = typeof ctx.lastAiCallMs === 'number' ? Math.round(ctx.lastAiCallMs / 1000) : '?';
      return `Heads up: your last decision took ${sec} seconds. That's typically caused by prompt bloat. To keep the run moving:

- Prefer **focused extract / extract_list** (with a specific selector + key) over broad read_page on large pages.
- When using \`execute_js\`, scope the work tightly (one querySelector + one regex/slice) and keep \`code\` under ~300 chars. Long code in past history rides along in every subsequent prompt.
- Don't re-emit the same page-read commands repeatedly — past observations are already in your context.
- If the provider is genuinely slow (rate-limited / overloaded), wait it out — there's nothing the code can do about that.`;
    } catch (error) {
      console.error('Error generating prompt injection for slowLlmCall:', getErrorMessage(error));
      return 'Error generating prompt injection for slow LLM call.';
    }
  }
};