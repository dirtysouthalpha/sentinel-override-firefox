// background/start-tab-gate.js
// (O4/A1 fix 2 — tab-drift gate) Single decision point for which tab an agent
// run starts on. Priority: explicit tabId (validated web page) > content-tab
// sender (web URL, or URL-less programmatic sender) > active web tab > SO-85
// recency fallback for extension-page senders. Extension-page senders are
// REFUSED outright while a run is active, and an explicit tabId is only honored
// for real http(s) pages — the v20.2.1 programmatic door (run_agent_loop
// request.tabId) previously built a URL-less synthetic sender, which bypassed
// the SO-85 extension-page check entirely.
// Pure decision logic — chrome access is injected via deps (same pattern as
// endpoint-breaker.js; no chrome mocks needed in unit tests).

export const TAB_GATE = {
  EXPLICIT_WEB: "explicit_web",
  SENDER_TAB: "sender_tab",
  ACTIVE_TAB: "active_tab",
  EXT_PAGE_FALLBACK: "ext_page_fallback",
};

export class TabGateError extends Error {
  constructor(message) {
    super(message);
    this.name = "TabGateError";
    this.code = "TAB_GATE_REFUSED";
  }
}

export function isWebUrl(u) {
  return /^https?:\/\//i.test(String(u || ""));
}

export function isExtensionUrl(u) {
  return /^chrome-extension:\/\//i.test(String(u || ""));
}

/**
 * Resolve + gate the start tab for an agent run.
 * @param {chrome.runtime.MessageSender|null} sender
 * @param {number|undefined} explicitTabId
 * @param {{getTabInfo: Function, tabsQuery: Function, isAgentRunning: Function}} deps
 * @returns {Promise<{tabId: number, mode: string, url: string}>}
 * @throws {TabGateError} on any refused registration
 */
export async function resolveStartTab(sender, explicitTabId, deps) {
  const { getTabInfo, tabsQuery, isAgentRunning } = deps;

  // Rule 1 — explicit tabId wins, but ONLY for real web pages. (SO-85 hazard
  // through the programmatic door: without this check a caller can point a run
  // at the extension's own dashboard tab.)
  if (typeof explicitTabId === "number") {
    const info = await getTabInfo(explicitTabId);
    if (!info || !isWebUrl(info.url)) {
      throw new TabGateError(
        "TAB_GATE_REFUSED: explicit tabId " + explicitTabId + " is not a web page — pass a tab whose URL is http(s)"
      );
    }
    return { tabId: explicitTabId, mode: TAB_GATE.EXPLICIT_WEB, url: info.url };
  }

  const senderTab = sender && sender.tab;
  const senderUrl = (senderTab && senderTab.url) || "";

  // Rule 2 — a content-tab sender targets its own page directly. URL-less
  // programmatic senders ({tab:{id}} from scheduler/integrations) also pass:
  // they resolved the tab themselves, pre-date the gate, and never carried a
  // URL. Only an explicit chrome-extension:// URL falls to rule 3 (SO-85b).
  if (senderTab && typeof senderTab.id === "number" && (senderUrl === "" || isWebUrl(senderUrl))) {
    return { tabId: senderTab.id, mode: TAB_GATE.SENDER_TAB, url: senderUrl };
  }

  // Rule 3 — extension pages may not register or switch the agent tab while a
  // run is active.
  if (isAgentRunning()) {
    throw new TabGateError(
      "TAB_GATE_REFUSED: agent is running — extension pages may not register or switch the agent tab"
    );
  }

  // Rule 3a — idle: an active tab that is a real web page keeps winning, as
  // before the gate (preserves the popup "run here" contract across windows).
  const activeTabs = await tabsQuery({ active: true, currentWindow: true });
  const activeTab = (Array.isArray(activeTabs) ? activeTabs : [])[0];
  if (activeTab && typeof activeTab.id === "number" && isWebUrl(activeTab.url)) {
    return { tabId: activeTab.id, mode: TAB_GATE.ACTIVE_TAB, url: activeTab.url };
  }

  // SO-85 / SO-85b fallback, unchanged: active tab is an extension/internal
  // page (or none) — most recently accessed real web page wins.
  const allTabs = await tabsQuery({});
  const webTabs = (Array.isArray(allTabs) ? allTabs : [])
    .filter((t) => isWebUrl(t.url))
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  if (webTabs.length === 0) {
    throw new Error("No active web page found. Open the site you want the agent to work on, then start the task.");
  }
  return { tabId: webTabs[0].id, mode: TAB_GATE.EXT_PAGE_FALLBACK, url: webTabs[0].url };
}
