// Parties artificielles : des bots répondent au hasard. Sert au laboratoire et à tools/sim.mjs.
import { Engine, newState, mkPlayer } from './engine.js';
import { allRoles } from './roles/index.js';
import { TRIGGERS, SCHEDULES, TARGETS, EFFECTS, CONDS, CAMPS, WINS, blankRole, blankAbility, blankEvent, normalizeRole, normalizeEvent } from './rules.js';
import { pick, chance, randInt } from './util.js';

/** Construit une partie prête à démarrer. cfg.roles : liste par siège (ou null = auto). */
export function buildGame(cfg) {
  const host = { id: 'p0', name: cfg.names?.[0] || 'Joueur 1', token: 't0' };
  const s = newState('LABO', host);
  for (let k = 1; k < cfg.n; k++) s.players.push(mkPlayer({ id: 'p' + k, name: cfg.names?.[k] || `Joueur ${k + 1}`, token: 't' + k }, k));
  s.mode = cfg.mode;
  s.custom = cfg.custom || [];
  s.events = cfg.events || [];
  Object.assign(s.options, { editions: cfg.editions || ['tb', 'bmr', 'snv'], lgEditions: cfg.lgEditions || ['base', 'nl', 'perso'], fakeActions: false, stValidates: false }, cfg.options || {});
  if (cfg.st) { s.players.push(mkPlayer({ id: 'mj', name: 'MJ', token: 'tmj' }, cfg.n)); s.stId = 'mj'; }
  const E = new Engine(s, {});
  if (cfg.roles && cfg.roles.length) {
    // rôles imposés siège par siège : on court-circuite la distribution
    s.options.autoRoles = false;
    s.roles = cfg.roles.slice();
    E.forcedSeats = cfg.roles.slice();
  }
  return E;
}

/** Pilote les jours (nominations, fin du jour, lancement du vote) comme le feraient des joueurs. */
export function dayDriver(E, rate = 0.6) {
  const s = E.s, ds = s.dayState;
  if (s.phase !== 'game' || s.cursor.phase !== 'day' || !ds || ds.voting) return false;
  if (Object.values(s.prompts).some((p) => !p.spec.dummy)) return false;
  const ctl = E.p(s.stId || s.hostId);
  const acts = E.alive().flatMap((p) => E.mode.actionsFor(E, p, false).map((a) => [p, a]));
  const abil = acts.filter(([, a]) => a.id === 'ability');
  if (abil.length && chance(0.25)) { const [p, a] = pick(abil); E.action(p.id, { type: 'ability', k: a.k }); return true; }
  if (s.mode === 'botc') {
    if (ds.ended) return false;
    const noms = acts.filter(([, a]) => a.id === 'nominate' && a.pick.length);
    if (noms.length && chance(rate)) { const [p, a] = pick(noms); E.action(p.id, { type: 'nominate', target: pick(a.pick) }); return true; }
    E.mode.action(E, ctl, { type: 'endDay' }, true);
    return true;
  }
  if (ds.stage === 'talk') { E.mode.action(E, ctl, { type: 'startVote' }, true); return true; }
  return false;
}

/** Joue une partie entière, sans délai. */
export function simulate(cfg) {
  return new Promise((resolve) => {
    let E;
    const fail = (err) => resolve({ error: String(err && err.stack || err), winner: null, nights: E?.s.night, log: E?.s.log.slice(-15) });
    try { E = buildGame(cfg); } catch (e) { return fail(e); }
    const s = E.s;
    E.auto = (pr) => E.randomAnswer(pr);
    let steps = 0, done = false;
    const finish = (r) => { if (!done) { done = true; clearInterval(iv); resolve(r); } };
    E.hooks.changed = () => setTimeout(() => { if (++steps < 20000) try { const r = dayDriver(E); if (r && r.catch) r.catch(fail); } catch (e) { finish({ error: String(e.stack || e) }); } }, 0);
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (s.phase === 'end') finish({ winner: s.winner, nights: s.night, days: s.day, cast: E.seated().map((p) => p.role) });
      else if (s.night > 60) finish({ winner: { team: 'interminable', text: 'Plus de 60 nuits' }, nights: s.night });
      else if (Date.now() - t0 > (cfg.timeout || 15000)) finish({ error: `bloquée (nuit ${s.night}, ${s.cursor?.phase}) ${JSON.stringify(Object.values(s.prompts).map((p) => p.spec.title))}`, log: s.log.slice(-15), nights: s.night });
    }, 15);
    const err = E.canStart();
    if (err) return finish({ error: 'composition : ' + err });
    E.start().catch((e) => finish({ error: String(e.stack || e), log: s.log.slice(-15) }));
  });
}

