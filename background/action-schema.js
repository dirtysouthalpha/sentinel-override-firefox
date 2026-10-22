// background/action-schema.js
// Declarative schema for model-authored browser actions.
//
// WHAT THIS IS
//   A single description of the action vocabulary: which action types exist,
//   which fields each accepts, and what type each field's value must be.
//   llm-client.js validates every parsed model response against it, so the
//   model receives a precise, self-correctable error instead of having
//   misspelled or wrongly-typed fields silently dropped.
//
// WHAT THIS IS NOT
//   This is NOT an authorisation boundary. It validates SHAPE, not intent:
//   a schema-valid `execute_js` is still a privileged action that the
//   capability gate (background/capabilities.js) refuses unless the operator
//   has granted the privileged capability. Shape validation exists to give the
//   model a good error message and to strip engine-trust fields, not to stop
//   an action from running.
//
// WHY `required` IS EMPTY FOR EVERY ACTION
//   The engine deliberately accepts a bare `{"type":"navigate"}` so the action
//   handler can emit an action-specific corrective error ("navigate: url is
//   required") at the point where it knows what is missing. Rejecting earlier
//   with a generic schema error would replace a better message with a worse
//   one, and the existing parser contract (see tests/llm-client.test.js
//   "handles all action types through parseLLMResponse") pins that behaviour.
//   `required` is therefore declared but empty; the handlers own semantic
//   completeness. Unknown fields and wrong types ARE rejected here.

/** Field value type tags used by the schema tables. */
const T = Object.freeze({
  STRING: 'string',
  NUMBER: 'number',
  BOOLEAN: 'boolean',
  ARRAY: 'array',
  OBJECT: 'object',
  ANY: 'any',
});

/**
 * Fields accepted on EVERY action in addition to that action's own fields.
 * These are metadata/targeting hints the engine reads generically.
 * Deliberately excludes any engine trust marker (see RESERVED_FIELD_RE).
 */
const COMMON_ACTION_FIELDS = Object.freeze({
  key: T.STRING,            // result memory key
  ref: T.ANY,               // element ref from the observation (string id or index)
  label: T.STRING,          // tab label
  index: T.NUMBER,          // generic ordinal (frame index, element index)
  tag: T.STRING,            // element tag hint
  ariaLabel: T.STRING,
  elementText: T.STRING,
  elementId: T.STRING,
  dpr: T.NUMBER,
  description: T.STRING,
  reason: T.STRING,         // model's stated justification (display only)
  reasoning: T.STRING,
  advance_plan: T.BOOLEAN,
  timeout: T.NUMBER,
  // Free-form per-action options bag the engine passes through to handlers.
  // Arbitrary shape by design (see tests: {"type":"extract",...,"options":{...}}).
  options: T.OBJECT,
});

/**
 * Fields the engine writes itself. A model that could set these could claim
 * pre-approval (`approvalGranted`), fabricate vision provenance
 * (`_visionIndex`, `_matchedByVisual`), or forge internal bookkeeping. They are
 * rejected outright in model-authored actions — see RESERVED_FIELD_RE.
 */
const RESERVED_FIELD_RE = /^__|^_[a-z]/;
const RESERVED_FIELD_NAMES = new Set(['approvalGranted', 'autoApproved', 'approved']);

/**
 * Per-action field tables. Every key of ACTION_SCHEMA is a valid action type;
 * VALID_ACTION_TYPES in llm-client.js is asserted to be in parity by
 * tests/action-schema.test.js.
 */
