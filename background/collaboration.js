// Sentinel Override v3 -- Collaboration & Export
// Template export/import with safety validation, report markdown export,
// format versioning for forward compatibility.
// Layer 2 module -- imports only from template-manager.js.

import { listTemplates, getTemplate, loadTemplates, saveTemplates, extractParameters } from './template-manager.js';

// ========== Format Version ==========
const FORMAT_VERSION = '1.0.0';
const MIN_COMPATIBLE_VERSION = '1.0.0';

// ========== Dangerous Pattern Detection ==========
const DANGEROUS_PATTERNS = [
  { pattern: /execute_js/i, reason: 'execute_js allows arbitrary JavaScript execution via new Function()' },
  { pattern: /eval\s*\(/i, reason: 'eval() executes arbitrary code' },
  { pattern: /new\s+Function\s*\(/i, reason: 'new Function() creates executable code from strings' },
  { pattern: /document\.cookie/i, reason: 'Direct cookie access may steal session data' },
  { pattern: /chrome\.storage\.local\.set.*password/i, reason: 'Attempts to exfiltrate passwords to storage' },
  { pattern: /fetch\s*\(\s*['"][^'"]*password/i, reason: 'Attempts to send passwords to external servers' },
  { pattern: /XMLHttpRequest.*password/i, reason: 'Attempts to send passwords via XHR' },
];

// ========== Template Export ==========

/**
 * Export a single template as a shareable JSON object.
 * Strips internal metadata (id, timestamps, runCount) for clean sharing.
 *
 * @param {string} templateId
 * @returns {Promise<object>} Exportable template package
 */
export async function exportTemplate(templateId) {
  if (!templateId || typeof templateId !== 'string') {
    throw new Error('Template ID is required');
  }

  const template = await getTemplate(templateId);
  if (!template) {
    throw new Error(`Template not found: ${templateId}`);
  }

  return {
    format: 'sentinel-template',
    version: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    template: {
      name: template.name,
      goal: template.goal,
      params: template.params || [],
      tags: template.tags || [],
    },
  };
}

/**
 * Export all templates as a batch JSON object.
 *
 * @returns {Promise<object>} Exportable batch package
 */
export async function exportAllTemplates() {
  const templates = await listTemplates();

  return {
    format: 'sentinel-template-batch',
    version: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    count: templates.length,
    templates: templates.map(t => ({
      name: t.name,
      goal: t.goal,
      params: t.params || [],
      tags: t.tags || [],
    })),
  };
}

// ========== Template Import ==========

/**
 * Validate an imported template for safety.
 * Checks format version and scans for dangerous patterns.
 *
 * @param {object} importedData - Parsed JSON from file
 * @returns {{ safe: boolean, warnings: string[], errors: string[], template?: object, version?: string }}
 */
export function validateImport(importedData) {
  const result = { safe: false, warnings: [], errors: [], version: null };

  if (!importedData || typeof importedData !== 'object' || Array.isArray(importedData)) {
    result.errors.push('Invalid file: not a JSON object');
    return result;
  }

  // Check format field
  if (importedData.format !== 'sentinel-template' && importedData.format !== 'sentinel-template-batch') {
    result.errors.push('Invalid format: expected sentinel-template or sentinel-template-batch');
    return result;
  }

  // Check version
  result.version = importedData.version;
  if (!importedData.version || typeof importedData.version !== 'string') {
    result.errors.push('Missing format version');
    return result;
  }

  // Version compatibility check
  const imported = parseVersion(importedData.version);
  const minimum = parseVersion(MIN_COMPATIBLE_VERSION);
  if (imported.major < minimum.major) {
    result.errors.push(`Format version ${importedData.version} is too old. Minimum: ${MIN_COMPATIBLE_VERSION}`);
    return result;
  }
  if (imported.major > minimum.major) {
    result.warnings.push(`Format version ${importedData.version} is newer than this extension supports (${FORMAT_VERSION}). Some fields may be ignored.`);
  }

  // Extract templates array
  const templates = importedData.format === 'sentinel-template-batch'
    ? (Array.isArray(importedData.templates) ? importedData.templates : [])
    : (importedData.template ? [importedData.template] : []);

  if (!templates.length) {
    result.errors.push('No templates found in file');
    return result;
  }

  // Validate each template
  const validated = [];
  templates.forEach((t, i) => {
    if (!t.name || typeof t.name !== 'string' || !t.name.trim()) {
      result.errors.push(`Template ${i + 1}: missing name`);
      return;
    }
    if (!t.goal || typeof t.goal !== 'string' || !t.goal.trim()) {
      result.errors.push(`Template "${t.name}": missing goal`);
      return;
    }

    // Safety scan
    const scanResult = scanForDangerousPatterns(t.goal);
    if (scanResult.length) {
      result.errors.push(`Template "${t.name}": ${scanResult.map(s => s.reason).join('; ')}`);
      return;
    }

    // Also scan tag values
    let hasDangerousTag = false;
    if (Array.isArray(t.tags)) {
      t.tags.forEach(tag => {
        const tagScan = scanForDangerousPatterns(typeof tag === 'string' ? tag : String(tag));
        if (tagScan.length) {
          result.errors.push(`Template "${t.name}" tag "${tag}": ${tagScan.map(s => s.reason).join('; ')}`);
          hasDangerousTag = true;
        }
      });
    }
    if (hasDangerousTag) return;

    // Build clean template
    const params = Array.isArray(t.params) ? t.params : extractParameters(t.goal);
    validated.push({
      name: t.name.trim(),
      goal: t.goal,
      params,
      tags: Array.isArray(t.tags) ? t.tags : [],
    });
  });

  result.templates = validated;
  result.safe = !result.errors.length && !!validated.length;
  return result;
}

/**
 * Import validated templates, handling ID conflicts.
 *
 * @param {Array<object>} templates - Validated template objects from validateImport
 * @param {'skip' | 'rename' | 'overwrite'} conflictMode - How to handle existing IDs
 * @returns {Promise<{ imported: number, skipped: number, renamed: number, overwritten: number, results: Array }>}
 */
export async function importTemplates(templates, conflictMode = 'skip') {
  if (!Array.isArray(templates)) return { imported: 0, skipped: 0, renamed: 0, overwritten: 0, results: [] };
  const existing = await loadTemplates();
  const existingNames = new Map();
  for (const t of Object.values(existing)) {
    if (t && t.name) {
      existingNames.set(t.name.toLowerCase(), t.id);
    }
  }

  const results = [];
  let imported = 0, skipped = 0, renamed = 0, overwritten = 0;

  for (const template of templates) {
    if (!template || !template.name || typeof template.name !== 'string') {
      results.push({ name: template?.name || '(unknown)', action: 'skipped', reason: 'Invalid template: missing or invalid name' });
      skipped++;
      continue;
    }
    const nameKey = template.name.toLowerCase();
    const existingId = existingNames.get(nameKey);

    if (existingId) {
      switch (conflictMode) {
        case 'skip':
          results.push({ name: template.name, action: 'skipped', reason: 'Template with same name already exists' });
          skipped++;
          continue;
        case 'rename': {
          let counter = 1;
          let newName = template.name;
          while (existingNames.has(newName.toLowerCase())) {
            newName = `${template.name} (${counter++})`;
          }
          const newTemplate = {
            ...template,
            name: newName,
          };
          const id = crypto.randomUUID();
          existing[id] = {
            id,
            name: newTemplate.name,
            goal: newTemplate.goal,
            params: newTemplate.params,
            tags: newTemplate.tags,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            lastUsedAt: null,
            runCount: 0,
          };
          existingNames.set(newName.toLowerCase(), id);
          results.push({ name: newTemplate.name, action: 'renamed', originalName: template.name });
          renamed++;
          imported++;
          continue;
        }
        case 'overwrite':
          existing[existingId] = {
            ...existing[existingId],
            name: template.name,
            goal: template.goal,
            params: template.params,
            tags: template.tags,
            updatedAt: Date.now(),
          };
          results.push({ name: template.name, action: 'overwritten' });
          overwritten++;
          imported++;
          continue;
      }
    }

    // No conflict -- create new
    const id = crypto.randomUUID();
    existing[id] = {
      id,
      name: template.name,
      goal: template.goal,
      params: template.params,
      tags: template.tags,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastUsedAt: null,
      runCount: 0,
    };
    existingNames.set(nameKey, id);
    results.push({ name: template.name, action: 'imported' });
    imported++;
  }

  await saveTemplates(existing);
  return { imported, skipped, renamed, overwritten, results };
}

// ========== Report Export ==========

/**
 * Export an investigation report as a markdown string with metadata header.
 *
 * @param {{ summary: string, fullReport: string, goal: string, timestamp: string }} report
 * @returns {string} Complete markdown file content
 */
export function exportReportAsMarkdown(report) {
  if (!report || !report.fullReport) {
    throw new Error('No report data provided');
  }

  const header = [
    '---',
    `generator: sentinel-override`,
    `format-version: ${FORMAT_VERSION}`,
    `exported-at: ${new Date().toISOString()}`,
    `goal: ${escapeYaml(report.goal || 'Unknown')}`,
    `timestamp: ${escapeYaml(report.timestamp || '')}`,
    `summary: ${escapeYaml(report.summary || '')}`,
    '---',
    '',
  ].join('\n');

  return header + report.fullReport;
}

// ========== Safety Scanning ==========

/**
 * Scan text for dangerous patterns that could be used for code injection.
 *
 * @param {string} text
 * @returns {Array<{pattern: RegExp, reason: string}>}
 */
function scanForDangerousPatterns(text) {
  const found = [];
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(text)) {
      found.push({ pattern, reason });
    }
  }
  return found;
}

// ========== Version Utilities ==========

/**
 * Parse a semver-like version string into { major, minor, patch }.
 */
function parseVersion(version) {
  const parts = (version || '0.0.0').split('.').map(p => {
    const num = parseInt(p, 10);
    return Number.isNaN(num) ? 0 : num;
  });
  return {
    major: parts[0] || 0,
    minor: parts[1] || 0,
    patch: parts[2] || 0,
  };
}

/**
 * Escape a string for YAML frontmatter.
 */
function escapeYaml(str) {
  if (!str) return '""';
  return `"${String(str).replace(/"/g, '\\"')}"`;
}