/** Lance N parties et agrège les résultats. */
export async function batch(cfg, N, onProgress) {
  const res = { games: 0, wins: {}, errors: [], nights: 0, roleWins: {} };
  for (let i = 0; i < N; i++) {
    const r = await simulate(cfg);
    res.games++;
    if (r.error) res.errors.push(r);
    else {
      const t = r.winner?.team || 'aucun';
      res.wins[t] = (res.wins[t] || 0) + 1;
      res.nights += r.nights || 0;
    }
    if (onProgress) onProgress(i + 1, res);
  }
  res.avgNights = res.games - res.errors.length ? res.nights / (res.games - res.errors.length) : 0;
  return res;
}

// ---------- générateurs aléatoires (pour éprouver le moteur) ----------
const keys = (o) => Object.keys(o);
export function randomRole(game) {
  const d = blankRole(game);
  d.name = 'Fuzz ' + d.id.slice(2);
  d.team = pick(game === 'lg' ? ['village', 'loup', 'solo'] : ['townsfolk', 'outsider', 'minion', 'demon']);
  d.passives = { ...d.passives, nightImmune: chance(0.2), voteImmune: chance(0.15), lives: chance(0.2) ? 1 : 0, voteWeight: pick([0, 1, 1, 2]), noVote: chance(0.1), joinWolves: chance(0.15), appears: pick(['', '', 'good', 'evil']) };
  d.abilities = Array.from({ length: randInt(1, 3) }, () => {
    const a = blankAbility(pick(keys(TRIGGERS)));
    Object.assign(a, { sched: pick(keys(SCHEDULES)), n: randInt(1, 4), order: randInt(1, 60), uses: pick([0, 0, 1, 2]), cooldown: pick([0, 0, 1]), optional: chance(0.3), chance: pick([100, 100, 50]), state: pick(['alive', 'alive', 'any', 'dead']), askRole: pick(['', '', 'any', 'absent']) });
    a.target = { ...a.target, mode: pick(keys(TARGETS)), n: randInt(1, 3), self: chance(0.3), dead: pick(['no', 'no', 'yes', 'only']), notLast: chance(0.3), v: pick(['marque', 'wolf', 'evil', 'good']), filter: { k: pick(['always', 'always', ...keys(CONDS)]), neg: chance(0.3), v: pick(['marque', '50']) } };
    a.effects = Array.from({ length: randInt(1, 3) }, () => ({ type: pick(keys(EFFECTS)), on: pick(['target', 'target', 'actor']), v: pick(['marque', '2', 'good', 'evil', 'wolf', '@chosen', 'camp', 'Bonjour {cible}']), vis: pick(['secret', 'self', 'public']), if: { k: pick(['always', 'always', ...keys(CONDS)]), neg: chance(0.3), v: pick(['marque', '50']) } }));
    return a;
  });
  d.win = { mode: pick(keys(WINS)), v: pick(['marque', '3']) };
  return normalizeRole(d);
}
export function randomEvent(game) {
  const e = blankEvent(game);
  Object.assign(e, { name: 'Fuzz ' + e.id.slice(2), chance: randInt(30, 100), when: pick(['dawn', 'dusk']), timing: pick(['fixed', 'range', 'every']), n: randInt(1, 3), a: 1, b: 4, every: randInt(10, 60) });
  e.target = { ...e.target, mode: pick(['none', 'random', 'all', 'others', 'tagged', 'camp', 'victim']), n: randInt(1, 2), v: pick(['marque', 'evil', 'wolf']) };
  e.effects = Array.from({ length: randInt(1, 2) }, () => ({ type: pick(keys(EFFECTS).filter((k) => k !== 'win')), on: 'target', v: pick(['marque', '2', 'good', 'Texte']), vis: 'public', if: { k: 'always', neg: false, v: '' } }));
  return normalizeEvent(e);
}
