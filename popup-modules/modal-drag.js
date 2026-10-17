// popup-modules/modal-drag.js
// Movable modals — v3.23.0
//
// Click-and-drag a modal's title bar (the first <h2> inside .modal-content)
// to reposition it within the side panel. Uses pointer events so it works
// with mouse, trackpad, and touch. Constrains the modal inside the viewport
// so it never disappears off-screen.
//
// Pattern:
//   - Each modal's .modal-content gets a transform applied during drag.
//   - On modal close (.modal loses .show), the transform resets so reopening
//     starts centered.
//   - We listen for new modals appearing via MutationObserver so dynamically
//     created modals (template modal, run log history, etc.) get wired up.

// Precompile regex for input tag check in hot path
const INPUT_TAG_RE = /^(INPUT|BUTTON|SELECT)$/;

(function setupModalDrag() {
  const ATTACHED = new WeakSet();
  const POSITIONS = new WeakMap(); // modal-content element -> {tx, ty}

  function attachDrag(modalContent) {
    if (!modalContent || ATTACHED.has(modalContent)) return;
    const titleBar = modalContent.querySelector('h2');
    if (!titleBar) return;
    ATTACHED.add(modalContent);

    let dragStart = null;
    let initialPos = { tx: 0, ty: 0 };

    titleBar.addEventListener('pointerdown', (e) => {
      // Ignore clicks on inputs / buttons that might happen to be inside the title.
      if (e.target && (INPUT_TAG_RE.test(e.target.tagName))) return;
      // Only start drag on primary button.
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      e.preventDefault();

      dragStart = { x: e.clientX, y: e.clientY };
      initialPos = POSITIONS.get(modalContent) || { tx: 0, ty: 0 };
      modalContent.classList.add('dragging');
      titleBar.classList.add('dragging');
      try { titleBar.setPointerCapture(e.pointerId); } catch { /* pointer capture may fail */ }
    });

    titleBar.addEventListener('pointermove', (e) => {
      if (!dragStart) return;
      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;
      let tx = initialPos.tx + dx;
      let ty = initialPos.ty + dy;

      // Constrain so at least 100px of the modal stays visible in each direction.
      try {
        const rect = modalContent.getBoundingClientRect();
        const winW = window.innerWidth;
        const winH = window.innerHeight;
        // Re-derive the natural (un-translated) position using last applied translation
        const lastApplied = POSITIONS.get(modalContent) || { tx: 0, ty: 0 };
        const naturalLeft = rect.left - lastApplied.tx;
        const naturalTop = rect.top - lastApplied.ty;
        const minVisible = 80;
        const minTx = -(naturalLeft + rect.width - minVisible);
        const maxTx = winW - naturalLeft - minVisible;
        const minTy = -(naturalTop + rect.height - minVisible);
        const maxTy = winH - naturalTop - minVisible;
        if (tx < minTx) tx = minTx;
        if (tx > maxTx) tx = maxTx;
        if (ty < minTy) ty = minTy;
        if (ty > maxTy) ty = maxTy;
      } catch { /* bounds calc failed — let the transform through */ }

      modalContent.style.transform = `translate(${tx}px, ${ty}px)`;
      POSITIONS.set(modalContent, { tx, ty });
    });

    function endDrag(e) {
      if (!dragStart) return;
      dragStart = null;
      modalContent.classList.remove('dragging');
      titleBar.classList.remove('dragging');
      try { titleBar.releasePointerCapture(e.pointerId); } catch { /* pointer capture release may fail */ }
    }
    titleBar.addEventListener('pointerup', endDrag);
    titleBar.addEventListener('pointercancel', endDrag);
  }

  // Each time a modal opens (gets .show class), reset its position so it
  // starts centered. Watch for .show class changes via MutationObserver.
  function observeModalShowChanges() {
    const modals = document.querySelectorAll('.modal');
    modals.forEach(modal => {
      const obs = new MutationObserver(() => {
        const isOpen = modal.classList.contains('show');
        if (isOpen) {
          // Modal just opened — reset position
          const content = modal.querySelector('.modal-content');
          if (content) {
            content.style.transform = '';
            POSITIONS.delete(content);
            attachDrag(content);
          }
        }
      });
      obs.observe(modal, { attributes: true, attributeFilter: ['class'] });
    });
  }

  // Initial wire-up on DOM ready
  function init() {
    // Wire up modals that exist now
    document.querySelectorAll('.modal-content').forEach(attachDrag);
    observeModalShowChanges();

    // Catch dynamically-created modals (e.g., the run log history is built once
    // but later modals might be added by templates / scheduler-ui modules).
    const bodyObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node && node.nodeType === 1) {
            if (node.matches && node.matches('.modal')) {
              const content = node.querySelector('.modal-content');
              if (content) attachDrag(content);
              // Also observe its .show changes
              const obs = new MutationObserver(() => {
                if (node.classList.contains('show')) {
                  const c = node.querySelector('.modal-content');
                  if (c) {
                    c.style.transform = '';
                    POSITIONS.delete(c);
                    attachDrag(c);
                  }
                }
              });
              obs.observe(node, { attributes: true, attributeFilter: ['class'] });
            }
            if (node.querySelectorAll) {
              node.querySelectorAll('.modal-content').forEach(attachDrag);
            }
          }
        }
      }
    });
    if (document.body) bodyObserver.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
