# Sentinel Override (Firefox)

**A Firefox WebExtension that drives the browser as an autonomous automation agent — it investigates pages, configures admin consoles, and collaborates with external tools over the Universal Agent Protocol.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/dirtysouthalpha/sentinel-override-firefox/actions/workflows/ci.yml/badge.svg)](https://github.com/dirtysouthalpha/sentinel-override-firefox/actions/workflows/ci.yml)
![Manifest V3](https://img.shields.io/badge/manifest-v3-blue)
![Firefox 128+](https://img.shields.io/badge/Firefox-128%2B-orange)

<!-- TODO: replace with real screenshot or GIF -->
![Sentinel Override screenshot placeholder](assets/demo-placeholder.svg)

## Quickstart

Load as a temporary add-on (no build step; the tree is the extension):

1. `git clone https://github.com/dirtysouthalpha/sentinel-override-firefox.git`
2. Open Firefox (128 or newer) and go to `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…** and pick `manifest.json` from the clone.
4. Open the **Sentinel Override** sidebar (or click the toolbar button) to reach the panel.

Or run it in a scratch profile with `web-ext`:

```bash
npm install          # installs web-ext as a devDependency
npm start            # web-ext run --source-dir .
```

Useful keyboard commands (see `commands` in `manifest.json`): `Ctrl+Shift+Space` toggles the agent, `Ctrl+Shift+P` pauses/resumes it. Turbo/normal/stealth speed commands are unbound by default and can be set in `about:addons` → Manage Extension Shortcuts.

The optional native messaging host under `native-host/` (credential broker) is installed separately with `native-host/install_host.py`; the extension runs without it.

## Hardware tested

| Platform | Firefox | Notes |
|---|---|---|
| TBD — add your machine via PR | 128+ (`strict_min_version`) | Firefox parity and startup checks are recorded in [CHANGELOG.md](CHANGELOG.md); no per-machine results are documented yet. |

## Features

Derived from `manifest.json`, the popup modules and the changelog — nothing listed here that is not in the code.

- **Autonomous agent loop** (`background/agent-engine.js`) with planning, recovery, error classification, reasoning traces and a fail-safe command-result allowlist (a result string that is not a known success verb is reported as a failure).
- **Content-side DOM toolkit** — visibility/interactability checks, label extraction, unique selector generation, shadow-DOM piercing (open and closed roots via `shadow-intercept.js`), iframe routing, overlay detection and dismissal, dropdown and special-input handling, wait/verify conditions, an on-page action HUD and cursor.
- **Event watchdogs** — background watchdogs plus a content-script dialog/crash lane (`dialog-guard-main.js` / `dialog-guard-bridge.js`).
- **Run Guard** — persisted kill switch, enforced spend budget and durable rate limit, with a popup card.
- **Credential broker** — provider API keys are kept out of `storage.local` and brokered through a native messaging host (`native-host/`), with a fail-closed rule and migration path.
- **Universal Agent Protocol bridges** — `uap-bridge.js`, `uap-server.js`, `ws-bridge.js` and `externally_connectable` for `localhost` / `127.0.0.1`, so local tools can drive the agent.
- **Platform adapters** (`background/platforms/`) for common admin consoles (M365 admin, ConnectWise Manage, Datto RMM, NinjaRMM, ITGlue, Huntress, SentinelOne, ScreenConnect, SonicWall, FortiGate, Palo Alto, Cisco, Aruba, VirusTotal, NVD, generic network devices).
- **Skills** (`background/skills/`) — recovery strategies for auth walls, CSP blocks, selector misses, navigation loops, slow LLM calls and more.
- **Popup / sidebar UI** — chat, templates, scheduler, onboarding, client knowledge, collaboration, recent chats, telemetry panel, host-access management and settings; printable and viewable HTML reports (`report-view.html`, `report-print.html`).
- **Scheduling, notifications, downloads, context menus** — per the `alarms`, `notifications`, `downloads` and `contextMenus` permissions; `<all_urls>` is an *optional* permission granted from the UI (`popup-modules/host-access.js`).
- **Security helpers** — injection and contradiction detection, secrets redaction, permission gate, site policy, trust score, audit log and export.

## Architecture

```
compat/firefox-entry.js      ESM entry; imports webext-shim.js then background/index.js
compat/webext-shim.js        promise-style chrome.* over Firefox's browser.* for the event page
compat/content-shim.js       same idea for content scripts (classic script, runs first)
background/                  agent engine, planning/recovery, LLM client, bridges, platforms/, skills/
content/                     page-side utilities exposed on window.__sentinelUtils.* (dom, wait, shadow, ...)
popup.html + popup-modules/  sidebar/popup UI; helpers.js is loaded first and exposes window.Helpers
report-*.html/js/css         report viewer and print layout (lib/marked + sanitize-html)
native-host/                 optional Python credential-broker native messaging host
```

- **Background** is a Manifest V3 event page (`"type": "module"`), not a service worker; `sw-watchdog.js` and the shim handle the Firefox lifecycle.
- **Content scripts** are injected in layers: `shadow-intercept.js` and `dialog-guard-main.js` run in the page's `MAIN` world at `document_start`; the utility bundle runs in the isolated world; `index.js` and `quick-assist.js` run at `document_idle` in the top frame only.
- **Popup** modules are plain scripts sharing globals (`window.Helpers`, `window.PopupState`), loaded in the order listed in `popup.html`.
- **Compat** shims exist so the same source can run on Chrome's callback-style `chrome.*` and Firefox's promise-style `browser.*`.

## Development

```bash
npm install
npm test        # node:test — manifest/file references, syntax of every JS file, pure helper behaviour
npm run lint    # web-ext lint (0 errors expected; warnings are reported, not fatal)
```

CI runs the same two commands on Ubuntu 24.04 with Node 22 (`.github/workflows/ci.yml`).

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE).
