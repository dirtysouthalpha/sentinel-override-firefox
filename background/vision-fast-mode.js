// background/vision-fast-mode.js
// Vision-first fast mode for Sentinel Override.
//
// When DOM extraction is slow (large pages, heavy Shadow DOM, virtual scroll),
// the agent can switch to FAST MODE: send a screenshot to the VLM with numbered
// badges overlaid on interactive elements, and ask for click coordinates by badge ID.
//
// This eliminates the DOM → text → LLM round-trip and goes straight from
// screenshot to action. Coordinates come back as badge IDs, resolved against the
// overlaid element list, so they are logical targets rather than raw pixels.

import { getErrorMessage } from "./error-utils.js";

/**
 * Fast mode system prompt.
 * Sent as the system message when the agent is in fast mode.
 * Instructs the VLM to use numbered badge IDs for all interactions.
 *
 * @returns {string} The fast mode system prompt
 */
export function buildFastModeSystemPrompt() {
  return (
    "You are in FAST MODE. Elements are shown as numbered badges on the screenshot. " +
    "Click by referencing the badge number. " +
    "Return your action as a JSON object with an elements array and a click target. " +
    "Each element has: id (number matching the badge), label (short description), x, y (pixel coords). " +
    "The click field specifies which element to interact with by id. " +
    "Be precise — the badges are placed at the center of each interactive element."
  );
}

/**
 * Build the fast-mode user prompt for a given screenshot and instruction.
 * Includes the user's goal so the VLM knows what to look for on the page.
 *
 * @param {string} instruction - The user's current goal (e.g. "Click the login button")
 * @param {string} [screenshotBase64] - Optional base64 screenshot for context
 * @returns {string} The user message to send to the VLM alongside the screenshot
 */
export function buildFastModePrompt(instruction, screenshotBase64 = null) {
  if (!instruction || typeof instruction !== "string") {
    throw new Error("buildFastModePrompt: instruction must be a non-empty string");
  }

  let prompt = `Goal: ${instruction}\n\n`;
  prompt += "The screenshot shows numbered badges on interactive elements. ";
  prompt += "Identify which elements are relevant to your goal and return them.\n\n";
  prompt += "Return JSON in this exact format:\n";
  prompt += `{\n  "elements": [{"id": 1, "label": "Submit button", "x": 500, "y": 300}],\n  "click": {"id": 1}\n}`;

  return prompt;
}

/**
 * Parse and validate a fast-mode VLM response.
 * Handles JSON extraction from plain text, markdown fences, and partial responses.
 *
 * @param {string} response - Raw text response from the VLM
 * @returns {{elements: Array<{id: number, label: string, x: number, y: number}>, click: {id: number}}|null}
 *   Parsed response or null if invalid
 */
export function parseFastModeResponse(response) {
  if (!response || typeof response !== "string") return null;

  try {
    // Try direct parse first
    let parsed;
    try {
      parsed = JSON.parse(response.trim());
    } catch (_e) {
      // Try extracting from markdown code fence
      const fenceMatch = response.match(/```(?:json)?\s*?\n?([\s\S]*?)```/);
      if (fenceMatch) {
        parsed = JSON.parse(fenceMatch[1].trim());
      } else {
        // Try extracting bare JSON object
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[0]);
        } else {
          return null;
        }
      }
    }

    // Validate structure
    if (!parsed || typeof parsed !== "object") return null;
    if (!Array.isArray(parsed.elements) || parsed.elements.length === 0) return null;
    if (!parsed.click || typeof parsed.click.id !== "number") return null;

    // Validate each element
    const validElements = parsed.elements.filter((el) => {
      return (
        el &&
        typeof el.id === "number" &&
        typeof el.label === "string" &&
        typeof el.x === "number" &&
        typeof el.y === "number"
      );
    });

    if (validElements.length === 0) return null;

    // Validate click target exists in elements
    const targetExists = validElements.some((el) => el.id === parsed.click.id);
    if (!targetExists) return null;

    return { elements: validElements, click: parsed.click };
  } catch (err) {
    console.warn("[VISION-FAST-MODE] Failed to parse response:", getErrorMessage(err));
    return null;
  }
}
