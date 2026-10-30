// Design-sync build step (cfg.buildCmd). Run from the repo root on Windows:
//   1. emits .d.ts files for web/src/ui into .design-sync/.cache/types (the converter's API source);
//   2. copies Cascadia Code / Cascadia Mono from the Windows font folder into
//      .design-sync/.cache/fonts with an @font-face sheet (cfg.extraFonts). Portly itself ships no
//      web fonts; the design-sync bundle carries these so designs render the mono stack as intended.
// Both outputs are gitignored and regenerated on every sync.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, '.design-sync/pkg/tsconfig.json')], { stdio: 'inherit' });

const fontsDir = join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts');
const outDir = join(root, '.design-sync/.cache/fonts');
mkdirSync(outDir, { recursive: true });
const faces = [];
for (const family of ['Cascadia Code', 'Cascadia Mono']) {
  const file = `${family.replace(' ', '')}.ttf`;
  const from = join(fontsDir, file);
  if (!existsSync(from)) {
    console.error(`prepare: ${file} not found in ${fontsDir}; designs will use the fallback mono font`);
    continue;
  }
  copyFileSync(from, join(outDir, file));
  faces.push(`@font-face {\n  font-family: '${family}';\n  src: url('./${file}') format('truetype');\n  font-weight: 200 700;\n  font-style: normal;\n  font-display: swap;\n}\n`);
}
writeFileSync(join(outDir, 'cascadia.css'), faces.join('\n'));
console.log(`prepare: types emitted, ${faces.length} font face(s) written`);
