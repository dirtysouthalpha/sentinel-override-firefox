// popup-modules/recent-chats.js
// Recent Chats / Session Restore — v3.24.0
//
// When the side panel closes, the current chat archives to a capped-10
// recent-chats list and the visible chat clears. A new "Recent Chats" rail
// button opens a modal where the user can restore any of the last 10
// sessions — fully, including action cards, activity streams, and the
// final report — back into the chat view.
//
// Storage: chrome.storage.local.recent_chats: Array<RecentChat>
//   RecentChat = {
//     id, goal, createdAt, finishedAt?, messagesCount, hadReport,
//     runLogId?, htmlSnapshot, conversationHistory
//   }
//
// Snapshot strategy: serialize chatContainer.innerHTML so action cards,
// activity streams, reports, and banners all restore visually. Restored
// sessions are display-only — buttons inside historical action cards
// don't work (no live agent to dispatch to).

// Precompile regex patterns for performance
const REPORT_CARD_RE = /report-group|report-card-title|Investigation Report/i;
const WELCOME_MESSAGE_RE = /^\s*<div class="welcome-message"/i;

(function setupRecentChats() {
  const RECENT_MAX = 10;
  const STORAGE_KEY = 'recent_chats';

  function _genId() {
    return `rc_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  /** Extract the user's first message as the "goal" label for the session. */
  function _extractGoal(conversationHistory, fallbackHtml) {
    if (Array.isArray(conversationHistory)) {
      for (const turn of conversationHistory) {
        if (turn && turn.role === 'user' && typeof turn.text === 'string' && turn.text.trim()) {
          return turn.text.trim().substring(0, 200);
        }
      }
    }
    // Fallback: parse from HTML using DOMParser to prevent XSS
    if (typeof fallbackHtml === 'string') {
      try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(fallbackHtml, 'text/html');
        const firstUserMsg = doc.querySelector('.message-group .user-msg, .message-group [class*="user"]');
        if (firstUserMsg) return (firstUserMsg.textContent || '').trim().substring(0, 200);
      } catch { /* DOMParser may fail */ }
    }
    return '(no goal)';
  }

  /** Check if the snapshot contains the final report card (post-agent-finish). */
  function _hasReport(htmlSnapshot) {
    return typeof htmlSnapshot === 'string' && REPORT_CARD_RE.test(htmlSnapshot);
  }

  /** Capture current chat state. Called from visibilitychange / agent_finished / new-chat. */
  async function archiveCurrentChat(opts) {
    try {
      const chatContainer = document.getElementById('chat-container');
      if (!chatContainer) return null;
      const html = chatContainer.innerHTML || '';
      // Skip archiving if the chat is essentially empty (just the welcome message)
      if (html.length < 200 || WELCOME_MESSAGE_RE.test(html.trim())) {
        return null;
      }
      const state = (typeof getState === 'function') ? getState() : null;
      const convHistory = state && Array.isArray(state.conversationHistory) ? state.conversationHistory : [];

      const entry = {
        id: _genId(),
        goal: _extractGoal(convHistory, html),
        createdAt: Date.now(),
        finishedAt: opts && opts.reason === 'finished' ? Date.now() : null,
        messagesCount: convHistory.length,
        hadReport: _hasReport(html),
        runLogId: opts && opts.runLogId ? opts.runLogId : null,
        htmlSnapshot: html,
        conversationHistory: convHistory.slice(),
        archivedReason: opts && opts.reason ? opts.reason : 'manual'
      };

      const stored = await chrome.storage.local.get(STORAGE_KEY);
      const list = Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];

      // Avoid duplicate archives within 5 seconds (visibilitychange can fire
      // multiple times when user toggles between panels rapidly).
      const lastEntry = list[0];
      if (lastEntry && (Date.now() - lastEntry.createdAt) < 5000 && lastEntry.htmlSnapshot === html) {
        return lastEntry;
      }

      list.unshift(entry);
      // Cap at RECENT_MAX
      while (list.length > RECENT_MAX) list.pop();

      await chrome.storage.local.set({ [STORAGE_KEY]: list });
      return entry;
    } catch (e) {
      console.warn('[Sentinel] archiveCurrentChat failed:', getErrorMessage(e));
      return null;
    }
  }

  async function listRecentChats() {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      return Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
    } catch {
      return [];
    }
  }

  async function restoreChat(id) {
    try {
      const list = await listRecentChats();
      const entry = list.find(c => c && c.id === id);
      if (!entry) return false;
      const chatContainer = document.getElementById('chat-container');
      if (!chatContainer) return false;

      // Archive current state first (don't lose work-in-progress)
      await archiveCurrentChat({ reason: 'replaced-by-restore' });

      // Clear and restore (sanitize stored HTML — could be tampered via storage)
      chatContainer.innerHTML = (typeof sanitizeHtml === 'function')
        ? sanitizeHtml(entry.htmlSnapshot || '')
        : '';

      // Sync conversationHistory
      const state = (typeof getState === 'function') ? getState() : null;
      if (state) {
        state.conversationHistory = Array.isArray(entry.conversationHistory)
          ? entry.conversationHistory.slice()
          : [];
        // Save to chat_history so future loads keep it
        try {
          await chrome.storage.local.set({ chat_history: state.conversationHistory });
        } catch { /* storage may fail */ }
      }

      // Show restored banner at the top
      _showRestoredBanner(chatContainer, entry);

      // Scroll to bottom
      chatContainer.scrollTop = chatContainer.scrollHeight;

      return true;
    } catch (e) {
      console.warn('[Sentinel] restoreChat failed:', getErrorMessage(e));
      return false;
    }
  }

  function _showRestoredBanner(chatContainer, entry) {
    try {
      const existing = chatContainer.querySelector('.restored-banner');
      if (existing) existing.remove();
      const banner = document.createElement('div');
      banner.className = 'restored-banner';
      banner.style.cssText = 'margin: 8px 14px 4px; padding: 8px 12px; background: rgba(120,180,255,0.08); border-left: 3px solid var(--accent-primary, #ff6b00); border-radius: 4px; font-size: 11px; color: var(--text-secondary, #aaa); display: flex; align-items: center; justify-content: space-between; gap: 12px;';
      const ageMin = Math.round((Date.now() - entry.createdAt) / 60000);
      const ageStr = ageMin < 1 ? 'just now' : ageMin < 60 ? `${ageMin} min ago` : ageMin < 1440 ? `${Math.round(ageMin / 60)}h ago` : `${Math.round(ageMin / 1440)}d ago`;
      banner.innerHTML =
        `<span><strong>Restored chat</strong> · archived ${ageStr} · ${entry.messagesCount || 0} messages${entry.hadReport ? ' · had report' : ''}</span>` +
        '<button id="dismissRestoredBanner" style="background: transparent; border: 1px solid var(--border-color, rgba(255,255,255,0.15)); color: var(--text-secondary, #aaa); padding: 2px 8px; border-radius: 4px; cursor: pointer; font-size: 11px;">Dismiss</button>';
      chatContainer.insertBefore(banner, chatContainer.firstChild);
      const dismissBtn = banner.querySelector('#dismissRestoredBanner');
      if (dismissBtn) dismissBtn.addEventListener('click', () => banner.remove());
    } catch { /* DOM may be detached */ }
  }

  async function deleteRecentChat(id) {
    try {
      const list = await listRecentChats();
      const next = list.filter(c => c && c.id !== id);
      await chrome.storage.local.set({ [STORAGE_KEY]: next });
      return true;
    } catch (e) {
      console.warn('[Sentinel] deleteRecentChat failed:', getErrorMessage(e));
      return false;
    }
  }

  async function clearAllRecent() {
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: [] });
      return true;
    } catch (e) {
      console.warn('[Sentinel] clearAllRecent failed:', getErrorMessage(e));
      return false;
    }
  }

  // ========== Modal UI ==========

  function _formatAge(ts) {
    if (!ts) return '—';
    const ageMs = Date.now() - ts;
    const min = Math.round(ageMs / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min ago`;
    if (min < 1440) return `${Math.round(min / 60)}h ago`;
    return `${Math.round(min / 1440)}d ago`;
  }

  function _escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  async function _renderRecentChatsList() {
    const listEl = document.getElementById('recentChatsList');
    if (!listEl) return;
    listEl.innerHTML = '<div style="text-align:center; color:var(--text-tertiary, #888); font-size:13px; padding:24px;">Loading…</div>';
    const chats = await listRecentChats();
    if (chats.length === 0) {
      listEl.innerHTML = '<div style="text-align:center; color:var(--text-tertiary, #888); font-size:13px; padding:24px;">No recent chats yet. Start an agent run; it will be archived automatically when the side panel closes or the run finishes.</div>';
      return;
    }
    const rowsHtml = chats.reduce((acc, c) => {
      if (!c) return acc;
      const goal = _escapeHtml((c.goal || '(no goal)').substring(0, 200));
      const ageStr = _formatAge(c.createdAt);
      const stats = [
        `${c.messagesCount || 0} msgs`,
        c.hadReport ? '<span style="color: var(--success-color, #6fcf80);">report</span>' : null,
        c.runLogId ? '<span style="color: var(--accent-primary, #ff6b00);">run-logged</span>' : null,
        c.archivedReason ? c.archivedReason : null,
      ].filter(Boolean).join(' · ');
      acc.push(`
        <div class="recent-chat-row" data-id="${_escapeHtml(c.id)}" style="padding:10px 12px; border:1px solid var(--border-color); border-radius:8px; margin-bottom:8px; background:var(--bg-secondary);">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px; margin-bottom:6px;">
            <div style="flex:1; min-width:0;">
              <div style="font-size:13px; color:var(--text-primary); line-height:1.4; word-break:break-word; max-height:3.6em; overflow:hidden; text-overflow:ellipsis;">${goal}</div>
              <div style="font-size:10px; color:var(--text-tertiary); margin-top:4px;">${ageStr} · ${stats}</div>
            </div>
          </div>
          <div style="display:flex; gap:6px;">
            <button class="recent-restore-btn small-btn" data-id="${_escapeHtml(c.id)}" style="background:var(--accent-primary, #ff6b00); color:white; border-color:var(--accent-primary, #ff6b00); font-size:11px;">Restore</button>
            <button class="recent-delete-btn small-btn" data-id="${_escapeHtml(c.id)}" style="font-size:11px; color:var(--error-color, #f44); margin-left:auto;">Delete</button>
          </div>
        </div>
      `);
      return acc;
    }, []).join('');
    listEl.innerHTML = rowsHtml;
    listEl.querySelectorAll('.recent-restore-btn').forEach(b => {
      b.addEventListener('click', async () => {
        const ok = await restoreChat(b.dataset.id);
        if (ok) {
          _closeModal();
        } else {
          try { showToast('Failed to restore chat', 'error'); } catch { /* showToast may fail in detached popup */ }
        }
      });
    });
    listEl.querySelectorAll('.recent-delete-btn').forEach(b => {
      b.addEventListener('click', async () => {
        if (!confirm('Delete this archived chat? Cannot be undone.')) return;
        await deleteRecentChat(b.dataset.id);
        await _renderRecentChatsList();
      });
    });
  }

  function _openModal() {
    const modal = document.getElementById('recent-chats-modal');
    if (!modal) return;
    modal.classList.add('show');
    _renderRecentChatsList();
  }
  function _closeModal() {
    const modal = document.getElementById('recent-chats-modal');
    if (modal) modal.classList.remove('show');
  }

  // ========== Lifecycle Hooks ==========

  // Archive on side-panel-close. visibilitychange fires when the panel is
  // hidden (closed or navigated away from). Run synchronously enough to
  // complete before the popup unloads. chrome.storage writes are queued
  // even if the document is going away.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      archiveCurrentChat({ reason: 'panel-closed' });
    }
  });

  // Archive on beforeunload as a belt-and-suspenders for hard closes.
  window.addEventListener('beforeunload', () => {
    archiveCurrentChat({ reason: 'unload' });
  });

  // Wire up the modal close buttons + rail button on DOM ready.
  function _wireUI() {
    const railBtn = document.getElementById('recentChatsRailBtn');
    if (railBtn) railBtn.addEventListener('click', _openModal);
    const close1 = document.getElementById('closeRecentChatsBtn');
    const close2 = document.getElementById('closeRecentChatsBtn2');
    const clearBtn = document.getElementById('recentChatsClearBtn');
    if (close1) close1.addEventListener('click', _closeModal);
    if (close2) close2.addEventListener('click', _closeModal);
    if (clearBtn) clearBtn.addEventListener('click', async () => {
      if (!confirm('Delete ALL archived chats? Cannot be undone.')) return;
      await clearAllRecent();
      await _renderRecentChatsList();
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _wireUI);
  } else {
    _wireUI();
  }

  // Expose for chat.js to call on agent_finished
  try {
    window.__sentinelRecentChats = {
      archive: archiveCurrentChat,
      list: listRecentChats,
      restore: restoreChat,
      remove: deleteRecentChat,
      clear: clearAllRecent,
      openModal: _openModal
    };
  } catch { /* module init may fail in detached popup */ }
})();
