/** Normalise a MAC to lower-case colon form (aa:bb:cc:dd:ee:ff); null if invalid or all zeros. */
export function normaliseMac(mac: string | null | undefined): string | null {
  if (!mac) return null;
  const hex = mac.toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12 || /^0+$/.test(hex)) return null;
  return hex.match(/../g)!.join(':');
}

/** RFC 1918 private, loopback, link-local or CGNAT IPv4 (also accepts IPv4-mapped IPv6). */
export function isLanAddress(ip: string): boolean {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (v4 === '::1') return true;
  const parts = v4.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}
