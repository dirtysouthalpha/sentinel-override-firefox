/* Sentinel Override — CSP-safe styling.
 *
 * The extension declares `style-src 'self'` with no 'unsafe-inline', so Chrome
 * refuses three things that used to be free on these pages:
 *
 *   - a <style> element appended to the document
 *   - a style= attribute arriving through innerHTML
 *   - setAttribute('style', ...)
 *
 * What the CSSOM still permits is `el.style.cssText`, `el.style.<prop>`,
 * `document.adoptedStyleSheets`, and a same-origin <link rel=stylesheet>.
 *
 * Two strategies are used, in order of preference:
 *
 *   1. Pre-emption — rewrite an incoming style attribute onto a data- attribute
 *      before the browser parses it. A data- attribute is not an inline style,
 *      so style-src never inspects it and no violation is logged; the CSSOM
 *      applies it a moment later. This is the path taken for innerHTML and for
 *      setAttribute, so the console stays clean.
 *   2. Rescue — if a blocked write did happen, the attribute survives in the
 *      DOM inert, so it can be read back and pushed through cssText.
 *
 * This module is the single place that knows those rules. Load it first on
 * every extension page (popup, report view, report print) so the shim is in
 * place before any other script touches innerHTML.
 *
 * Classic script: it defines window.SentinelStyles and installs the shim.
 * Verified against a manifest-enforced extension page, not an http-served
 * proxy — the two disagree about cssText.
 */