const ACTION_SCHEMA = Object.freeze({
  // ---- element-targeted interactions ----
  click: Object.freeze({ properties: Object.freeze({ selector: T.STRING, text: T.STRING, value: T.STRING, force: T.BOOLEAN, button: T.STRING, clickCount: T.NUMBER }) }),
  right_click: Object.freeze({ properties: Object.freeze({ selector: T.STRING, text: T.STRING, force: T.BOOLEAN, button: T.STRING }) }),
  double_click: Object.freeze({ properties: Object.freeze({ selector: T.STRING, text: T.STRING, force: T.BOOLEAN, button: T.STRING }) }),
  hover: Object.freeze({ properties: Object.freeze({ selector: T.STRING, text: T.STRING }) }),
  type: Object.freeze({ properties: Object.freeze({ selector: T.STRING, text: T.STRING, value: T.STRING, content: T.STRING, submit: T.BOOLEAN, clear: T.BOOLEAN, delay: T.NUMBER, force: T.BOOLEAN }) }),
  select: Object.freeze({ properties: Object.freeze({ selector: T.STRING, value: T.STRING, text: T.STRING }) }),
  press_key: Object.freeze({ properties: Object.freeze({ key: T.STRING, modifiers: T.ARRAY, selector: T.STRING, text: T.STRING }) }),
  check: Object.freeze({ properties: Object.freeze({ selector: T.STRING, checked: T.BOOLEAN }) }),
  check_all: Object.freeze({ properties: Object.freeze({ selector: T.STRING }) }),
  open_dropdown: Object.freeze({ properties: Object.freeze({ selector: T.STRING, text: T.STRING }) }),
  upload_file: Object.freeze({ properties: Object.freeze({ selector: T.STRING, path: T.STRING, file_name: T.STRING, mime_type: T.STRING, files: T.ARRAY }) }),
  dismiss_overlay: Object.freeze({ properties: Object.freeze({}) }),

  // ---- coordinate interactions ----
  click_at: Object.freeze({ properties: Object.freeze({ x: T.NUMBER, y: T.NUMBER }) }),
  right_click_at: Object.freeze({ properties: Object.freeze({ x: T.NUMBER, y: T.NUMBER }) }),
  double_click_at: Object.freeze({ properties: Object.freeze({ x: T.NUMBER, y: T.NUMBER }) }),
  triple_click_at: Object.freeze({ properties: Object.freeze({ x: T.NUMBER, y: T.NUMBER }) }),
  scroll_at: Object.freeze({ properties: Object.freeze({ x: T.NUMBER, y: T.NUMBER, direction: T.STRING, amount: T.NUMBER }) }),
  zoom_at: Object.freeze({ properties: Object.freeze({ x: T.NUMBER, y: T.NUMBER, zoom: T.NUMBER }) }),
  scroll_to: Object.freeze({ properties: Object.freeze({ x: T.NUMBER, y: T.NUMBER, selector: T.STRING }) }),
  drag_at: Object.freeze({ properties: Object.freeze({ x1: T.NUMBER, y1: T.NUMBER, x2: T.NUMBER, y2: T.NUMBER }) }),
  drag_and_drop: Object.freeze({ properties: Object.freeze({
    from: T.STRING, to: T.STRING, source: T.STRING, target: T.STRING,
    source_selector: T.STRING, source_ref: T.ANY, source_label: T.STRING,
    target_selector: T.STRING, target_ref: T.ANY, target_label: T.STRING,
  }) }),

  // ---- scrolling / viewport ----
  scroll: Object.freeze({ properties: Object.freeze({ selector: T.STRING, direction: T.STRING, amount: T.NUMBER }) }),

  // ---- navigation ----
  navigate: Object.freeze({ properties: Object.freeze({ url: T.STRING }) }),
  smart_navigate: Object.freeze({ properties: Object.freeze({ url: T.STRING, site: T.STRING, query: T.STRING, preset: T.STRING }) }),
  navigate_back: Object.freeze({ properties: Object.freeze({}) }),
  navigate_forward: Object.freeze({ properties: Object.freeze({}) }),

  // ---- tabs ----
  open_tab: Object.freeze({ properties: Object.freeze({ url: T.STRING }) }),
  switch_tab: Object.freeze({ properties: Object.freeze({ tab_id: T.NUMBER }) }),
  close_tab: Object.freeze({ properties: Object.freeze({ tab_id: T.NUMBER }) }),

  // ---- frames (cross-origin frame access is gated by capabilities.js) ----
  switch_to_frame: Object.freeze({ properties: Object.freeze({ frame_index: T.NUMBER, frame_selector: T.STRING, selector: T.STRING }) }),
  switch_to_parent_frame: Object.freeze({ properties: Object.freeze({}) }),

  // ---- reading / extraction ----
  extract: Object.freeze({ properties: Object.freeze({ selector: T.STRING, attribute: T.STRING, items_key: T.STRING, item_var: T.STRING, fields: T.ARRAY }) }),
  extract_list: Object.freeze({ properties: Object.freeze({ selector: T.STRING, attribute: T.STRING, items_key: T.STRING, item_var: T.STRING, fields: T.ARRAY }) }),
  read_page: Object.freeze({ properties: Object.freeze({}) }),
  read_console_messages: Object.freeze({ properties: Object.freeze({ limit: T.NUMBER, filter: T.STRING }) }),
  read_network_requests: Object.freeze({ properties: Object.freeze({ limit: T.NUMBER, filter: T.STRING, url_includes: T.STRING }) }),
  find: Object.freeze({ properties: Object.freeze({ query: T.STRING, site: T.STRING, selector: T.STRING, text: T.STRING, expected: T.STRING, limit: T.NUMBER }) }),

  // ---- privileged: execute_js (capability-gated, NOT removed) ----
  execute_js: Object.freeze({ properties: Object.freeze({ code: T.STRING }) }),

  // ---- verification / control flow ----
  verify: Object.freeze({ properties: Object.freeze({ selector: T.STRING, text: T.STRING, expected: T.STRING, value: T.STRING }) }),
  lookup: Object.freeze({ properties: Object.freeze({ domain: T.STRING, host: T.STRING, query: T.STRING, record_type: T.STRING, type_field: T.STRING, preset: T.STRING, selector: T.STRING, expected: T.STRING, fields: T.ARRAY, items: T.ARRAY }) }),
  run_remote_command: Object.freeze({ properties: Object.freeze({ command: T.STRING, command_type: T.STRING }) }),
  repeat_for_each: Object.freeze({ properties: Object.freeze({ selector: T.STRING, actions: T.ARRAY, action: T.OBJECT, do: T.ARRAY, items: T.ARRAY, items_key: T.STRING, item_var: T.STRING }) }),
  batch: Object.freeze({ properties: Object.freeze({ actions: T.ARRAY, commands: T.ARRAY, steps: T.ARRAY }) }),

  // ---- waiting ----
  wait: Object.freeze({ properties: Object.freeze({ ms: T.NUMBER }) }),
  wait_for_text: Object.freeze({ properties: Object.freeze({ text: T.STRING, selector: T.STRING }) }),
  wait_for_element: Object.freeze({ properties: Object.freeze({ selector: T.STRING }) }),
  wait_for_navigation: Object.freeze({ properties: Object.freeze({ url_includes: T.STRING }) }),

  // ---- output ----
  note: Object.freeze({ properties: Object.freeze({ text: T.STRING, summary: T.STRING }) }),
  finish: Object.freeze({ properties: Object.freeze({ summary: T.STRING, text: T.STRING }) }),
});

