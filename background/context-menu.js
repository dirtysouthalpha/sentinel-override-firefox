// Sentinel Override — Context Menu Manager
// Adds right-click menu items for AI-powered page actions.

const MENU_ITEMS = [
  {
    id: 'sentinel-analyze',
    title: '🛡️ Analyze with Sentinel',
    contexts: ['selection', 'link', 'page'],
  },
  {
    id: 'sentinel-extract',
    title: '📋 Extract Data',
    contexts: ['selection'],
  },
  {
    id: 'sentinel-fill-form',
    title: '📝 Auto-Fill Form',
    contexts: ['page'],
  },
  {
    id: 'sentinel-screenshot',
    title: '📸 Full Page Screenshot',
    contexts: ['page'],
  },
  {
    id: 'sentinel-summarize',
    title: '📄 Summarize Page',
    contexts: ['page'],
  },
  {
    id: 'sentinel-monitor',
    title: '👁️ Monitor for Changes',
    contexts: ['selection'],
  },
  {
    id: 'sentinel-record',
    title: '⏺️ Start Recording Macro',
    contexts: ['page'],
  },
  {
    id: 'sentinel-quick-assist',
    title: '⚡ Sentinel Quick Assist',
    contexts: ['selection'],
  },
];

/**
 * Register all Sentinel context menu items in Chrome.
 * Creates a parent menu with child items for analysis, extraction, form fill,
 * screenshot, summarization, monitoring, macro recording, and Quick Assist.
 */
export function installContextMenus() {
  chrome.contextMenus.removeAll(() => {
    // Parent menu
    chrome.contextMenus.create({
      id: 'sentinel-parent',
      title: '🛡️ Sentinel Override',
      contexts: ['page', 'selection', 'link'],
    });

    // Child items
    MENU_ITEMS.forEach(item => {
      chrome.contextMenus.create({
        id: item.id,
        parentId: 'sentinel-parent',
        title: item.title,
        contexts: item.contexts,
      });
    });

    // Separator + advanced
    chrome.contextMenus.create({
      id: 'sentinel-sep',
      parentId: 'sentinel-parent',
      type: 'separator',
      contexts: ['page'],
    });

    chrome.contextMenus.create({
      id: 'sentinel-run-macro',
      parentId: 'sentinel-parent',
      title: '▶️ Run Macro...',
      contexts: ['page'],
    });

    chrome.contextMenus.create({
      id: 'sentinel-export-report',
      parentId: 'sentinel-parent',
      title: '📊 Export Run Report',
      contexts: ['page'],
    });
  });
}

/**
 * Handle context menu clicks.
 * @param {chrome.contextMenus.OnClickData} info
 * @param {chrome.tabs.Tab} tab
 * @returns {{ action: string, params: object } | null}
 */
export function handleMenuClick(info, tab) {
  const menuItemId = info.menuItemId;
  const tabId = tab?.id;
  const url = tab?.url || '';

  const handlers = {
    'sentinel-analyze': () => ({
      action: 'analyze',
      params: {
        selectionText: info.selectionText || '',
        linkUrl: info.linkUrl || '',
        pageUrl: url,
        tabId,
      },
    }),

    'sentinel-extract': () => ({
      action: 'extract',
      params: {
        selectionText: info.selectionText || '',
        tabId,
      },
    }),

    'sentinel-fill-form': () => ({
      action: 'fill_form',
      params: { tabId },
    }),

    'sentinel-screenshot': () => ({
      action: 'screenshot',
      params: { tabId },
    }),

    'sentinel-summarize': () => ({
      action: 'summarize',
      params: { pageUrl: url, tabId },
    }),

    'sentinel-monitor': () => ({
      action: 'monitor_changes',
      params: {
        selectionText: info.selectionText || '',
        tabId,
      },
    }),

    'sentinel-record': () => ({
      action: 'start_recording',
      params: { tabId },
    }),

    'sentinel-run-macro': () => ({
      action: 'run_macro',
      params: { tabId },
    }),

    'sentinel-export-report': () => ({
      action: 'export_report',
      params: { tabId },
    }),

    'sentinel-quick-assist': () => ({
      action: 'quick_assist',
      params: {
        selectionText: info.selectionText || '',
        pageUrl: url,
        tabId,
      },
    }),
  };

  const handler = handlers[menuItemId];
  return handler ? handler() : null;
}
