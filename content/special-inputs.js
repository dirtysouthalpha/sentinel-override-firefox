// Sentinel Override v3 -- Special Input Utilities
// Date picker, file upload, and rich text editor interaction utilities.
// Handles common enterprise UI input types that require non-standard interaction patterns.

window.__sentinelUtils = window.__sentinelUtils || {};
window.__sentinelUtils.specialInputs = window.__sentinelUtils.specialInputs || {};

(function() {
  function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  const si = window.__sentinelUtils.specialInputs;

  // ========== Date Picker Detection ==========
  si.isDateInput = function(el) {
    if (!el) return false;

    // Native date input types
    if (/^(date|datetime-local|month)$/.test(el.type)) {
      return true;
    }

    // ARIA indicators
    if (el.getAttribute('role') === 'datepicker') return true;
    if (el.getAttribute('aria-haspopup') === 'dialog') return true;

    // Container class heuristics
    const classStr = (el.className || '').toLowerCase();
    if (/datepicker|date-picker|calendar/.test(classStr)) {
      return true;
    }

    // Check parent containers for date-related classes
    let parent = el.parentElement;
    let depth = 0;
    while (parent && depth < 3) {
      const parentClass = (parent.className || '').toLowerCase();
      if (/datepicker|date-picker|calendar/.test(parentClass)) {
        return true;
      }
      parent = parent.parentElement;
      depth++;
    }

    return false;
  };

  // ========== Rich Text Editor Detection ==========
  si.isRichTextEditor = function(el) {
    if (!el) return false;

    // contentEditable check
    if (el.isContentEditable) {
      // Check for rich content indicators (has formatting child elements)
      const richChildren = el.querySelectorAll('b, i, a, br, strong, em, u, span, div, p, h1, h2, h3, ul, ol, li, img');
      if (richChildren.length) return true;

      // Check for known editor container classes on self or parents
      const classStr = (el.className || '').toLowerCase();
      const editorClasses = ['ql-editor', 'tox-edit-area', 'ck-editor', 'prosemirror', 'lexical-editor', 'editor-content', 'rich-editor', 'wysiwyg'];
      if (editorClasses.some(function(cls) { return classStr.includes(cls); })) return true;

      // Check parent for editor classes
      let parent = el.parentElement;
      let depth = 0;
      while (parent && depth < 3) {
        const parentClass = (parent.className || '').toLowerCase();
        if (editorClasses.some(function(cls) { return parentClass.includes(cls); })) return true;
        parent = parent.parentElement;
        depth++;
      }

      // If contenteditable but no rich indicators, still likely an editor (text input area)
      // Check if it has a meaningful role or placeholder
      if (el.getAttribute('role') === 'textbox' || el.getAttribute('aria-multiline') === 'true') return true;

      // If contenteditable with no children but has placeholder, treat as rich text
      if (el.children.length === 0 && el.getAttribute('data-placeholder')) return true;
    }

    return false;
  };

  // ========== Set Date Picker Value ==========
  si.setDatePickerValue = function(el, dateStr) {
    if (!el) return { success: false, method: 'none', error: 'No element provided' };

    // Parse date string to YYYY-MM-DD format
    let nativeDate = dateStr;
    if (dateStr && !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      // Try parsing human-readable formats
      const parsed = new Date(dateStr);
      if (!Number.isNaN(parsed.getTime())) {
        const year = parsed.getFullYear();
        const month = String(parsed.getMonth() + 1).padStart(2, '0');
        const day = String(parsed.getDate()).padStart(2, '0');
        nativeDate = `${year}-${month}-${day}`;
      } else {
        return { success: false, method: 'none', error: `Cannot parse date: ${dateStr}` };
      }
    }

    const eventOpts = { bubbles: true, composed: true };

    // Strategy 1: Native date input
    if (/^(date|datetime-local|month)$/.test(el.type)) {
      try {
        const _desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        const nativeSetter = _desc && _desc.set;
        if (!nativeSetter) throw new Error('no native value setter');
        nativeSetter.call(el, nativeDate);
        el.dispatchEvent(new Event('input', eventOpts));
        el.dispatchEvent(new Event('change', eventOpts));
        return { success: true, method: 'native-setter' };
      } catch {
        // Fall through to next strategy
      }
    }

    // Strategy 2: Framework date picker (container wrapping an input)
    const childInput = el.querySelector('input[type="date"], input[type="datetime-local"], input[type="text"][placeholder*="date" i], input[placeholder*="Date" i]');
    if (childInput) {
      try {
        const _childDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        const nativeSetter = _childDesc && _childDesc.set;
        if (!nativeSetter) throw new Error('no native value setter');
        nativeSetter.call(childInput, nativeDate);
        childInput.dispatchEvent(new Event('input', eventOpts));
        childInput.dispatchEvent(new Event('change', eventOpts));
        return { success: true, method: 'framework-child-input' };
      } catch {
        // Fall through to next strategy
      }
    }

    // Strategy 3: UI fallback -- try clicking the element to open calendar
    try {
      el.click();
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, composed: true }));
      // Cannot programmatically click a specific date cell without knowing the calendar layout
      return { success: false, method: 'ui-fallback', error: 'Date picker opened but target date must be selected manually. Use YYYY-MM-DD format for native inputs.' };
    } catch (e) {
      return { success: false, method: 'none', error: `All date picker strategies failed: ${(typeof e === 'object' && e !== null && typeof e.message === 'string' ? e.message : String(e))}` };
    }
  };

  // ========== Upload File ==========
  si.uploadFile = function(inputEl, fileName, mimeType, content) {
    if (!inputEl || inputEl.type !== 'file') return false;
    if (!fileName || !content) return false;

    try {
      // Create File object from content string
      const file = new File([content], fileName, { type: mimeType || 'text/plain' });

      // Create DataTransfer and assign file
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      inputEl.files = dataTransfer.files;

      // Dispatch change event
      inputEl.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

      return true;
    } catch {
      return false;
    }
  };

  // ========== Set Rich Text Value ==========
  si.setRichTextValue = function(el, text) {
    if (!el) return { success: false, method: 'none', error: 'No element provided' };

    const eventOpts = { bubbles: true, composed: true };

    // Strategy 3 (check first): Known editor APIs (most reliable for specific editors)
    // Quill editor
    if (el.__quill && typeof el.__quill.setText === 'function') {
      try {
        el.__quill.setText(text);
        el.dispatchEvent(new Event('input', eventOpts));
        el.dispatchEvent(new Event('change', eventOpts));
        return { success: true, method: 'quill-api' };
      } catch {
        // Fall through
      }
    }

    // TinyMCE editor
    try {
      if (el.id && typeof tinymce !== 'undefined' && tinymce.get && tinymce.get(el.id)) {
        const editor = tinymce.get(el.id);
        editor.setContent(text);
        el.dispatchEvent(new Event('input', eventOpts));
        el.dispatchEvent(new Event('change', eventOpts));
        return { success: true, method: 'tinymce-api' };
      }
    } catch {
      // tinymce not defined or error
    }

    // CKEditor
    try {
      if (el.id && typeof CKEDITOR !== 'undefined' && CKEDITOR.instances && CKEDITOR.instances[el.id]) {
        const editor = CKEDITOR.instances[el.id];
        editor.setData(text);
        el.dispatchEvent(new Event('input', eventOpts));
        el.dispatchEvent(new Event('change', eventOpts));
        return { success: true, method: 'ckeditor-api' };
      }
    } catch {
      // CKEDITOR not defined or error
    }
    // Strategy 1: execCommand (broadest compatibility)
    try {
      el.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);

      // Insert text character by character for React/Vue compatibility
      document.execCommand('insertText', false, text);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));

      el.dispatchEvent(new Event('change', eventOpts));
      el.dispatchEvent(new Event('blur', eventOpts));
      return { success: true, method: 'execCommand' };
    } catch {
      // execCommand not available or failed
    }

    // Strategy 2: Direct innerHTML set
    try {
      el.innerHTML = escapeHtml(text).replace(/\n/g, '<br>');
      el.dispatchEvent(new Event('input', eventOpts));
      el.dispatchEvent(new Event('change', eventOpts));
      return { success: true, method: 'direct-innerHTML' };
    } catch (e) {
      return { success: false, method: 'none', error: `All rich text strategies failed: ${(typeof e === 'object' && e !== null && typeof e.message === 'string' ? e.message : String(e))}` };
    }
  };
})();