const ACTION_TYPES = Object.freeze(Object.keys(ACTION_SCHEMA));

// Fields whose value must itself be a well-formed action (nested sub-actions).
const NESTED_ACTION_ARRAY_FIELDS = Object.freeze(['actions', 'commands', 'steps', 'do']);
const NESTED_ACTION_OBJECT_FIELDS = Object.freeze(['action']);

const MAX_NESTING_DEPTH = 5;

/** @returns {boolean} true when `type` names a known action. */
function isKnownActionType(type) {
  return typeof type === 'string' && Object.prototype.hasOwnProperty.call(ACTION_SCHEMA, type);
}

/**
 * The full set of field names an action type accepts (its own + common).
 * @param {string} type
 * @returns {string[]}
 */
function allowedFieldsFor(type) {
  const own = isKnownActionType(type) ? Object.keys(ACTION_SCHEMA[type].properties) : [];
  return [...own, ...Object.keys(COMMON_ACTION_FIELDS)].sort();
}

function _typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function _matchesSpec(value, spec) {
  if (spec === T.ANY) return true;
  if (spec === T.ARRAY) return Array.isArray(value);
  if (spec === T.OBJECT) return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (spec === T.STRING) return typeof value === 'string';
  if (spec === T.NUMBER) return typeof value === 'number' && Number.isFinite(value);
  if (spec === T.BOOLEAN) return typeof value === 'boolean';
  return true;
}

