/**
 * Turns a Windows computer name into the friendly mDNS-style host name shown to the Admin
 * ("TUNDE-LAPTOP" becomes "infoflex-tunde-laptop"). It is only a label for display and for the optional
 * .local address; it is never used for authentication.
 */
export function friendlyHostName(computerName: string): string {
  const slug = String(computerName ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 40)
  return `infoflex-${slug || 'pharmacy'}`
}
