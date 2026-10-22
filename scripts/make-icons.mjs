// Generates every PWA icon from your logo.
//   1. Save your logo as public/logo-source.png (or .jpg), ideally square and >= 512px
//   2. npm run icons
// With no source file it renders a placeholder mark so the app still has valid icons.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';

const BG = { r: 11, g: 19, b: 32, alpha: 1 }; // #0b1320
const out = 'public/icons';
mkdirSync(out, { recursive: true });

const source = ['public/logo-source.png', 'public/logo-source.jpg', 'public/logo-source.jpeg', 'public/logo-source.webp'].find(existsSync);
const placeholder = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#0b1320"/><circle cx="256" cy="256" r="150" fill="none" stroke="#45a2e5" stroke-width="26"/><path d="M190 332V180l132 152V180" fill="none" stroke="#00d4ff" stroke-width="30" stroke-linecap="round" stroke-linejoin="round"/></svg>`);
const input = source ?? placeholder;
console.log(source ? `Using ${source}` : 'No public/logo-source.* found, generating a placeholder mark.');

const square = (size, pad = 0) => async () => {
  const inner = Math.round(size * (1 - pad * 2));
  const logo = await sharp(input).resize(inner, inner, { fit: 'contain', background: BG }).png().toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background: BG } })
    .composite([{ input: logo, gravity: 'centre' }]).png().toBuffer();
};

const targets = {
  'icon-192.png': square(192),
  'icon-512.png': square(512),
  'maskable-512.png': square(512, 0.12), // safe zone for adaptive icons
  'apple-touch-icon.png': square(180, 0.04),
};
for (const [name, make] of Object.entries(targets)) writeFileSync(`${out}/${name}`, await make());

const fav = (await square(64)()).toString('base64');
writeFileSync(`${out}/favicon.svg`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><image width="64" height="64" href="data:image/png;base64,${fav}"/></svg>`);
console.log('Icons written to public/icons/');
