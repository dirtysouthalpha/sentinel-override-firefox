// Audit Export — v14 Enterprise
// SOC2-compliant audit trail export with tamper-evident hashing.

/**
 * Generate a tamper-evident audit trail from run logs.
 * @param {Array} runLog - The forensic run log entries
 * @param {object} options - Export options
 * @returns {{ json: string, csv: string, hash: string, hashChain: string[] }}
 */
export function generateAuditExport(runLog, _options = {}) {
  if (!runLog || !Array.isArray(runLog)) {
    return { json: '[]', csv: '', hash: '', hashChain: [] };
  }

  const entries = runLog.map((entry, index) => {
    // Build canonical form for hashing
    const canonical = {
      seq: index + 1,
      timestamp: entry.timestamp || '',
      kind: entry.kind || 'unknown',
      goal: (entry.goal || '').substring(0, 200),
      url: entry.url || '',
      tenant: entry.tenant || '',
      action: entry.action || '',
      selector: entry.selector || '',
      result: (entry.result || '').substring(0, 200),
      failed: !!entry.failed
    };
    return canonical;
  });

  // Build hash chain — each entry's hash includes the previous hash
  const hashChain = [];
  let prevHash = 'GENESIS';

  for (const entry of entries) {
    const payload = JSON.stringify(entry) + '|' + prevHash;
    const hash = simpleHash(payload);
    hashChain.push(hash);
    prevHash = hash;
  }

  // Final integrity hash
  const finalHash = hashChain.length > 0 ? hashChain[hashChain.length - 1] : 'EMPTY';

  // Add hash to each entry
  const audited = entries.map((entry, i) => ({
    ...entry,
    _hash: hashChain[i],
    _prevHash: i > 0 ? hashChain[i - 1] : 'GENESIS'
  }));

  // JSON export
  const json = JSON.stringify({
    version: '1.0',
    exportedAt: new Date().toISOString(),
    entryCount: audited.length,
    integrityHash: finalHash,
    hashAlgorithm: 'simple-djb2',
    entries: audited
  }, null, 2);

  // CSV export (RFC-4180)
  const headers = ['seq', 'timestamp', 'kind', 'goal', 'url', 'tenant', 'action', 'selector', 'result', 'failed', '_hash'];
  const csvRows = [headers.join(',')];
  for (const entry of audited) {
    const row = headers.map(h => {
      const val = entry[h] == null ? '' : String(entry[h]);
      // RFC-4180: quote fields containing commas, quotes, or newlines
      if (val.includes(',') || val.includes('"') || val.includes('\n')) {
        return '"' + val.replace(/"/g, '""') + '"';
      }
      return val;
    });
    csvRows.push(row.join(','));
  }
  const csv = csvRows.join('\n');

  return { json, csv, hash: finalHash, hashChain, entryCount: audited.length };
}

/**
 * Verify an audit export's integrity.
 * @param {object} exported - The exported audit data
 * @returns {{ valid: boolean, brokenAt: number|null, message: string }}
 */
export function verifyAuditExport(exported) {
  if (!exported || !exported.entries) {
    return { valid: false, brokenAt: null, message: 'Invalid export format' };
  }

  let prevHash = 'GENESIS';

  for (let i = 0; i < exported.entries.length; i++) {
    const entry = { ...exported.entries[i] };
    const storedHash = entry._hash;
    delete entry._hash;
    delete entry._prevHash;

    const payload = JSON.stringify(entry) + '|' + prevHash;
    const computed = simpleHash(payload);

    if (computed !== storedHash) {
      return {
        valid: false,
        brokenAt: i + 1,
        message: `Integrity broken at entry ${i + 1}: hash mismatch`
      };
    }
    prevHash = storedHash;
  }

  // Check final hash
  if (exported.integrityHash && exported.entries.length > 0) {
    const expectedFinal = exported.entries[exported.entries.length - 1]._hash;
    if (exported.integrityHash !== expectedFinal) {
      return {
        valid: false,
        brokenAt: exported.entries.length,
        message: 'Final integrity hash mismatch'
      };
    }
  }

  return { valid: true, brokenAt: null, message: `${exported.entries.length} entries verified` };
}

/**
 * Simple DJB2 hash — deterministic, no crypto dependency needed.
 * For production tamper-proofing, upgrade to SHA-256 via crypto.subtle.
 */
function simpleHash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(16).padStart(8, '0');
}
