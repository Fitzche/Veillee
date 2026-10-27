// Simulation sans réseau : des bots répondent au hasard à toutes les invites.
// node tools/sim.mjs [parties=200]
import { Engine, newState, mkPlayer } from '../js/engine.js';
import { allRoles } from '../js/roles/index.js';
import { blankCustom } from '../js/roles/custom.js';

const N = +process.argv[2] || 200;
const results = {};
let errors = 0, stuck = 0;

function customs() {
  const a = { ...blankCustom('lg'), id: 'c_test1', name: 'Garde-chasse', act: 'kill', when: 'others', uses: 1, deathShot: true };
  const b = { ...blankCustom('botc'), id: 'c_test2', name: 'Augure', act: 'inspect_align', targets: 2 };
  const c = { ...blankCustom('lg'), id: 'c_test3', name: 'Loup timide', team: 'loup', act: 'none', when: 'none', nightImmune: true };
  return [a, b, c];
}

async function game(i) {
  const mode = i % 2 ? 'botc' : 'lg';
  const n = mode === 'botc' ? 5 + (i % 11) : 5 + (i % 14);
  const host = { id: 'p0', name: 'Hôte', token: 't0' };
  const s = newState('TEST', host);
  for (let k = 1; k < n; k++) s.players.push(mkPlayer({ id: 'p' + k, name: 'Bot' + k, token: 't' + k }, k));
  s.mode = mode;
  s.custom = customs();
  s.options.editions = [['tb'], ['bmr'], ['snv'], ['tb', 'bmr', 'snv']][Math.floor(i / 2) % 4];
  s.options.lgEditions = [['base'], ['base', 'nl'], ['base', 'nl', 'perso']][Math.floor(i / 2) % 3];
  if (i % 5 === 0 && n > 5) { s.stId = 'p' + (n - 1); }
  const manual = i % 7 === 3;
  const E = new Engine(s, {});
  if (manual) {
    s.options.autoRoles = false;
    const seats = E.seated().length;
    if (mode === 'lg') {
      const pool = allRoles('lg').filter((r) => !r.wolf && r.id !== 'voleur').map((r) => r.id);
      s.roles = ['loup_garou', 'gml', 'voleur', 'c_test1', 'c_test3', ...pool.sort(() => Math.random() - 0.5)].slice(0, seats + 2);
    } else {
      const by = (t) => allRoles('botc').filter((r) => r.team === t).map((r) => r.id).sort(() => Math.random() - 0.5);
      s.roles = [by('demon')[0], ...by('minion').slice(0, 2), ...by('outsider').slice(0, 2), ...by('townsfolk')].slice(0, seats);
    }
    const err = E.canStart();
    if (err) throw new Error('canStart: ' + err);
  }
  E.auto = (pr) => E.randomAnswer(pr);
  let steps = 0;
  const drive = () => {
    if (s.phase !== 'game') return;
    if (++steps > 4000) return;
    const ds = s.dayState;
    if (s.cursor.phase === 'day' && ds && !ds.voting && !Object.keys(s.prompts).length) {
      const ctl = E.p(s.stId || s.hostId);
      if (mode === 'botc') {
        if (ds.ended) return;
        const acts = E.alive().flatMap((p) => E.mode.actionsFor(E, p, false).map((a) => [p, a]));
        const abil = acts.filter(([, a]) => a.id === 'ability');
        if (abil.length && Math.random() < 0.3) { const [p] = abil[0]; E.action(p.id, { type: 'ability' }); return; }
        const noms = acts.filter(([, a]) => a.id === 'nominate' && a.pick.length);
        if (noms.length && Math.random() < 0.6) { const [p, a] = noms[Math.floor(Math.random() * noms.length)]; E.action(p.id, { type: 'nominate', target: a.pick[Math.floor(Math.random() * a.pick.length)] }); return; }
        E.action(ctl.id, { type: 'endDay' });
      } else if (ds.stage === 'talk') E.action(ctl.id, { type: 'startVote' });
    }
  };
  E.hooks.changed = () => setTimeout(drive, 0);
  const t0 = Date.now();
  const run = E.start();
  await new Promise((res) => {
    const iv = setInterval(() => {
      if (s.phase === 'end') { clearInterval(iv); res(); }
      else if (Date.now() - t0 > 15000) { clearInterval(iv); stuck++; console.log(`BLOQUÉ partie ${i} (${mode}, ${n}j) phase=${s.cursor?.phase} nuit=${s.night} jour=${s.day} prompts=${JSON.stringify(Object.values(s.prompts).map((p) => p.spec.title))} ds=${JSON.stringify(s.dayState)}`); console.log(s.log.slice(-8).join('\n')); res(); }
    }, 20);
  });
  await Promise.race([run, new Promise((r) => setTimeout(r, 10))]);
  const k = `${mode}:${s.winner?.team}`;
  results[k] = (results[k] || 0) + 1;
}

process.on('unhandledRejection', (e) => { errors++; console.error('ERREUR', e); });
for (let i = 0; i < N; i++) {
  try { await game(i); } catch (e) { errors++; console.error(`partie ${i}`, e); }
}
console.log('Résultats', results, 'erreurs', errors, 'bloquées', stuck);
process.exit(errors || stuck ? 1 : 0);
