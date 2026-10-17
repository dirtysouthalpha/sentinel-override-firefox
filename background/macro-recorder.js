/**
 * Sentinel Override — Macro Recorder.
 * Records sequences of user actions for replay.
 * Stores macros in chrome.storage.local.
 */

import { getErrorMessage } from './error-utils.js';

const STORAGE_KEY = 'sentinel_macros';

/**
 * @typedef {Object} MacroStep
 * @property {string} action - Action type (click, type, scroll, etc.)
 * @property {Object} params - Action parameters
 * @property {number} delay - Delay after action in ms
 */

/**
 * @typedef {Object} Macro
 * @property {string} id - UUID
 * @property {string} name - Human-readable name
 * @property {string} description
 * @property {MacroStep[]} steps
 * @property {string} createdAt - ISO timestamp
 * @property {string} updatedAt - ISO timestamp
 * @property {number} runCount - Times this macro has been replayed
 */

function generateId() {
  return crypto.randomUUID ? crypto.randomUUID() : `macro-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Load all macros from storage.
 * @returns {Promise<Macro[]>}
 */
export async function loadMacros() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    return result[STORAGE_KEY] || [];
  } catch (e) {
    console.error('[Sentinel/macro-recorder] loadMacros failed:', getErrorMessage(e));
    return [];
  }
}

/**
 * Save macros to storage.
 * @param {Macro[]} macros
 */
async function saveMacros(macros) {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: macros });
  } catch (e) {
    console.error('[Sentinel/macro-recorder] saveMacros failed:', getErrorMessage(e));
    throw e;
  }
}

/**
 * Create a new macro.
 * @param {string} name
 * @param {string} description
 * @param {MacroStep[]} steps
 * @returns {Promise<Macro>}
 */
export async function createMacro(name, description, steps) {
  const macros = await loadMacros();
  const now = new Date().toISOString();
  const macro = {
    id: generateId(),
    name: (name || '').trim() || 'Untitled Macro',
    description: (description || '').trim(),
    steps: steps || [],
    createdAt: now,
    updatedAt: now,
    runCount: 0,
  };
  macros.push(macro);
  await saveMacros(macros);
  return macro;
}

/**
 * Update an existing macro.
 * @param {string} id
 * @param {Partial<Macro>} updates
 */
export async function updateMacro(id, updates) {
  const macros = await loadMacros();
  const idx = macros.findIndex(m => m.id === id);
  if (idx === -1) throw new Error(`Macro ${id} not found`);
  macros[idx] = {
    ...macros[idx],
    ...updates,
    updatedAt: new Date().toISOString(),
  };
  await saveMacros(macros);
  return macros[idx];
}

/**
 * Delete a macro.
 * @param {string} id
 */
export async function deleteMacro(id) {
  const macros = await loadMacros();
  const filtered = macros.filter(m => m.id !== id);
  await saveMacros(filtered);
}

/**
 * Increment the run count for a macro.
 * @param {string} id
 */
export async function incrementRunCount(id) {
  const macros = await loadMacros();
  const macro = macros.find(m => m.id === id);
  if (macro) {
    macro.runCount++;
    macro.updatedAt = new Date().toISOString();
    await saveMacros(macros);
  }
}

/**
 * Export a macro as a JSON string for sharing.
 * @param {string} id
 * @returns {Promise<string>}
 */
export async function exportMacro(id) {
  const macros = await loadMacros();
  const macro = macros.find(m => m.id === id);
  if (!macro) throw new Error(`Macro ${id} not found`);
  return JSON.stringify({ sentinelMacro: 1, ...macro });
}

/**
 * Import a macro from a JSON string.
 * @param {string} jsonStr
 * @returns {Promise<Macro>}
 */
export async function importMacro(jsonStr) {
  let data;
  try {
    data = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`Invalid macro JSON: ${getErrorMessage(e)}`);
  }
  if (!data.sentinelMacro || !data.steps) {
    throw new Error('Invalid macro format');
  }
  return createMacro(
    data.name || 'Imported Macro',
    data.description || '',
    data.steps
  );
}

/**
 * Convert a run history into a macro.
 * Filters out non-action steps and normalizes the format.
 * @param {Array} history - Run history entries
 * @param {string} name - Macro name
 * @param {string} description
 * @returns {Promise<Macro>}
 */
export async function historyToMacro(history, name, description) {
  const steps = history
    .filter(h => h.action && !h.actionFailed)
    .map(h => ({
      action: (typeof h.action === 'string' ? h.action : h.action.type) || 'unknown',
      params: (h.action && typeof h.action === 'object' && h.action.params) || {},
      delay: h.duration || 1000,
    }));

  return createMacro(name, description, steps);
}

// ─── Live Recording ────────────────────────────────

let _recording = false;
let _recordedSteps = [];

/**
 * Start recording actions.
 */
export function startRecording() {
  _recording = true;
  _recordedSteps = [];
}

/**
 * Record a single action during recording.
 * @param {string} action
 * @param {Object} params
 * @param {number} delay
 */
export function recordStep(action, params, delay = 500) {
  if (!_recording) return;
  _recordedSteps.push({ action, params, delay });
}

/**
 * Stop recording and save as macro.
 * @param {string} name
 * @param {string} description
 * @returns {Promise<Macro>}
 */
export async function stopRecording(name = 'Recorded Macro', description = '') {
  _recording = false;
  const steps = [..._recordedSteps];
  _recordedSteps = [];
  if (!steps.length) return null;
  return createMacro(name, description, steps);
}

/**
 * Check if recording is active.
 */
export function isRecording() {
  return _recording;
}

/**
 * Get current recorded step count.
 */
export function recordedStepCount() {
  return _recordedSteps.length;
}
