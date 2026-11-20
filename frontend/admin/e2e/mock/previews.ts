/**
 * Private preview images of the mock API: small, deterministic "postcard" scenes as SVG (the
 * real API serves 640w WebP; the admin just shows whatever image the URL returns).
 */
import type { SeedCapture } from './seed';

function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

const SKIES: Array<[string, string, string]> = [
  ['#ffd6a5', '#f4a3bc', '#be4a74'],
  ['#c9e4f6', '#9ec5e8', '#5d7fa6'],
  ['#ffe3c2', '#f6b98d', '#c46a3c'],
  ['#d7f0dd', '#9fd3b0', '#4e9a7a'],
  ['#e8dcff', '#bca4f2', '#5d3fa0'],
  ['#2c2550', '#4b3d7a', '#f4a3bc'],
];

function escapeXml(s: string): string {
  return s.replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c] ?? c,
  );
}

export function previewSvg(c: SeedCapture): string {
  const h = hash(c.sourceKey);
  const [top, mid, ground] = SKIES[h % SKIES.length] ?? ['#ffd6a5', '#f4a3bc', '#be4a74'];
  const portrait = (c.media?.h ?? 4) >= (c.media?.w ?? 3);
  const W = 640;
  const H = portrait ? 800 : 480;
  const sunX = 140 + (h % 360);
  const sunY = H * (0.22 + ((h >> 8) % 20) / 100);
  const hill = (y: number, amp: number, seed: number) =>
    `M0 ${y} C ${W * 0.25} ${y - amp - (seed % 40)}, ${W * 0.55} ${y + amp}, ${W} ${y - amp / 2} L ${W} ${H} L 0 ${H} Z`;
  const lanterns = /later|lantern|hội an/i.test(c.caption ?? '')
    ? Array.from({ length: 6 }, (_, i) => {
        const x = 70 + i * 100 + ((h >> i) % 30);
        const y = 90 + ((h >> (i + 3)) % 80);
        return `<line x1="${x}" y1="0" x2="${x}" y2="${y - 18}" stroke="#3b2341" stroke-opacity=".4" stroke-width="2"/><ellipse cx="${x}" cy="${y}" rx="22" ry="28" fill="#e2463f" fill-opacity=".85"/><ellipse cx="${x}" cy="${y}" rx="12" ry="20" fill="#ffd27a" fill-opacity=".7"/>`;
      }).join('')
    : '';
  const label = c.caption ? escapeXml(c.caption) : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${top}"/><stop offset="0.65" stop-color="${mid}"/><stop offset="1" stop-color="${ground}"/>
    </linearGradient>
    <radialGradient id="sun" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#fff8f6" stop-opacity=".95"/><stop offset="1" stop-color="#fff8f6" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#sky)"/>
  <circle cx="${sunX}" cy="${sunY}" r="120" fill="url(#sun)"/>
  <circle cx="${sunX}" cy="${sunY}" r="42" fill="#fff8f6" fill-opacity=".9"/>
  ${lanterns}
  <path d="${hill(H * 0.68, 50, h)}" fill="${ground}" fill-opacity=".55"/>
  <path d="${hill(H * 0.8, 36, h >> 4)}" fill="#3b2341" fill-opacity=".35"/>
  ${label ? `<text x="${W / 2}" y="${H - 34}" text-anchor="middle" font-family="Georgia, serif" font-size="30" fill="#fff8f6" fill-opacity=".92">${label}</text>` : ''}
</svg>`;
}
