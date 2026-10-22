// background/system-prompt-rules.js
// Enhanced system prompt rules for Sentinel Override.
//
// These rules are adapted from browser-use's proven system prompt improvements
// that measurably increase task success rates. They are appended to the base
// system prompt to handle common failure modes:
//   - Popups/cookie banners blocking interactions
//   - Unnecessary login attempts
//   - Filter-before-scroll ordering
//   - Premature task completion
//   - Getting stuck in loops
//   - Budget-aware progress checkpoints

/**
 * The six proven rules (from browser-use research) for agent reliability.
 * Each rule targets a specific failure pattern observed in production agent runs.
 *
 * @type {string[]}
 */
export const ENHANCED_RULES = [
  "Handle popups and cookie banners BEFORE interacting with the page",
  "Do NOT login unless explicitly required by the goal",
  "Apply filters BEFORE scrolling or pagination",
  "Verify ALL requirements before calling finish",
  "If stuck for 3+ steps, try a different approach or ask for help",
  "75% step budget checkpoint: assess progress and adjust strategy",
];

/**
 * Build the enhanced system prompt by appending proven rules to the base prompt.
 *
 * @param {string} basePrompt - The base system prompt to enhance
 * @param {object} [context] - Optional context for conditional rule injection
 * @param {boolean} [context.skipLoginRule] - If true, omit the login rule (default: false)
 * @param {boolean} [context.isFormTask] - If true, add form-specific guidance (default: false)
 * @param {number} [context.stepBudget] - Total steps allowed, used for checkpoint rule (default: 0 = omit)
 * @returns {string} The full enhanced system prompt with rules appended
 */
export function buildEnhancedSystemPrompt(basePrompt, context = {}) {
  if (!basePrompt || typeof basePrompt !== "string") {
    throw new Error("buildEnhancedSystemPrompt: basePrompt must be a non-empty string");
  }

  const rules = [...ENHANCED_RULES];

  // Conditionally omit login rule if context says so
  if (context.skipLoginRule) {
    const idx = rules.indexOf("Do NOT login unless explicitly required by the goal");
    if (idx !== -1) rules.splice(idx, 1);
  }

  // Build the rules section
  let enhanced = basePrompt.trim();
  enhanced += "\n\n## Agent Rules (follow these strictly):\n";

  for (let i = 0; i < rules.length; i++) {
    enhanced += `${i + 1}. ${rules[i]}\n`;
  }

  // Optional form-task guidance
  if (context.isFormTask) {
    enhanced += "\n## Form Task Notes:\n";
    enhanced += "- Fill all required fields before submitting\n";
    enhanced += "- Verify field types match expected input (date, email, etc.)\n";
  }

  // Optional step budget checkpoint
  if (context.stepBudget && context.stepBudget > 0) {
    const checkpointAt = Math.floor(context.stepBudget * 0.75);
    enhanced += `\n## Budget: You have ${context.stepBudget} steps total.`;
    enhanced += ` At step ${checkpointAt}, assess progress before continuing.\n`;
  }

  return enhanced;
}

/**
 * Get the list of enhanced rules as a formatted string (for display/logging).
 *
 * @returns {string} Numbered rules as a single string
 */
export function getRulesFormatted() {
  return ENHANCED_RULES.map((r, i) => `${i + 1}. ${r}`).join("\n");
}
