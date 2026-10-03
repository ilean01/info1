(() => {
  'use strict';
  const NativeMutationObserver = window.MutationObserver;
  if (!NativeMutationObserver || window.__INFO1_SELECTION_OBSERVER_GUARD__) return;
  window.__INFO1_SELECTION_OBSERVER_GUARD__ = true;

  window.MutationObserver = class Info1GuardedMutationObserver extends NativeMutationObserver {
    constructor(callback) {
      super((mutations, observer) => {
        const onlySelectionUi = mutations.length > 0 && mutations.every(mutation => {
          const target = mutation.target && mutation.target.nodeType === 1 ? mutation.target : null;
          return !!(target && target.closest && target.closest('#nbSelectionExtLayer,#nbSelectionExtTools'));
        });
        if (!onlySelectionUi) callback(mutations, observer);
      });
    }
  };
})();