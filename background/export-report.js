/**
 * Sentinel Override — Export run report as HTML.
 * Generates a sharable, styled HTML report from the audit log.
 */

/**
 * Generate a styled, self-contained HTML report from an audit log and run metadata.
 * @param {Array<Object>} auditLog - Array of audit log entry objects.
 * @param {Object} metadata - Run metadata (goal, startTime, endTime, totalSteps, status, trustScore).
 * @returns {string} Complete HTML document string ready for download.
 */
export function generateHtmlReport(auditLog, metadata) {
  const {
    goal = 'Unknown',
    startTime,
    endTime,
    totalSteps = 0,
    status = 'completed',
    trustScore = null,
  } = metadata || {};

  const duration = startTime && endTime
    ? Math.round((new Date(endTime) - new Date(startTime)) / 1000)
    : 0;
  const durationStr = duration > 60
    ? `${Math.floor(duration / 60)}m ${duration % 60}s`
    : `${duration}s`;

  const steps = (auditLog || []).map((entry, i) => {
    const stepClass = entry.actionFailed ? 'step-failed' : 'step-ok';
    const icon = entry.actionFailed ? '❌' : '✅';
    const actionName = entry.action?.type || entry.action || 'unknown';
    const params = entry.action?.params
      ? Object.entries(entry.action.params)
          .map(([k, v]) => `<span class="param"><strong>${escapeHtml(k)}:</strong> ${escapeHtml(truncate(String(v), 60))}</span>`)
          .join(', ')
      : '';
    const screenshot = entry.screenshot
      ? `<div class="screenshot"><img src="${escapeHtml(entry.screenshot)}" alt="Step ${i + 1}" loading="lazy" /></div>`
      : '';
    const result = entry.result
      ? `<div class="result">${escapeHtml(truncate(String(entry.result), 200))}</div>`
      : '';

    return `
      <div class="step ${stepClass}">
        <div class="step-header">
          <span class="step-icon">${icon}</span>
          <span class="step-num">#${i + 1}</span>
          <span class="step-action">${escapeHtml(String(actionName))}</span>
          ${params ? `<span class="step-params">${params}</span>` : ''}
          <span class="step-time">${entry.duration ? `${entry.duration}ms` : ''}</span>
        </div>
        ${result}
        ${screenshot}
      </div>`;
  }).join('');

  const trustBadge = trustScore !== null
    ? `<div class="trust-badge trust-${trustScore >= 80 ? 'high' : trustScore >= 50 ? 'mid' : 'low'}">
        Trust: ${trustScore}%
      </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sentinel Override — Run Report</title>
  <style>
    :root {
      --bg: #0f172a;
      --surface: #1e293b;
      --border: #334155;
      --text: #e2e8f0;
      --muted: #94a3b8;
      --brand: #818cf8;
      --success: #34d399;
      --error: #f87171;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; }
    .container { max-width: 800px; margin: 0 auto; padding: 2rem; }
    .header { border-bottom: 1px solid var(--border); padding-bottom: 1.5rem; margin-bottom: 2rem; }
    .header h1 { font-size: 1.5rem; font-weight: 700; display: flex; align-items: center; gap: 0.5rem; }
    .header h1 span { color: var(--brand); }
    .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 1rem; margin-top: 1rem; }
    .meta-item { background: var(--surface); padding: 0.75rem; border-radius: 8px; border: 1px solid var(--border); }
    .meta-item .label { font-size: 0.75rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
    .meta-item .value { font-size: 1.1rem; font-weight: 600; margin-top: 0.25rem; }
    .goal { background: var(--surface); padding: 1rem; border-radius: 8px; border-left: 3px solid var(--brand); margin-bottom: 2rem; }
    .goal strong { color: var(--brand); }
    .steps { display: flex; flex-direction: column; gap: 0.75rem; }
    .step { background: var(--surface); border-radius: 8px; padding: 0.75rem 1rem; border: 1px solid var(--border); }
    .step-failed { border-color: var(--error); border-left: 3px solid var(--error); }
    .step-ok { border-left: 3px solid var(--success); }
    .step-header { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
    .step-icon { font-size: 0.9rem; }
    .step-num { color: var(--muted); font-size: 0.8rem; }
    .step-action { font-weight: 600; color: var(--brand); }
    .step-params { font-size: 0.8rem; color: var(--muted); }
    .step-params .param { margin-right: 0.5rem; }
    .step-time { margin-left: auto; font-size: 0.75rem; color: var(--muted); }
    .result { font-size: 0.85rem; color: var(--muted); margin-top: 0.5rem; padding: 0.5rem; background: rgba(0,0,0,0.2); border-radius: 4px; max-height: 100px; overflow: hidden; }
    .screenshot { margin-top: 0.5rem; }
    .screenshot img { max-width: 100%; border-radius: 4px; border: 1px solid var(--border); }
    .trust-badge { display: inline-block; padding: 0.25rem 0.75rem; border-radius: 99px; font-size: 0.8rem; font-weight: 600; }
    .trust-high { background: rgba(52, 211, 153, 0.15); color: var(--success); }
    .trust-mid { background: rgba(251, 191, 36, 0.15); color: #fbbf24; }
    .trust-low { background: rgba(248, 113, 113, 0.15); color: var(--error); }
    .footer { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--border); font-size: 0.8rem; color: var(--muted); text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🛡️ Sentinel <span>Override</span> — Run Report</h1>
      ${trustBadge}
      <div class="meta">
        <div class="meta-item">
          <div class="label">Steps</div>
          <div class="value">${totalSteps}</div>
        </div>
        <div class="meta-item">
          <div class="label">Duration</div>
          <div class="value">${durationStr}</div>
        </div>
        <div class="meta-item">
          <div class="label">Status</div>
          <div class="value">${escapeHtml(status)}</div>
        </div>
        <div class="meta-item">
          <div class="label">Date</div>
          <div class="value">${startTime ? new Date(startTime).toLocaleDateString() : 'N/A'}</div>
        </div>
      </div>
    </div>
    <div class="goal">
      <strong>Goal:</strong> ${escapeHtml(goal)}
    </div>
    <div class="steps">
      ${steps}
    </div>
    <div class="footer">
      Generated by Sentinel Override v4.0.0 · ${new Date().toISOString()}
    </div>
  </div>
</body>
</html>`;
}

