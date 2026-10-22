// background/plugin-registry.js
// Plugin system for Sentinel Override — install, toggle, conflict detection.
// PLG-01 through PLG-05.

const STORAGE_KEY = 'installed_plugins';
const REGISTRY_URL_KEY = 'plugin_registry_url';
const DEFAULT_REGISTRY_URL = 'https://registry.sentinel.dev/plugins.json';
const MIN_SENTINEL_VERSION = '15.0.0';

// ========== Storage helpers ==========

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result);
    });
  });
}

function storageSet(data) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(data, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

// ========== Semver comparison ==========

function compareSemver(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ========== Registry URL (PLG-01) ==========

export async function getRegistryUrl() {
  const result = await storageGet([REGISTRY_URL_KEY]);
  return result[REGISTRY_URL_KEY] || DEFAULT_REGISTRY_URL;
}

export async function setRegistryUrl(url) {
  if (!url || typeof url !== 'string') {
    throw new Error('Registry URL must be a non-empty string');
  }
  await storageSet({ [REGISTRY_URL_KEY]: url });
  console.log('[PLUGIN-REGISTRY] Registry URL set to:', url);
}

// ========== Registry fetch (PLG-02) ==========

export async function fetchRegistry() {
  const url = await getRegistryUrl();
  console.log('[PLUGIN-REGISTRY] Fetching registry from:', url);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error('Registry fetch failed: ' + response.status + ' ' + response.statusText);
  }
  const data = await response.json();
  if (!Array.isArray(data)) {
    throw new Error('Registry must return an array of plugin manifests');
  }
  return data;
}

// ========== Install/Uninstall (PLG-02, PLG-03) ==========

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Invalid manifest: must be an object');
  }
  const required = ['id', 'name', 'version', 'entryUrl'];
  for (const field of required) {
    if (!manifest[field]) {
      throw new Error('Invalid manifest: missing required field "' + field + '"');
    }
  }
  // Semantic version check
  if (manifest.minSentinelVersion && typeof manifest.minSentinelVersion === 'string' && compareSemver(manifest.minSentinelVersion, MIN_SENTINEL_VERSION) > 0) {
    throw new Error('Plugin requires Sentinel v' + manifest.minSentinelVersion + ', current is v' + MIN_SENTINEL_VERSION);
  }
  return true;
}

export async function installPlugin(manifestUrl) {
  console.log('[PLUGIN-REGISTRY] Installing plugin from:', manifestUrl);
  const response = await fetch(manifestUrl);
  if (!response.ok) {
    throw new Error('Failed to fetch manifest: ' + response.status);
  }
  const manifest = await response.json();
  validateManifest(manifest);

  const result = await storageGet([STORAGE_KEY]);
  const plugins = result[STORAGE_KEY] || {};

  if (plugins[manifest.id]) {
    console.warn('[PLUGIN-REGISTRY] Plugin already installed, updating:', manifest.id);
  }

  plugins[manifest.id] = {
    ...manifest,
    installedAt: Date.now(),
    active: false
  };

  await storageSet({ [STORAGE_KEY]: plugins });
  console.log('[PLUGIN-REGISTRY] Plugin installed:', manifest.id, 'v' + manifest.version);
  return manifest.id;
}

export async function uninstallPlugin(pluginId) {
  console.log('[PLUGIN-REGISTRY] Uninstalling plugin:', pluginId);
  const result = await storageGet([STORAGE_KEY]);
  const plugins = result[STORAGE_KEY] || {};

  if (!plugins[pluginId]) {
    console.warn('[PLUGIN-REGISTRY] Plugin not found:', pluginId);
    return;
  }

  delete plugins[pluginId];
  await storageSet({ [STORAGE_KEY]: plugins });
  console.log('[PLUGIN-REGISTRY] Plugin uninstalled:', pluginId);
}

// ========== Toggle/Activate/Deactivate (PLG-04) ==========

export async function togglePlugin(pluginId) {
  const result = await storageGet([STORAGE_KEY]);
  const plugins = result[STORAGE_KEY] || {};
  if (!plugins[pluginId]) {
    throw new Error('Plugin not found: ' + pluginId);
  }
  plugins[pluginId].active = !plugins[pluginId].active;
  await storageSet({ [STORAGE_KEY]: plugins });
  console.log('[PLUGIN-REGISTRY] Plugin toggled:', pluginId, 'active=' + plugins[pluginId].active);
  return plugins[pluginId].active;
}

export async function activatePlugin(pluginId) {
  const result = await storageGet([STORAGE_KEY]);
  const plugins = result[STORAGE_KEY] || {};
  if (!plugins[pluginId]) {
    throw new Error('Plugin not found: ' + pluginId);
  }
  plugins[pluginId].active = true;
  await storageSet({ [STORAGE_KEY]: plugins });
  console.log('[PLUGIN-REGISTRY] Plugin activated:', pluginId);
}

export async function deactivatePlugin(pluginId) {
  const result = await storageGet([STORAGE_KEY]);
  const plugins = result[STORAGE_KEY] || {};
  if (!plugins[pluginId]) {
    throw new Error('Plugin not found: ' + pluginId);
  }
  plugins[pluginId].active = false;
  await storageSet({ [STORAGE_KEY]: plugins });
  console.log('[PLUGIN-REGISTRY] Plugin deactivated:', pluginId);
}

// ========== Conflict detection (PLG-05) ==========

export async function detectConflicts(pluginId) {
  const result = await storageGet([STORAGE_KEY]);
  const plugins = result[STORAGE_KEY] || {};
  const newPlugin = plugins[pluginId];

  if (!newPlugin) return [];

  const conflicts = [];
  const newPlatforms = newPlugin.platforms || [];
  const newActions = newPlugin.actions ? Object.keys(newPlugin.actions) : [];

  for (const [id, existing] of Object.entries(plugins)) {
    if (id === pluginId || !existing.active) continue;

    // Check platform overlap
    const existingPlatforms = existing.platforms || [];
    for (const platform of newPlatforms) {
      if (existingPlatforms.includes(platform)) {
        conflicts.push({
          type: 'platform_overlap',
          existingPlugin: id,
          newPlugin: pluginId,
          detail: 'Both provide platform profile "' + platform + '"'
        });
      }
    }

    // Check action overlap
    const existingActions = existing.actions ? Object.keys(existing.actions) : [];
    for (const action of newActions) {
      if (existingActions.includes(action)) {
        conflicts.push({
          type: 'action_overlap',
          existingPlugin: id,
          newPlugin: pluginId,
          detail: 'Both register action "' + action + '"'
        });
      }
    }
  }

  if (conflicts.length) {
    console.warn('[PLUGIN-REGISTRY] Conflicts detected for', pluginId + ':', conflicts.length);
  }
  return conflicts;
}

// ========== Query helpers ==========

export async function getInstalledPlugins() {
  const result = await storageGet([STORAGE_KEY]);
  return result[STORAGE_KEY] || {};
}

export async function getActivePlugins() {
  const result = await storageGet([STORAGE_KEY]);
  const plugins = result[STORAGE_KEY] || {};
  const active = {};
  for (const [id, plugin] of Object.entries(plugins)) {
    if (plugin.active) active[id] = plugin;
  }
  return active;
}


