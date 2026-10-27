// Vérifie qu'un effet global (victoire) respecte sa condition « si au moins une cible… ».
import { buildGame } from '../js/simcore.js';
import { blankRole, blankAbility, blankEffect, normalizeRole } from '../js/rules.js';
import '../js/modes.js';

function role(who = 'camp', cond = { k: 'demon', neg: false, v: '' }) {
  const d = blankRole('botc');
  d.id = 'c_chasseurdemon'; d.name = 'Chasseur de démon';
  const a = blankAbility('night');
  a.sched = 'each'; a.order = 1;
  a.target = { ...a.target, mode: 'choose', n: 1 };
  a.effects = [{ ...blankEffect(), type: 'win', v: who, if: cond }];
  d.abilities = [a];
  return normalizeRole(d);
}

async function run(pickDemon, who, cond) {
  const r = role(who, cond);
  const E = buildGame({ mode: 'botc', n: 5, custom: [r], roles: [r.id, 'imp', 'poisoner', 'washerwoman', 'chef'] });
  let picked = false;
  E.auto = (pr) => {
    if (pr.pid === 'p0' && pr.spec.title.includes('Chasseur de démon')) { picked = true; return [pickDemon ? 'p1' : 'p3']; }
    return E.randomAnswer(pr);
  };
  E.start();
  await new Promise((res) => { const iv = setInterval(() => { if (picked || E.s.phase === 'end') { clearInterval(iv); setTimeout(res, 50); } }, 5); });
  return E.s.winner;
}

const always = { k: 'always', neg: false, v: '' };
const yes = await run(true), no = await run(false);
const tgt = await run(false, 'target', always);          // désigne la Lavandière (p3) : elle gagne seule
const tcamp = await run(true, 'targetCamp', always);     // désigne le Diablotin : le Mal gagne
const ok = yes?.team === 'good' && !no && tgt?.team === 'solo' && /Joueur 4/.test(tgt.text) && tcamp?.team === 'evil';
console.log('cible = Démon →', yes?.text || 'pas de victoire');
console.log('cible ≠ Démon →', no?.text || 'pas de victoire (attendu)');
console.log('« la cible » →', tgt?.text);
console.log('« le camp de la cible » (Démon) →', tcamp?.text, '/', tcamp?.team);
console.log(ok ? 'OK' : 'ÉCHEC');
process.exit(ok ? 0 : 1);
