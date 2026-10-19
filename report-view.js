/* global sanitizeHtml */
// Theme: respect the user's theme-preference from the popup if available;
    // default to dark for a comfortable reading experience.
    (function initTheme() {
      try {
        chrome.storage.local.get(['theme-preference'], (r) => {
          if (r && r['theme-preference'] === 'light') {
            document.documentElement.classList.add('light-mode');
          }
        });
      } catch (_e) {
        // localStorage fallback
        try {
          if (localStorage.getItem('theme-preference') === 'light') {
            document.documentElement.classList.add('light-mode');
          }
        } catch (_ee) {}
      }
    })();

    function escapeHtml(s) {
      return String(s || '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      })[c]);
    }

    let __currentReport = null;

    (async function loadReport() {
      try {
        const stored = await chrome.storage.local.get(['_pendingViewReport', '_pendingPrintReport', 'last_agent_report']);
        // Prefer the view-specific key, fall back to print key, fall back to last_agent_report
        const data = (stored && stored._pendingViewReport) ||
                     (stored && stored._pendingPrintReport) ||
                     (stored && stored.last_agent_report);
        if (!data || !data.fullReport) {
          document.getElementById('reportBody').innerHTML =
            '<div class="loading" style="color:var(--warn-text);">No report available. Run an agent task first, then click "View Full Report".</div>';
          return;
        }
        __currentReport = data;
        const goalEl = document.getElementById('reportGoal');
        const tsEl = document.getElementById('reportTimestamp');
        const banner = document.getElementById('goalBanner');
        if (data.goal) {
          goalEl.textContent = data.goal;
          banner.style.display = 'block';
        }
        if (data.timestamp) tsEl.textContent = new Date(data.timestamp).toLocaleString();

        const html = window.marked && window.marked.parse
          ? window.marked.parse(data.fullReport)
          : escapeHtml(data.fullReport).replace(/\n/g, '<br>');

        // Decorate [src:key] / [unverified] markers as inline chips for
        // audit trail visibility.
        const decorated = html
          .replace(/\[src:([a-z0-9_-]+)\]/gi, '<span class="src-chip" title="Source: $1">$1</span>')
          .replace(/\[unverified\]/gi, '<span class="src-unverified">unverified</span>');

        document.getElementById('reportBody').innerHTML = sanitizeHtml(decorated);
        document.title = 'Sentinel Override — ' + (data.goal ? data.goal.substring(0, 60) : 'Investigation Report');
      } catch (e) {
        document.getElementById('reportBody').innerHTML =
          '<div class="loading" style="color:var(--warn-text);">Error loading report: ' +
          escapeHtml(e && e.message ? e.message : String(e)) + '</div>';
      }
    })();

    // Button wiring
    document.getElementById('copyMdBtn').addEventListener('click', async () => {
      if (!__currentReport || !__currentReport.fullReport) return;
      try {
        await navigator.clipboard.writeText(__currentReport.fullReport);
        const btn = document.getElementById('copyMdBtn');
        const orig = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = orig; }, 1500);
      } catch (e) {
        alert('Copy failed: ' + (e && e.message ? e.message : e));
      }
    });

    document.getElementById('downloadMdBtn').addEventListener('click', () => {
      if (!__currentReport || !__currentReport.fullReport) return;
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
      const filename = `sentinel-report-${timestamp}.md`;
      const blob = new Blob([__currentReport.fullReport], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    });

    document.getElementById('downloadJsonBtn').addEventListener('click', () => {
      if (!__currentReport || !__currentReport.structuredData) return;
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
      const filename = `sentinel-report-${timestamp}.json`;
      const json = JSON.stringify(__currentReport.structuredData, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    });

    document.getElementById('printBtn').addEventListener('click', () => {
      window.print();
    });

    document.getElementById('themeBtn').addEventListener('click', () => {
      document.documentElement.classList.toggle('light-mode');
      try {
        const isLight = document.documentElement.classList.contains('light-mode');
        chrome.storage.local.set({ 'theme-preference': isLight ? 'light' : 'dark' });
      } catch (_e) {}
    });