function _fieldSpec(type, field) {
  const props = ACTION_SCHEMA[type].properties;
  if (Object.prototype.hasOwnProperty.call(props, field)) return props[field];
  if (Object.prototype.hasOwnProperty.call(COMMON_ACTION_FIELDS, field)) return COMMON_ACTION_FIELDS[field];
  return undefined;
}

function _fail(code, message) {
  return { valid: false, code, error: message };
}

/**
 * Validate one action object against the schema.
 *
 * Pure and synchronous: safe to unit-test without a browser and to call on the
 * parse hot path. Rejects unknown action types, unknown fields, reserved
 * engine-trust fields, and wrong value types. Recurses into nested sub-actions
 * (batch.actions, repeat_for_each.do, ...) so a valid outer action cannot
 * smuggle an invalid inner one.
 *
 * @param {*} action - Candidate action object.
 * @param {{depth?: number}} [opts] - Internal recursion bookkeeping.
 * @returns {{valid: true} | {valid: false, code: string, error: string}}
 */
function validateAction(action, opts = {}) {
  const depth = typeof opts.depth === 'number' ? opts.depth : 0;

  if (action === null || typeof action !== 'object' || Array.isArray(action)) {
    return _fail('NOT_OBJECT', `Action must be a JSON object, got ${_typeOf(action)}`);
  }
  if (!isKnownActionType(action.type)) {
    return _fail('UNKNOWN_TYPE',
      `Unknown action type ${JSON.stringify(action.type)}. Use one of: ${ACTION_TYPES.join(', ')}`);
  }
  if (depth >= MAX_NESTING_DEPTH) {
    return _fail('TOO_DEEP', `Action nesting exceeded ${MAX_NESTING_DEPTH} levels`);
  }

  const type = action.type;

  for (const field of Object.keys(action)) {
    if (field === 'type') continue;

    if (RESERVED_FIELD_RE.test(field) || RESERVED_FIELD_NAMES.has(field)) {
      return _fail('RESERVED_FIELD',
        `Field "${field}" on action "${type}" is set by the engine and cannot be supplied by the model. Remove it.`);
    }

    const spec = _fieldSpec(type, field);
    if (spec === undefined) {
      return _fail('UNKNOWN_FIELD',
        `Unknown field "${field}" for action "${type}". Allowed fields: ${allowedFieldsFor(type).join(', ')}`);
    }

    const value = action[field];
    if (value === undefined) continue;

    if (!_matchesSpec(value, spec)) {
      return _fail('BAD_TYPE',
        `Field "${field}" on action "${type}" must be a ${spec}, got ${_typeOf(value)}`);
    }

    if (NESTED_ACTION_ARRAY_FIELDS.includes(field) && Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const nested = validateAction(value[i], { depth: depth + 1 });
        if (!nested.valid) {
          return _fail(nested.code, `${type}.${field}[${i}]: ${nested.error}`);
        }
      }
    }
    if (NESTED_ACTION_OBJECT_FIELDS.includes(field) && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const nested = validateAction(value, { depth: depth + 1 });
      if (!nested.valid) {
        return _fail(nested.code, `${type}.${field}: ${nested.error}`);
      }
    }
  }

  return { valid: true };
}

export {
  T,
  ACTION_SCHEMA,
  ACTION_TYPES,
  COMMON_ACTION_FIELDS,
  RESERVED_FIELD_RE,
  RESERVED_FIELD_NAMES,
  MAX_NESTING_DEPTH,
  isKnownActionType,
  allowedFieldsFor,
  validateAction,
};
