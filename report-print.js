
function sanitizeHtml(dirty) {
  if (!dirty) return '';
  var div = document.createElement('div');
  div.innerHTML = dirty;
  var scripts = div.querySelectorAll('script');
  for (var i = 0; i < scripts.length; i++) scripts[i].remove();
  var all = div.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    var attrs = el.attributes;
    for (var j = attrs.length - 1; j >= 0; j--) {
      var name = attrs[j].name.toLowerCase();
      var value = attrs[j].value.toLowerCase();
      if (name.startsWith('on') || value.startsWith('javascript:')) {
        el.removeAttribute(attrs[j].name);
      }
    }
  }
  return div.innerHTML;
}
(async function() {
      try {
        const stored = await chrome.storage.local.get(['_pendingPrintReport']);
        const data = stored && stored._pendingPrintReport;
        if (!data || !data.fullReport) {
          document.getElementById('reportBody').innerHTML = '<div class="loading" style="color:#b00;">No report available to print. Generate a report first, then click Export PDF.</div>';
          return;
        }
        const goalEl = document.getElementById('reportGoal');
        const tsEl = document.getElementById('reportTimestamp');
        if (goalEl) goalEl.textContent = data.goal || '';
        if (tsEl) tsEl.textContent = data.timestamp ? new Date(data.timestamp).toLocaleString() : '';

        // Render markdown -> HTML
        const html = window.marked && window.marked.parse
          ? window.marked.parse(data.fullReport)
          : data.fullReport.replace(/</g, '&lt;');

        // Decorate [src:key] / [unverified] markers as small inline chips
        // for paper-friendly auditability.
        const decorated = html
          .replace(/\[src:([a-z0-9_\-]+)\]/gi, '<span class="src-chip">$1</span>')
          .replace(/\[unverified\]/gi, '<span class="src-unverified">unverified</span>');

        document.getElementById('reportBody').innerHTML = sanitizeHtml(decorated);

        // Trigger the print dialog after a brief render delay so styles
        // apply and the user sees the page first.
        setTimeout(() => { window.print(); }, 350);
      } catch (e) {
        document.getElementById('reportBody').innerHTML = '<div class="loading" style="color:#b00;">Error loading report: ' + (e && e.message ? e.message : e) + '</div>';
      }
    })();