// node tools/bump.mjs 1.2.0 : change la version de l'appli et du cache hors ligne.
import { readFileSync, writeFileSync } from 'node:fs';
const v = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(v || '')) { console.error('usage : node tools/bump.mjs X.Y.Z'); process.exit(1); }
const f = (p) => new URL('../' + p, import.meta.url);
writeFileSync(f('js/version.js'), readFileSync(f('js/version.js'), 'utf8').replace(/VERSION = '[^']*'/, `VERSION = '${v}'`));
writeFileSync(f('sw.js'), readFileSync(f('sw.js'), 'utf8').replace(/const V = '[^']*'/, `const V = 'veillee-${v}'`));
console.log('version', v);
