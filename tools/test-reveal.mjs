// Vérifie les modes de révélation des Loups-Garous : clair, flou, obscur.
import { buildGame, dayDriver } from '../js/simcore.js';
import '../js/modes.js';

const inherent = (p) => ['idiot', 'vv', 'ange', 'servante'].includes(p.f.revealed) && p.f.revealed !== p.role ? false : ['idiot', 'vv', 'ange'].includes(p.role);
function play(mode) {
  return new Promise((res) => {
    const E = buildGame({ mode: 'lg', n: 9, lgEditions: ['base'], options: { revealMode: mode } });
    E.auto = (pr) => E.randomAnswer(pr);
    E.hooks.changed = () => setTimeout(() => dayDriver(E), 0);
    E.start();
    const iv = setInterval(() => { if (E.s.phase === 'end' || E.s.night > 40) { clearInterval(iv); res(E); } }, 5);
  });
}
const night = (p) => ['loups', 'sorciere', 'tetanos', 'pouvoir', 'maléfice'].includes(p.dead.cause) || p.dead.dawn;
let bad = 0;
const stats = {};
for (const mode of ['clair', 'flou', 'obscur']) {
  const st = (stats[mode] = { morts: 0, révélés: 0, nuitRévélés: 0, jourRévélés: 0, jourMorts: 0 });
  for (let i = 0; i < 60; i++) {
    const E = await play(mode);
    for (const p of E.seated().filter((x) => !x.alive && x.dead)) {
      if (inherent(p)) continue;
      st.morts++;
      const rev = !!p.f.revealed;
      if (rev) st.révélés++;
      if (night(p)) { if (rev) st.nuitRévélés++; } else { st.jourMorts++; if (rev) st.jourRévélés++; }
    }
  }
  if (mode === 'clair' && st.révélés !== st.morts) bad++;
  if (mode === 'obscur' && st.révélés !== 0) bad++;
  if (mode === 'flou' && (st.nuitRévélés !== 0 || st.jourRévélés === 0)) bad++;
}
console.log(stats);
console.log(bad ? 'ÉCHEC' : 'OK');
process.exit(bad ? 1 : 0);
