/**
 * jsdom has `<dialog>` but not `showModal()` or `close()`. This stands in for
 * the parts the app relies on: opening sets `open` and focuses the first
 * control, Escape on an open modal fires a cancelable `cancel` and closes it
 * unless that was prevented, and closing fires `close`. What only a browser
 * does (the top layer, making the rest of the page inert, giving focus back)
 * is checked in the Playwright smoke spec instead.
 */
export function installDialog() {
  // Files that run in the node environment (`@vitest-environment node`) have no DOM.
  if (typeof HTMLDialogElement === 'undefined') return;
  const proto = HTMLDialogElement.prototype;
  if (typeof proto.showModal === 'function') return;

  const onKeyDown = (event: KeyboardEvent) => {
    const dialog = event.currentTarget as HTMLDialogElement;
    if (event.key !== 'Escape' || !dialog.open) return;
    const cancel = new Event('cancel', { cancelable: true });
    if (dialog.dispatchEvent(cancel)) dialog.close();
  };

  proto.showModal = function showModal(this: HTMLDialogElement) {
    if (this.open) return;
    this.setAttribute('open', '');
    this.addEventListener('keydown', onKeyDown);
    const first = this.querySelector<HTMLElement>(
      '[autofocus], input:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    first?.focus();
  };
  proto.close = function close(this: HTMLDialogElement) {
    if (!this.open) return;
    this.removeAttribute('open');
    this.removeEventListener('keydown', onKeyDown);
    this.dispatchEvent(new Event('close'));
  };
}
