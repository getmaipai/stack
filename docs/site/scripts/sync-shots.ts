// Copies the admin screenshots the site uses from docs/images/admin (the one place they live)
// into public/screens at build time, so the site never holds a second tracked copy.
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const src = join(here, '../../images/admin');
const dest = join(here, '../public/screens');
const features = JSON.parse(readFileSync(join(here, '../features.json'), 'utf8'));
const names = new Set<string>(['overview']);
for (const a of features.areas) if (a.visual?.shot) names.add(a.visual.shot);
mkdirSync(dest, { recursive: true });
for (const n of names)
  for (const theme of ['light', 'dark'])
    copyFileSync(join(src, `${n}-desktop-${theme}.webp`), join(dest, `${n}-desktop-${theme}.webp`));
console.log(`synced ${names.size * 2} screenshots`);