/**
 * (9.3) Generate an interactive HTML replay report from a run log buffer.
 * Shows screenshots + action + reasoning as a chronological timeline that
 * teammates can open in any browser to replay the exact run.
 *
 * @param {Array<Object>} entries - runLogBuffer entries
 * @param {Object} meta - { goal, runLogId, estimatedCostUsd }
 * @returns {string} Complete self-contained HTML document
 */
export function generateReplayReport(entries, meta) {
  const { goal = 'Unknown', runLogId = '', estimatedCostUsd = 0 } = meta || {};
  const actionEntries = (entries || []).filter(e => e && e.kind === 'action');
  const startTs = entries?.[0]?.timestamp ? new Date(entries[0].timestamp).toLocaleString() : '';
  const costStr = estimatedCostUsd > 0 ? `~$${estimatedCostUsd.toFixed(estimatedCostUsd < 0.01 ? 4 : 3)}` : '';

  const steps = actionEntries.map((e, i) => {
    const num = e.step || i + 1;
    const failed = !!e.failed;
    const icon = failed ? '❌' : '✅';
    const borderColor = failed ? '#f87171' : '#34d399';
    const actionType = e.action_type || 'unknown';
    const a = e.action || {};
    let detail = '';
    if (a.url) detail = truncate(a.url, 70);
    else if (a.text) detail = `"${truncate(a.text, 60)}"`;
    else if (a.key) detail = `key: ${a.key}`;
    else if (a.selector) detail = truncate(a.selector, 60);

    const screenshotHtml = e.screenshot
      ? `<div style="margin-top:8px;"><img src="data:image/jpeg;base64,${escapeHtml(e.screenshot)}" style="max-width:100%;border-radius:4px;border:1px solid #334155;" loading="lazy" alt="Step ${num}" /></div>`
      : '';
    const reasoningHtml = e.reasoning
      ? `<details style="margin-top:6px;font-size:11px;color:#94a3b8;"><summary style="cursor:pointer;">🧠 Reasoning</summary><div style="margin-top:4px;padding:6px;background:rgba(0,0,0,0.3);border-radius:4px;white-space:pre-wrap;">${escapeHtml(e.reasoning)}</div></details>`
      : '';
    const resultHtml = e.result
      ? `<div style="margin-top:4px;font-size:11px;color:#94a3b8;padding:4px 6px;background:rgba(0,0,0,0.2);border-radius:3px;">${escapeHtml(truncate(e.result, 200))}</div>`
      : '';

    return `<div style="background:#1e293b;border-radius:8px;padding:12px 14px;border:1px solid #334155;border-left:3px solid ${borderColor};margin-bottom:10px;">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <span>${icon}</span>
        <span style="color:#94a3b8;font-size:12px;">#${num}</span>
        <span style="font-weight:600;color:#818cf8;">${escapeHtml(actionType)}</span>
        ${detail ? `<span style="font-size:12px;color:#94a3b8;">${escapeHtml(detail)}</span>` : ''}
        <span style="margin-left:auto;font-size:11px;color:#64748b;">${e.url ? (() => { try { return new URL(e.url).hostname; } catch(_) { return ''; } })() : ''}</span>
      </div>
      ${resultHtml}
      ${reasoningHtml}
      ${screenshotHtml}
    </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Sentinel Override — Run Replay</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:#0f172a; color:#e2e8f0; line-height:1.6; }
.container { max-width:820px; margin:0 auto; padding:2rem; }
</style>
</head>
<body>
<div class="container">
  <div style="border-bottom:1px solid #334155;padding-bottom:1rem;margin-bottom:1.5rem;">
    <h1 style="font-size:1.4rem;font-weight:700;">🛡️ Sentinel <span style="color:#818cf8;">Override</span> — Run Replay</h1>
    <div style="margin-top:8px;font-size:13px;color:#94a3b8;">${startTs}${costStr ? ` &nbsp;·&nbsp; Cost: ${escapeHtml(costStr)}` : ''}${runLogId ? ` &nbsp;·&nbsp; Run ID: ${escapeHtml(runLogId.substring(0, 8))}…` : ''}</div>
  </div>
  <div style="background:#1e293b;padding:10px 14px;border-radius:6px;border-left:3px solid #818cf8;margin-bottom:1.5rem;font-size:13px;">
    <strong style="color:#818cf8;">Goal:</strong> ${escapeHtml(goal)}
  </div>
  <div>${steps}</div>
  <div style="margin-top:1.5rem;padding-top:1rem;border-top:1px solid #334155;font-size:11px;color:#64748b;text-align:center;">
    Generated by Sentinel Override · ${new Date().toISOString()}
  </div>
</div>
</body>
</html>`;
}

// Precompiled regex for HTML escaping (performance optimization)
const HTML_ESCAPE_RE = /[&<>'"]/g;

/**
 * Escape HTML special characters to prevent XSS in generated reports.
 * @param {string} str - Raw string to escape.
 * @returns {string} HTML-safe string.
 */
function escapeHtml(str) {
  const s = (str == null) ? '' : String(str);
  return s.replace(HTML_ESCAPE_RE, (char) => {
    if (char === '&') return '&amp;';
    if (char === '<') return '&lt;';
    if (char === '>') return '&gt;';
    if (char === '"') return '&quot;';
    return '&#39;';
  });
}

/**
 * Truncate a string to a maximum length, appending an ellipsis if truncated.
 * @param {string} str - String to potentially truncate.
 * @param {number} max - Maximum character length.
 * @returns {string} Original or truncated string.
 */
function truncate(str, max) {
  const s = (str == null) ? '' : String(str);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
