import type { RokuApp } from '../src/ecp/types.js';

/**
 * Installed "channels" for the mock TV. Well-known ids where we know them (Netflix 12, YouTube 837,
 * Prime Video 13, Hulu 2285, Disney+ 291097, The Roku Channel 151908); the rest are illustrative.
 * Your real TV's ids come from /query/apps and are shown by `npm run status`.
 */
export const DEFAULT_APPS: RokuApp[] = [
  { id: '12', name: 'Netflix', type: 'appl', version: '5.2.83' },
  { id: '837', name: 'YouTube', type: 'appl', version: '2.21.100' },
  { id: '44444', name: 'YouTube Kids', type: 'appl', version: '1.7.0' },
  { id: '23333', name: 'PBS KIDS', type: 'appl', version: '4.3.2' },
  { id: '291097', name: 'Disney Plus', type: 'appl', version: '1.60.0' },
  { id: '13', name: 'Prime Video', type: 'appl', version: '14.3.2' },
  { id: '2285', name: 'Hulu', type: 'appl', version: '8.9.1' },
  { id: '151908', name: 'The Roku Channel', type: 'appl', version: '2.4.15' },
  { id: 'tvinput.hdmi1', name: 'Game console', type: 'tvin', version: '1.0.0' },
  { id: 'tvinput.dtv', name: 'Live TV', type: 'tvin', version: '1.0.0' },
];

export const DEV_CHANNEL: RokuApp = { id: 'dev', name: 'Parental Control', type: 'appl', version: '1.0.0' };

export const SCREENSAVER: RokuApp = { id: '55545', name: 'Roku City', type: 'ssvr', version: '2.0.1' };

const PALETTE = ['#e50914', '#ff0033', '#2b7de9', '#00a8e1', '#1ce783', '#6c2bd9', '#f5a623', '#0f9d58', '#455a64'];

/** Deterministic SVG "icon" with the app's initials. */
export function iconSvg(app: RokuApp): string {
  let hash = 0;
  for (const ch of app.id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const color = PALETTE[hash % PALETTE.length]!;
  const initials =
    app.name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join('') || '?';
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="290" height="218" viewBox="0 0 290 218">
  <rect width="290" height="218" rx="18" fill="${color}"/>
  <text x="145" y="132" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="84" font-weight="700" fill="#fff" text-anchor="middle">${initials}</text>
</svg>`;
}
