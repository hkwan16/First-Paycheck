/** "··4821", the mockup's way of showing an account's last digits. */
export function maskLabel(mask: string | null): string | null {
  return mask ? `··${mask}` : null;
}
