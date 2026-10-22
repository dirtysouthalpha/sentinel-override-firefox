// background/vision-grounding.js
// Vision grounding fallback for Sentinel Override.
//
// When DOM-based clicks fail repeatedly (element not found, stale ref, etc.),
// fall back to screenshot-based coordinate prediction. This is the SeeClick
// (ACL 2024) / Magnitude approach: send a screenshot to the VLM and ask it
// to predict the click coordinates.
//
// Activation: DOM click fails 2+ times for the same target description.
// The VLM returns normalized [x, y] coordinates which we convert to screen pixels.

/**
 * Request a vision-based click from the VLM.
 * Sends a screenshot and asks the model to predict coordinates for the target.
 *
 * @param {object} params - { tabId, targetDescription, screenshotBase64, viewportWidth, viewportHeight, provider, model, callLLMFn }
 * @returns {Promise<{x: number, y: number, confidence: number}|null>} Screen coordinates or null
 */
export async function visionGroundedClick(params) {
  const { tabId, targetDescription, screenshotBase64, viewportWidth, viewportHeight, callLLMFn } = params;

  if (!screenshotBase64 || !callLLMFn) return null;

  const system = `You are a vision grounding specialist. You are shown a screenshot of a web page.
The user wants to click on: "${targetDescription}".
Analyze the screenshot and predict the EXACT pixel coordinates (x, y) where the click should land.
Return ONLY a JSON object: {"x": <number 0-${viewportWidth}>, "y": <number 0-${viewportHeight}>, "confidence": <number 0-1>}
Be as precise as possible. If you cannot find the target, return {"x": -1, "y": -1, "confidence": 0}.`;

  const userMessage = `Find "${targetDescription}" in this screenshot and predict click coordinates.`;

  try {
    const response = await callLLMFn(system, userMessage, screenshotBase64);
    if (!response) return null;

    // Extract JSON from response
    const jsonMatch = response.match(/\{[^}]+\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    if (parsed.x < 0 || parsed.y < 0 || parsed.confidence < 0.3) return null;

    return {
      x: Math.min(viewportWidth, Math.max(0, Math.round(parsed.x))),
      y: Math.min(viewportHeight, Math.max(0, Math.round(parsed.y))),
      confidence: parsed.confidence
    };
  } catch (err) {
    console.warn('[VISION-GROUNDING] Failed to parse VLM response:', err?.message || err);
    return null;
  }
}

/**
 * Self-healing click with DOM → vision fallback.
 * Tries DOM-based click first, then falls back to vision grounding.
 *
 * @param {object} params - { tabId, targetSelector, targetDescription, cdpExecuteJs, cdpDispatchClickFn, screenshotBase64, viewport, callLLMFn }
 * @returns {{ok: boolean, method: string}}
 */
export async function selfHealingClick(params) {
  const { tabId, targetSelector, targetDescription, cdpExecuteJs, cdpDispatchClickFn, screenshotBase64, viewport, callLLMFn } = params;
  const maxDomAttempts = 2;

  // Phase 1: DOM-based click attempts
  for (let i = 0; i < maxDomAttempts; i++) {
    try {
      const result = await cdpExecuteJs(tabId, `
        (() => {
          const el = document.querySelector(${JSON.stringify(targetSelector)});
          if (!el) return JSON.stringify({ found: false });
          el.click();
          return JSON.stringify({ found: true });
        })()
      `, { returnByValue: true });

      if (result?.result?.value) {
        const parsed = JSON.parse(result.result.value);
        if (parsed.found) return { ok: true, method: 'dom_click', attempts: i + 1 };
      }
    } catch (_e) { /* try next */ }
  }

  // Phase 2: Vision grounding fallback
  console.info('[VISION-GROUNDING] DOM click failed, attempting vision-based click for:', targetDescription);
  const coords = await visionGroundedClick({
    tabId,
    targetDescription,
    screenshotBase64,
    viewportWidth: viewport?.width || 1920,
    viewportHeight: viewport?.height || 1080,
    callLLMFn
  });

  if (coords) {
    const result = await cdpDispatchClickFn(tabId, coords.x, coords.y, {
      description: `Vision-grounded click on "${targetDescription}" (${Math.round(coords.confidence * 100)}% confidence)`
    });
    return { ok: result.ok, method: 'vision_grounded', attempts: maxDomAttempts + 1, confidence: coords.confidence };
  }

  return { ok: false, method: 'all_failed', attempts: maxDomAttempts + 1 };
}
