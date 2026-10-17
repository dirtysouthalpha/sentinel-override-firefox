// SO-93 — Firefox event-page entry point.
// The shim MUST evaluate before any background module reads chrome.* — ESM
// import order (depth-first, source order) guarantees that.
import './webext-shim.js';
import '../background/index.js';
