// background/platforms/index.js
// Platform profile registry — v3.22.0
//
// Adds new platforms by importing the profile here and registering it. The
// Adaptive Prompts engine (background/adaptive-prompts.js) iterates the list
// in order and picks the FIRST profile whose `detect(url, goal)` returns true.
//
// Order matters: more-specific profiles must come before fallback profiles
// (e.g., sonicwall_nsm before sonicwall_onbox).

import { sonicwallNsm } from './sonicwall_nsm.js';
import { sonicwallOnbox } from './sonicwall_onbox.js';
import { m365Admin } from './m365_admin.js';
import { fortigate } from './fortigate.js';
import { itglue } from './itglue.js';
import { aruba } from './aruba.js';
import { ambioViewlinc } from './ambio_viewlinc.js';
import { screenconnect } from './screenconnect.js';
import { ninjarmm } from './ninjarmm.js';
import { connectwiseManage } from './connectwise_manage.js';
import { dattoRmm } from './datto_rmm.js';
import { cisco } from './cisco.js';
import { paloalto } from './paloalto.js';
import { sentinelone } from './sentinelone.js';
import { nvd } from './nvd.js';
import { virustotal } from './virustotal.js';
import { huntress } from './huntress.js';
import { networkDevice } from './network_device.js';

const PROFILES = [
  // Most-specific first. NSM before on-box, ITG before generic. Aruba covers
  // Central + Instant + OS-CX in one profile and lives after Microsoft/Sonic
  // because those have stricter URL matches.
  // (3.36.0) ambioViewlinc detects on the specific 192.168.100.x server +
  // viewlinc/oq keyword combo, so it slots before the catch-alls.
  // (3.37.0) ScreenConnect and NinjaRMM added for run_remote_command support.
  // (3.38.0) ConnectWise Manage and Datto RMM added.
  // (3.44.0) Cisco, Palo Alto, SentinelOne, NVD, VirusTotal, Huntress profiles.
  //   networkDevice is catch-all on goal keywords — MUST be last.
  sonicwallNsm,
  sonicwallOnbox,
  m365Admin,
  fortigate,
  itglue,
  aruba,
  ambioViewlinc,
  screenconnect,
  ninjarmm,
  connectwiseManage,
  dattoRmm,
  cisco,
  paloalto,
  sentinelone,
  nvd,
  virustotal,
  huntress,
  networkDevice,
];

/**
 * Resolve the best-matching platform profile for the current URL and goal.
 * Iterates PROFILES in order and returns the first whose detect() returns true.
 * @param {string} currentUrl - The active tab's URL.
 * @param {string} goal - The user's goal text.
 * @returns {object|null} The matching platform profile, or null if none matched.
 */
export function getPlatformProfile(currentUrl, goal) {
  for (const p of PROFILES) {
    try {
      if (p && typeof p.detect === 'function' && p.detect(currentUrl, goal)) return p;
    } catch (_e) {
      console.warn('[Sentinel] Platform detect error (profile:', p && p.id, '):', typeof _e === 'object' && _e !== null && typeof _e.message === 'string' ? _e.message : String(_e));
      continue;
    }
  }
  return null;
}

/**
 * Inspect a goal for menu paths that don't match the detected profile's surface.
 * Returns hints that map on-box menu paths to their cloud-portal equivalents.
 * @param {object} profile - The matched platform profile with mismatchHints array.
 * @param {string} goal - The user's goal text.
 * @returns {Array<{onbox: string, target: string}>} Mismatch hints found in the goal.
 */
export function findMismatchHints(profile, goal) {
  if (!profile || !Array.isArray(profile.mismatchHints) || !goal) return [];
  const hits = [];
  for (const hint of profile.mismatchHints) {
    try {
      if (hint && hint.pattern && hint.pattern.test(goal)) {
        hits.push({ onbox: hint.onbox, target: hint.nsm });
      }
    } catch (_e) { /* skip bad pattern */ }
  }
  return hits;
}

/**
 * Lightweight listing of all registered platform profiles.
 * Returns id, label, and memoryKeyPrefix for each profile.
 * @returns {Array<{id: string, label: string, memoryKeyPrefix: string}>}
 */
export function listAllProfiles() {
  return PROFILES.map(p => ({ id: p.id, label: p.label, memoryKeyPrefix: p.memoryKeyPrefix }));
}