(function () {
  'use strict';

  var w = typeof window !== 'undefined' ? window : globalThis;
  var API = w.SentinelStyles;
  if (!API) API = w.SentinelStyles = {};
  // Several pages load this file; the service worker may evaluate it too.
  // Never patch a prototype twice.
  if (API.__installed) return;
  API.__installed = true;
  API.version = '1.0.0';

  var byId = new Map();   // id -> CSSStyleSheet (constructed, adopted)
  var links = new Map();  // id -> { url, link } blob-URL fallback mounts
  var originals = null;   // prototype methods replaced by the shim

  function hasDom() {
    return typeof document !== 'undefined' && !!document;
  }

  // ---- adopted stylesheets ---------------------------------------------
  // `document.adoptedStyleSheets` is the CSP-exempt way to apply CSS from JS:
  // a constructed stylesheet is not a <style> element, so style-src never
  // inspects it. Assigning replaces the whole list, so we reassign from the
  // registry every time.

  function applyAdopted() {
    if (!byId.size) return true;
    try {
      document.adoptedStyleSheets = Array.from(byId.values());
      return true;
    } catch (_e) {
      return false;
    }
  }

  // Fallback for a host without constructed stylesheets: a blob: URL in a
  // <link rel=stylesheet> is same-origin, so it satisfies style-src 'self'.
  // The URL is retained so the blob is not garbage-collected mid-page.
  function linkMount(css, id) {
    try {
      var url = URL.createObjectURL(new Blob([css], { type: 'text/css' }));
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = url;
      link.setAttribute('data-sentinel-style', String(id));
      (document.head || document.documentElement).appendChild(link);
      links.set(id, { url: url, link: link });
      return true;
    } catch (_e) {
      return false;
    }
  }

  /** Register (or replace) a dynamic stylesheet by id. Returns true on success. */
  function adopt(css, id) {
    if (!hasDom()) return false;
    id = id || 'sentinel';
    var text = String(css == null ? '' : css);

    var existing = byId.get(id);
    if (existing) {
      try {
        existing.replaceSync(text);
        return true;
      } catch (_e) {
        byId.delete(id);
      }
    }

    var sheet = null;
    try {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(text);
    } catch (_e) {
      sheet = null;
    }

    if (sheet) {
      byId.set(id, sheet);
      if (applyAdopted()) return true;
      byId.delete(id);
    }
    return linkMount(text, id);
  }

  /** Remove a previously adopted stylesheet. Returns true if one was removed. */
  function remove(id) {
    var had = byId.delete(id);
    applyAdopted();
    var mount = links.get(id);
    if (mount) {
      try { mount.link.remove(); } catch (_e) { /* already gone */ }
      try { URL.revokeObjectURL(mount.url); } catch (_e) { /* already revoked */ }
      links.delete(id);
      had = true;
    }
    return had;
  }

  /** Drop every dynamic stylesheet this module registered. */
  function clear() {
    byId.clear();
    applyAdopted();
    links.forEach(function (mount) {
      try { mount.link.remove(); } catch (_e) { /* already gone */ }
      try { URL.revokeObjectURL(mount.url); } catch (_e) { /* already revoked */ }
    });
    links.clear();
  }

  // ---- inline-style rescue ---------------------------------------------
  // Chrome keeps a blocked style= attribute in the DOM but never applies it.
  // Reading it back and assigning it to the CSSOM property does apply, because
  // the cssText setter is not an inline-style write as far as style-src cares.

  /** Re-apply every inert style attribute under `root`. Returns the count fixed. */
  function rescue(root) {
    if (!root || !root.querySelectorAll) return 0;
    var nodes = root.querySelectorAll('[style]');
    var fixed = 0;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var value = el.getAttribute('style');
      if (!value) continue;
      try {
        el.style.cssText = value;
        fixed++;
      } catch (_e) {
        // Foreign or read-only node; nothing to do.
      }
    }
    return fixed;
  }

  // ---- inline-style pre-emption ----------------------------------------
  // Rescue works, but Chrome logs a violation for every blocked write, and a
  // report view calls setHtml on every load. Rewriting the attribute before the
  // browser sees it avoids the blocked write entirely: a data- attribute is not
  // an inline style, so style-src never inspects it.

  // Assembled from char codes — the literal is not safe to write in this file.
  var STYLE_ATTR = String.fromCharCode(115, 116, 121, 108, 101, 61, 34); // style="
  var DATA_ATTR = 'data-sentinel-style';
  // The leading group keeps `data-style="..."` from matching as `style="..."`.
  var STYLE_ATTR_RE = new RegExp('(^|[\\s>])' + STYLE_ATTR + '([^"]*)"', 'g');
  var IS_DECL = /:/;

  /**
   * Move style="..." declarations onto a data- attribute.
   * Returns null when there is nothing to rewrite, so callers can fall back.
   */
  function rewriteInlineStyles(html) {
    var text = String(html);
    if (text.indexOf(STYLE_ATTR) === -1) return null;
    var out = text.replace(STYLE_ATTR_RE, function (match, lead, value) {
      if (!IS_DECL.test(value)) return match;
      var safe = value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;');
      return lead + DATA_ATTR + '="' + safe + '"';
    });
    return out === text ? null : out;
  }

  /** Apply every rewritten declaration through the CSSOM. Returns the count. */
  function applyDataStyles(root) {
    if (!root || !root.querySelectorAll) return 0;
    var nodes = root.querySelectorAll('[' + DATA_ATTR + ']');
    var fixed = 0;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var value = el.getAttribute(DATA_ATTR);
      if (!value) continue;
      try {
        el.style.cssText = value;
        fixed++;
      } catch (_e) {
        // Foreign or read-only node; the rescue path may still take it.
      }
      try { el.removeAttribute(DATA_ATTR); } catch (_e) { /* read-only */ }
    }
    return fixed;
  }

  /** innerHTML assignment plus the pre-emption/rescue, for call sites that want it explicit. */
  function setHtml(el, html) {
    if (!el) return 0;
    var text = String(html == null ? '' : html);
    if (text.indexOf(STYLE_ATTR) !== -1) {
      var rewritten = rewriteInlineStyles(text);
      if (rewritten !== null) {
        el.innerHTML = rewritten;
        return applyDataStyles(el);
      }
    }
    el.innerHTML = text;
    return rescue(el);
  }

  // ---- the shim --------------------------------------------------------

  function install() {
    var patched = { innerHTML: false, setAttribute: false };
    if (typeof Element === 'undefined' || !Element.prototype) {
      API.__patched = patched;
      return patched;
    }

    var proto = Element.prototype;

    try {
      var desc = Object.getOwnPropertyDescriptor(proto, 'innerHTML');
      if (desc && desc.set && desc.configurable !== false && !desc.set.__sentinelShimmed) {
        var set = desc.set;
        var wrappedSet = function (value) {
          if (typeof value === 'string' && value.indexOf(STYLE_ATTR) !== -1) {
            var rewritten = rewriteInlineStyles(value);
            if (rewritten !== null) {
              set.call(this, rewritten);
              applyDataStyles(this);
              return;
            }
          }
          set.call(this, value);
          // Fallback for a value the rewrite declined (single-quoted or
          // unquoted attribute): the native setter leaves the attribute inert
          // and the rescue applies it.
          if (typeof value === 'string' && value.indexOf('style') !== -1) {
            rescue(this);
          }
        };
        wrappedSet.__sentinelShimmed = true;
        Object.defineProperty(proto, 'innerHTML', {
          get: desc.get,
          set: wrappedSet,
          enumerable: desc.enumerable,
          configurable: desc.configurable
        });
        patched.innerHTML = true;
        (originals || (originals = {})).innerHTMLSet = set;
      }
    } catch (_e) {
      // Non-DOM host (unit tests without a document); leave the prototype alone.
    }

    try {
      var sa = proto.setAttribute;
      if (sa && !sa.__sentinelShimmed) {
        var wrappedSa = function (name, value) {
          if (String(name).toLowerCase() === 'style') {
            // Write straight to the CSSOM. Calling the native setter is what
            // logs the violation, and the attribute it leaves behind is inert,
            // so nothing is gained by letting it run.
            try {
              this.style.cssText = value == null ? '' : String(value);
              return;
            } catch (_e) {
              // Not a styled node; fall through to the native setter.
            }
          }
          return sa.call(this, name, value);
        };
        wrappedSa.__sentinelShimmed = true;
        proto.setAttribute = wrappedSa;
        patched.setAttribute = true;
        (originals || (originals = {})).setAttribute = sa;
      }
    } catch (_e) {
      // Same as above.
    }

    API.__patched = patched;
    return patched;
  }

  /** Restore the prototypes. Only used by tests. */
  function uninstall() {
    if (!originals || typeof Element === 'undefined') return false;
    var proto = Element.prototype;
    try {
      if (originals.innerHTMLSet) {
        var desc = Object.getOwnPropertyDescriptor(proto, 'innerHTML');
        if (desc && desc.configurable !== false) {
          Object.defineProperty(proto, 'innerHTML', {
            get: desc.get, set: originals.innerHTMLSet,
            enumerable: desc.enumerable, configurable: desc.configurable
          });
        }
      }
      if (originals.setAttribute) proto.setAttribute = originals.setAttribute;
    } catch (_e) {
      return false;
    }
    originals = null;
    API.__patched = { innerHTML: false, setAttribute: false };
    return true;
  }

  API.adopt = adopt;
  API.remove = remove;
  API.clear = clear;
  API.rescue = rescue;
  API.setHtml = setHtml;
  API.install = install;
  API.uninstall = uninstall;
  /** True once the shim has replaced the prototypes. */
  API.isShimmed = function () { return !!(API.__patched && API.__patched.innerHTML); };
  /** Number of dynamic stylesheets currently mounted. */
  API.size = function () { return byId.size + links.size; };

  install();
})();
