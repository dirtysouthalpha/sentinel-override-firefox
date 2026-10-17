// popup-modules/popup-state.js
// Reactive state management for the Sentinel Override popup.
// Loaded first so window.__popupState is available to all other modules.
//
// Usage:
//   const state = getState();            // returns the reactive proxy
//   subscribe('activeProviderId', cb);   // cb(newValue, key) on change

/**
 * Subscriber registry mapping state keys to sets of callbacks.
 * @typedef {Object.<string, Set<Function>>} SubscriberRegistry
 */
const _subscribers = {}; // key -> Set<callback>

/**
 * Default state shape for the popup.
 * @typedef {Object} InitialState
 */
const _initialState = {
  conversationHistory: [],
  selectedAttachments: [],
  currentSearchQuery: '',
  currentSearchIndex: 0,
  activeProviderId: 'anthropic',
  providerConfigs: { anthropic: {}, openai: {} },
  currentReportMarkdown: null,
  currentReport: null,
  pendingStepLogs: {},
};

/**
 * Creates a reactive proxy for a target object.
 * @param {Object} target - The object to make reactive.
 * @returns {Object} A Proxy that notifies subscribers on property changes.
 */
function _createReactiveProxy(target) {
  return new Proxy(target, {
    set(obj, prop, value) {
      const oldValue = obj[prop];
      obj[prop] = value;

      // Notify subscribers only when the value actually changed
      if (oldValue !== value && _subscribers[prop]) {
        for (const cb of _subscribers[prop]) {
          try {
            cb(value, prop, oldValue);
          } catch (err) {
            console.error(`[popup-state] subscriber error on "${String(prop)}":`, err);
          }
        }
      }
      return true;
    },
  });
}

/**
 * Initialize (or re-initialize) the shared popup state.
 * Sets window.__popupState to a new reactive proxy.
 * Safe to call once at startup.
 */
function initPopupState() {
  // Deep-clone defaults so each init is independent
  let fresh;
  try {
    fresh = structuredClone(_initialState);
  } catch (cloneErr) {
    console.error('[Sentinel/popup-state] Failed to deep-clone initial state, using shallow copy:', (typeof cloneErr.message === 'string' ? cloneErr.message : String(cloneErr)));
    fresh = { ..._initialState };
  }
  window.__popupState = _createReactiveProxy(fresh);
}

/**
 * Returns the reactive state proxy (window.__popupState).
 * @returns {Object} The reactive state proxy.
 */
function getState() {
  return window.__popupState;
}

/**
 * Subscribe to changes on a specific state key.
 * @param {string} key - State property name to watch.
 * @param {Function} callback - Called with (newValue, key, oldValue).
 * @returns {Function} Unsubscribe function.
 */
function subscribe(key, callback) {
  if (typeof callback !== 'function') return () => {};
  if (!_subscribers[key]) {
    _subscribers[key] = new Set();
  }
  _subscribers[key].add(callback);

  // Return an unsubscribe thunk for easy cleanup
  return () => {
    _subscribers[key]?.delete(callback);
  };
}

// Export to global scope for popup-full.js
if (typeof window !== 'undefined') {
  window.initPopupState = initPopupState;
  window.getState = getState;
  window.subscribe = subscribe;
}
