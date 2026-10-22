// background/task-tracker.js
// Multi-step task tracking for Sentinel Override (browser-use todo.md pattern).
//
// Tracks complex multi-step tasks with explicit subtask lists so the agent can:
//   - Show the LLM a compact progress summary (reduces context waste)
//   - Resume after interruptions by re-reading the task state
//   - Detect stuck loops (same step failing repeatedly)
//
// Persists to chrome.storage.local so tasks survive service-worker restarts.
// Active tasks are also kept in memory for zero-latency access.

import { getErrorMessage } from "./error-utils.js";

/** @type {Map<string, object>} In-memory cache of active tasks */
const activeTasks = new Map();

/** Storage key for task persistence */
const STORAGE_KEY = "sentinel_override_active_tasks";

/**
 * Generate a unique task ID.
 * @returns {string} A short unique identifier
 */
function generateTaskId() {
  return "task_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

/**
 * Get current ISO timestamp.
 * @returns {string} ISO 8601 timestamp
 */
function nowIso() {
  return new Date().toISOString();
}

/**
 * Load tasks from chrome.storage.local into the in-memory cache.
 * Call this at service-worker startup to restore state.
 *
 * @returns {Promise<void>}
 */
async function loadTasksFromStorage() {
  try {
    if (typeof chrome === "undefined" || !chrome.storage?.local) return;

    const data = await chrome.storage.local.get({ [STORAGE_KEY]: {} });
    const stored = data[STORAGE_KEY] || {};

    activeTasks.clear();
    for (const [id, task] of Object.entries(stored)) {
      activeTasks.set(id, task);
    }
  } catch (err) {
    console.warn("[TASK-TRACKER] Failed to load tasks:", getErrorMessage(err));
  }
}

/**
 * Persist the current in-memory task map to chrome.storage.local.
 * @returns {Promise<void>}
 */
async function persistTasks() {
  try {
    if (typeof chrome === "undefined" || !chrome.storage?.local) return;

    const obj = {};
    for (const [id, task] of activeTasks.entries()) {
      obj[id] = task;
    }
    await chrome.storage.local.set({ [STORAGE_KEY]: obj });
  } catch (err) {
    console.warn("[TASK-TRACKER] Failed to persist tasks:", getErrorMessage(err));
  }
}

/**
 * Create a new tracked task with a list of steps.
 *
 * @param {string} description - Human-readable task description (e.g. "Login and check inbox")
 * @param {string[]} steps - Ordered list of step descriptions
 * @returns {{id: string, description: string, steps: Array<{text: string, status: string, attempts: number}>, createdAt: string, updatedAt: string}}
 *   The newly created task object
 */
export function createTask(description, steps) {
  if (!description || typeof description !== "string") {
    throw new Error("createTask: description must be a non-empty string");
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error("createTask: steps must be a non-empty array of strings");
  }

  const task = {
    id: generateTaskId(),
    description,
    steps: steps.map((text) => ({
      text: String(text),
      status: "pending",
      attempts: 0,
    })),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  activeTasks.set(task.id, task);
  persistTasks();
  return task;
}

/**
 * Mark a specific step as completed.
 *
 * @param {string} taskId - The task ID
 * @param {number} stepIndex - Zero-based step index
 * @returns {object|null} Updated task, or null if task/step not found
 */
export function markStepComplete(taskId, stepIndex) {
  const task = activeTasks.get(taskId);
  if (!task) return null;
  if (stepIndex < 0 || stepIndex >= task.steps.length) return null;

  task.steps[stepIndex].status = "done";
  task.steps[stepIndex].attempts += 1;
  task.updatedAt = nowIso();

  persistTasks();
  return task;
}

/**
 * Mark a specific step as failed with a reason.
 *
 * @param {string} taskId - The task ID
 * @param {number} stepIndex - Zero-based step index
 * @param {string} [reason] - Optional failure reason
 * @returns {object|null} Updated task, or null if task/step not found
 */
export function markStepFailed(taskId, stepIndex, reason = "") {
  const task = activeTasks.get(taskId);
  if (!task) return null;
  if (stepIndex < 0 || stepIndex >= task.steps.length) return null;

  task.steps[stepIndex].status = "failed";
  task.steps[stepIndex].attempts += 1;
  if (reason) task.steps[stepIndex].failReason = reason;
  task.updatedAt = nowIso();

  persistTasks();
  return task;
}

/**
 * Get a task summary object with progress stats.
 *
 * @param {string} taskId - The task ID
 * @returns {{id: string, description: string, totalSteps: number, completedSteps: number, failedSteps: number, pendingSteps: number, isComplete: boolean, createdAt: string, updatedAt: string}|null}
 *   Summary object or null if task not found
 */
export function getTaskSummary(taskId) {
  const task = activeTasks.get(taskId);
  if (!task) return null;

  const completed = task.steps.filter((s) => s.status === "done").length;
  const failed = task.steps.filter((s) => s.status === "failed").length;
  const pending = task.steps.filter((s) => s.status === "pending").length;

  return {
    id: task.id,
    description: task.description,
    totalSteps: task.steps.length,
    completedSteps: completed,
    failedSteps: failed,
    pendingSteps: pending,
    isComplete: completed === task.steps.length,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

/**
 * Build a compact context summary string for the LLM.
 * Format: "Task progress: 2/5 steps complete. Next: Click Submit button."
 *
 * @param {string} taskId - The task ID
 * @returns {string} Compact summary string, or "" if task not found
 */
export function buildTaskContextSummary(taskId) {
  const task = activeTasks.get(taskId);
  if (!task) return "";

  const completed = task.steps.filter((s) => s.status === "done").length;
  const total = task.steps.length;

  let summary = `Task progress: ${completed}/${total} steps complete.`;

  // Find the next pending step
  const nextStep = task.steps.find((s) => s.status === "pending");
  if (nextStep) {
    summary += ` Next: ${nextStep.text}.`;
  } else {
    const failedSteps = task.steps.filter((s) => s.status === "failed");
    if (failedSteps.length > 0) {
      summary += ` Failed steps: ${failedSteps.length}. Consider alternative approach.`;
    } else {
      summary += ` All steps complete.`;
    }
  }

  return summary;
}

/**
 * Get all active (incomplete) tasks.
 *
 * @returns {Array<{id: string, description: string, totalSteps: number, completedSteps: number, isComplete: boolean}>}
 *   Array of task summary objects for incomplete tasks
 */
export function getActiveTasks() {
  const result = [];
  for (const [id, task] of activeTasks.entries()) {
    const completed = task.steps.filter((s) => s.status === "done").length;
    const isComplete = completed === task.steps.length;
    if (!isComplete) {
      result.push({
        id: task.id,
        description: task.description,
        totalSteps: task.steps.length,
        completedSteps: completed,
        isComplete: false,
      });
    }
  }
  return result;
}

/**
 * Delete a task from tracking (both memory and storage).
 *
 * @param {string} taskId - The task ID to remove
 * @returns {boolean} True if the task existed and was removed
 */
export function deleteTask(taskId) {
  const existed = activeTasks.has(taskId);
  activeTasks.delete(taskId);
  persistTasks();
  return existed;
}

// Auto-load on module import
loadTasksFromStorage();
