import { vi } from 'vitest';

/*
 * What a download hands the browser, without navigating: jsdom has no object
 * URLs and cannot follow a link, so `URL.createObjectURL` records the file and
 * an anchor's `click()` records its href and name instead. Call `restore()`
 * in afterEach (with `vi.restoreAllMocks()` for the click spy).
 */

export interface SavedFile {
  href: string;
  download: string;
  /** The anchor was in the document when clicked (Firefox needs that). */
  attached: boolean;
}

export function watchDownloads() {
  const clicks: SavedFile[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicks.push({ href: this.href, download: this.download, attached: this.isConnected });
  });

  const blobs: Blob[] = [];
  const created = vi.fn((blob: Blob) => {
    blobs.push(blob);
    return `blob:http://localhost/${blobs.length}`;
  });
  const revoked = vi.fn();
  const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  URL.createObjectURL = created;
  URL.revokeObjectURL = revoked;

  return {
    clicks,
    blobs,
    revoked,
    restore() {
      URL.createObjectURL = original.create;
      URL.revokeObjectURL = original.revoke;
    },
  };
}
