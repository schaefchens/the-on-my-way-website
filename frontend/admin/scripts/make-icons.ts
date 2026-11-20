/**
 * Renders the PWA icons from public/icons/icon.svg (run after changing the SVG):
 *   pnpm --filter @omw/admin icons
 * Outputs icon-192.png, icon-512.png and maskable-512.png (artwork scaled into the 80 % safe zone).
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../public/icons');
const svg = readFileSync(join(DIR, 'icon.svg'));

for (const size of [192, 512]) {
  await sharp(svg, { density: 300 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toFile(join(DIR, `icon-${size}.png`));
}

const inner = Math.round(512 * 0.8);
const art = await sharp(svg, { density: 300 }).resize(inner, inner).png().toBuffer();
await sharp({ create: { width: 512, height: 512, channels: 4, background: '#be4a74' } })
  .composite([{ input: art, gravity: 'center' }])
  .png({ compressionLevel: 9 })
  .toFile(join(DIR, 'maskable-512.png'));

console.log(`Wrote icons to ${DIR}`);
