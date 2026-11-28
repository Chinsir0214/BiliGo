const focusableSelector = [
  'a[href]', 'area[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea',
  'iframe', 'object', 'embed', 'audio[controls]', 'video[controls]', 'summary',
  '[contenteditable]:not([contenteditable="false"])', '[tabindex]'
].join(',');

export function dialogTabStops(dialog) {
  // Positive tabindex precedes the normal document-order tab stops.
  return [...dialog.querySelectorAll(focusableSelector)].filter(element =>
    !element.matches(':disabled') && !element.closest('[hidden], [inert]') &&
    !(element.hasAttribute('tabindex') && element.tabIndex < 0) &&
    element.checkVisibility({ visibilityProperty: true })
  ).sort((a, b) => (a.tabIndex > 0 ? a.tabIndex : Infinity) - (b.tabIndex > 0 ? b.tabIndex : Infinity));
}

export function createModal({ $, document }) {
  let active;
  const isOpen = dialog => Boolean(active && active.dialog === dialog);

  function open(dialog, trigger, initialFocus, dismiss) {
    if (active) return isOpen(dialog);
    active = { dialog, trigger, dismiss };
    $('.app-shell').inert = true;
    dialog.classList.remove('hidden');
    (initialFocus || dialog).focus();
    return true;
  }

  function close(dialog) {
    if (!isOpen(dialog)) return;
    const { trigger } = active;
    active = undefined;
    dialog.classList.add('hidden');
    $('.app-shell').inert = false;
    trigger?.focus();
  }

  function bind() {
    document.addEventListener('keydown', event => {
      if (!active) return;
      const { dialog, dismiss } = active;
      if (event.key === 'Escape') {
        event.preventDefault();
        dismiss();
      } else if (event.key === 'Tab') {
        const stops = dialogTabStops(dialog);
        const current = stops.indexOf(document.activeElement);
        const edge = event.shiftKey ? 0 : stops.length - 1;
        if (current < 0 || current === edge) {
          event.preventDefault();
          (stops[event.shiftKey ? stops.length - 1 : 0] || dialog).focus();
        }
      }
    });
  }

  return { bind, open, close, isOpen };
}
