// Simulation sans réseau : des bots répondent au hasard à toutes les invites.
// node tools/sim.mjs [parties=200]
// Mélange les deux jeux, toutes les extensions, avec/sans MJ, compositions auto/manuelles,
// rôles et événements sur mesure générés au hasard (pour éprouver le moteur de règles).
import { simulate, randomRole, randomEvent } from '../js/simcore.js';
import { ROLE_TEMPLATES, EVENT_TEMPLATES, normalizeRole, normalizeEvent, blankRole, blankEvent } from '../js/rules.js';
import { allRoles } from '../js/roles/index.js';
import '../js/modes.js';

const N = +process.argv[2] || 200;
const results = {};
let errors = 0;

const templates = (game) => ROLE_TEMPLATES.filter((t) => t.game === game).map((t) => normalizeRole({ ...blankRole(game), ...t, id: 'c_t' + Math.random().toString(36).slice(2, 7) }));
const evTemplates = () => EVENT_TEMPLATES.map((t) => normalizeEvent({ ...blankEvent(t.game), ...t, id: 'e_t' + Math.random().toString(36).slice(2, 7), chance: 100 }));

for (let i = 0; i < N; i++) {
  const mode = i % 2 ? 'botc' : 'lg';
  const n = mode === 'botc' ? 5 + (i % 11) : 5 + (i % 14);
  const custom = [...templates(mode), ...Array.from({ length: 3 }, () => randomRole(mode))];
  const events = [...evTemplates(), ...Array.from({ length: 2 }, () => randomEvent(mode))];
  const cfg = {
    mode, n, custom, events, st: i % 5 === 0,
    editions: [['tb'], ['bmr'], ['snv'], ['tb', 'bmr', 'snv']][Math.floor(i / 2) % 4],
    lgEditions: [['base'], ['base', 'nl'], ['base', 'nl', 'perso']][Math.floor(i / 2) % 3],
  };
  if (i % 3 === 1) {
    // composition imposée siège par siège, rôles sur mesure compris
    const pool = (t) => allRoles(mode).filter((r) => !r.custom && (!t || r.team === t)).map((r) => r.id).sort(() => Math.random() - 0.5);
    const seats = mode === 'lg'
      ? ['loup_garou', custom.at(-1).id, custom.at(-2).id, ...pool('village')]
      : [pool('demon')[0], pool('minion')[0], custom.at(-1).id, custom.at(-2).id, ...pool('townsfolk')];
    cfg.roles = seats.slice(0, n);
  }
  const r = await simulate(cfg);
  if (r.error) { errors++; console.log(`✗ partie ${i} (${mode}, ${n}j) : ${r.error}`); if (r.log) console.log('   ' + r.log.slice(-6).join('\n   ')); }
  else { const k = `${mode}:${r.winner?.team}`; results[k] = (results[k] || 0) + 1; }
}
console.log('Résultats', results, 'erreurs', errors);
process.exit(errors ? 1 : 0);
