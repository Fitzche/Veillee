// Moteur de règles des rôles sur mesure et des événements.
// Un rôle = des passifs + une liste de capacités ; une capacité = déclencheur + conditions + cibles + effets.
// Les effets passent par les primitives du mode (attack, protect, regEvil…) pour suivre ses règles.
import { getRole, roleName, allRoles } from './roles/index.js';
import { shuffle, pick, chance, randInt, names } from './util.js';

const rn = (id) => roleName(id); // pas d'alias direct : import circulaire avec roles/index.js

// ---------- vocabulaire (sert aussi à l'éditeur) ----------
export const TRIGGERS = {
  night: '🌙 La nuit',
  day: '☀️ Le jour (bouton)',
  dawn: '🌅 Chaque matin (automatique)',
  death: '💀 À sa mort',
  otherDeath: '⚰️ Quand un autre joueur meurt',
  executed: '⚖️ Quand le village l\'élimine',
};
export const SCHEDULES = {
  each: 'Chaque nuit', first: 'Première nuit seulement', others: 'Chaque nuit sauf la première',
  even: 'Nuits paires', odd: 'Nuits impaires', from: 'À partir de la nuit N', only: 'Seulement la nuit N',
};
export const STATES = { alive: 'Vivant', dead: 'Mort', any: 'Vivant ou mort' };
export const CAUSES = { any: 'N\'importe quelle cause', night: 'La nuit', day: 'Le jour', vote: 'Par le vote', kill: 'Tué par un pouvoir/les loups/le Démon' };
export const TARGETS = {
  none: 'Aucune cible', self: 'Soi-même', choose: 'Choisir des joueurs', random: 'Joueurs au hasard',
  neighbors: 'Ses deux voisins vivants', all: 'Tous les vivants', others: 'Tous les autres vivants',
  killer: 'Son meurtrier (à sa mort)', dead: 'Le joueur qui vient de mourir', victim: 'La victime des loups (LG)',
  tagged: 'Les joueurs portant une étiquette', camp: 'Les joueurs d\'un camp', role: 'Les joueurs d\'un rôle',
};
export const CONDS = {
  always: 'Toujours', evil: 'est Mauvais / loup', good: 'est Bon / villageois', solo: 'est Solitaire',
  wolf: 'est un loup (LG)', demon: 'est un Démon (BotC)', minion: 'est un Sbire (BotC)', outsider: 'est un Étranger (BotC)', townsfolk: 'est un Villageois (BotC)',
  hasRole: 'a le rôle…', chosenRole: 'a le rôle choisi', hasTag: 'porte l\'étiquette…', sameCamp: 'est du même camp que l\'acteur',
  alive: 'est vivant', dead: 'est mort', isActor: 'est l\'acteur', chance: 'chance (%)',
};
// t : par cible · a : agrège toutes les cibles · g : global (sans cible) · v : valeur demandée
export const EFFECTS = {
  kill: { l: '💀 Tuer', k: 't' },
  killForce: { l: '☠️ Tuer (impossible à empêcher)', k: 't' },
  protect: { l: '🛡️ Protéger de la mort cette nuit', k: 't' },
  extraLife: { l: '❤️ Donner une vie supplémentaire', k: 't' },
  revive: { l: '✨ Ressusciter', k: 't' },
  delayedKill: { l: '⏳ Mourra au prochain matin', k: 't' },
  learnRole: { l: '🔍 L\'acteur apprend son rôle', k: 't' },
  learnCamp: { l: '⚖️ L\'acteur apprend son camp', k: 't' },
  learnIsRole: { l: '❓ L\'acteur apprend s\'il a le rôle choisi', k: 't' },
  learnCount: { l: '🔢 L\'acteur apprend combien sont Mauvais', k: 'a' },
  learnAny: { l: '🚨 L\'acteur apprend si au moins un est Mauvais', k: 'a' },
  learnNames: { l: '📜 L\'acteur apprend leurs noms', k: 'a', v: 'withRoles' },
  revealPublic: { l: '📢 Révéler son rôle à tous', k: 't' },
  revealActor: { l: '🪪 La cible apprend le rôle de l\'acteur', k: 't' },
  tell: { l: '✉️ Message privé à la cible', k: 't', v: 'text' },
  announce: { l: '📣 Annonce publique', k: 'g', v: 'text' },
  block: { l: '🚫 Bloquer son pouvoir (jusqu\'au prochain crépuscule)', k: 't' },
  poison: { l: '🧪 Empoisonner (BotC : ivre/empoisonné ; LG : bloqué)', k: 't' },
  mute: { l: '🤐 Ne peut pas voter au prochain vote', k: 't' },
  extraVotes: { l: '🗳️ Voix en plus contre lui au prochain vote', k: 't', v: 'num' },
  voteWeight: { l: '🏋️ Sa voix compte N fois au prochain vote', k: 't', v: 'num' },
  tag: { l: '🏷️ Poser une étiquette', k: 't', v: 'tag' },
  untag: { l: '🧽 Retirer une étiquette', k: 't', v: 'tag' },
  link: { l: '🔗 Lier à l\'acteur (ou les 2 cibles) : ils meurent ensemble', k: 'a' },
  convert: { l: '🔄 Changer de camp', k: 't', v: 'camp' },
  setRole: { l: '🎭 Devient un autre rôle', k: 't', v: 'role' },
  swapRole: { l: '🔀 Échange son rôle avec l\'acteur', k: 't' },
  peace: { l: '🕊️ Personne ne meurt cette nuit (sauf mort imparable)', k: 'g' },
  noVote: { l: '🙊 Pas de vote au prochain jour', k: 'g' },
  doubleVote: { l: '✌️ Deux votes au prochain jour (LG)', k: 'g' },
  powersOff: { l: '🌑 Tous les pouvoirs bloqués jusqu\'au crépuscule', k: 'g' },
  win: { l: '🏆 Victoire immédiate', k: 'g', v: 'winWho' },
};
export const CAMPS = { good: 'Bien / Village', evil: 'Mal / Loups', wolf: 'Loup-Garou (LG)', solo: 'Solitaire' };
export const WINS = {
  team: 'Avec son camp', lastAlive: 'Seul, s\'il est le dernier en vie', allTagged: 'Seul, quand tous les autres vivants portent une étiquette',
  taggedDead: 'Seul, quand tous les porteurs d\'une étiquette sont morts', executed: 'Seul, s\'il est éliminé par le vote', surviveNight: 'Seul, s\'il est vivant au matin de la nuit N',
};
export const EV_TIMINGS = { fixed: 'Une nuit précise', range: 'Une nuit au hasard entre A et B', every: 'Chaque nuit, avec une probabilité' };

// ---------- normalisation ----------
const num = (x, d = 0, a = -999, b = 999) => { const n = Math.round(+x); return Number.isFinite(n) ? Math.max(a, Math.min(b, n)) : d; };
const str = (x, n = 200) => String(x ?? '').slice(0, n);

export function blankAbility(trigger = 'night') {
  return {
    trigger, sched: 'each', n: 2, order: 15, label: '',
    state: trigger === 'death' ? 'any' : 'alive', cause: 'any', uses: 0, cooldown: 0, perDay: true, optional: false, chance: 100, minNight: 0, needDeath: false,
    target: { mode: trigger === 'night' || trigger === 'day' ? 'choose' : 'none', n: 1, min: null, self: false, dead: 'no', notLast: false, v: '', filter: { k: 'always', neg: false, v: '' } },
    askRole: '', effects: [{ type: 'learnRole', on: 'target', v: '', vis: 'secret', if: { k: 'always', neg: false, v: '' } }],
  };
}
export function blankEffect() { return { type: 'kill', on: 'target', v: '', vis: 'secret', if: { k: 'always', neg: false, v: '' } }; }

export function blankRole(game = 'lg') {
  return {
    v: 2, id: 'c_' + Math.random().toString(36).slice(2, 8), game, name: '', icon: '✨', text: '',
    team: game === 'lg' ? 'village' : 'townsfolk',
    passives: { nightImmune: false, voteImmune: false, lives: 0, voteWeight: 1, noVote: false, joinWolves: false, appears: '', multi: false, hideOnDeath: false, knowsCamp: false },
    abilities: [blankAbility('night')],
    win: { mode: 'team', v: '' },
  };
}

export function blankEvent(game = 'lg') {
  return {
    v: 2, id: 'e_' + Math.random().toString(36).slice(2, 8), kind: 'event', game, name: '', icon: '🌩️', text: '',
    chance: 30, when: 'dawn', timing: 'range', n: 2, a: 2, b: 4, every: 20, announce: true,
    target: { mode: 'random', n: 1, self: true, dead: 'no', v: '', filter: { k: 'always', neg: false, v: '' } },
    effects: [{ type: 'kill', on: 'target', v: '', vis: 'secret', if: { k: 'always', neg: false, v: '' } }],
  };
}

function normCond(c) { c = c || {}; return { k: CONDS[c.k] ? c.k : 'always', neg: !!c.neg, v: str(c.v, 40) }; }
function normTarget(t) {
  t = t || {};
  return { mode: TARGETS[t.mode] ? t.mode : 'none', n: num(t.n, 1, 1, 6), min: t.min == null || t.min === '' ? null : num(t.min, 0, 0, 6), self: !!t.self, dead: ['no', 'yes', 'only'].includes(t.dead) ? t.dead : 'no', notLast: !!t.notLast, v: str(t.v, 40), filter: normCond(t.filter) };
}
function normEffect(e) { e = e || {}; return { type: EFFECTS[e.type] ? e.type : 'announce', on: e.on === 'actor' ? 'actor' : 'target', v: str(e.v, 300), vis: ['secret', 'self', 'public'].includes(e.vis) ? e.vis : 'secret', if: normCond(e.if) }; }
function normAbility(a) {
  a = a || {};
  return {
    trigger: TRIGGERS[a.trigger] ? a.trigger : 'night', sched: SCHEDULES[a.sched] ? a.sched : 'each', n: num(a.n, 1, 1, 99), order: num(a.order, 15, 0, 99), label: str(a.label, 40),
    state: STATES[a.state] ? a.state : 'alive', cause: CAUSES[a.cause] ? a.cause : 'any', uses: num(a.uses, 0, 0, 99), cooldown: num(a.cooldown, 0, 0, 9),
    perDay: a.perDay !== false, optional: !!a.optional, chance: num(a.chance, 100, 0, 100), minNight: num(a.minNight, 0, 0, 99), needDeath: !!a.needDeath,
    target: normTarget(a.target), askRole: ['', 'any', 'good', 'evil', 'absent'].includes(a.askRole) ? a.askRole : '',
    effects: (Array.isArray(a.effects) ? a.effects : []).slice(0, 12).map(normEffect),
  };
}

/** Ancien format (v1, un seul pouvoir) → nouveau. */
export function migrate(d) {
  if (!d || d.v === 2) return d;
  const out = blankRole(d.game);
  Object.assign(out, { id: d.id, name: d.name, icon: d.icon, text: d.text, team: d.team });
  out.passives = { ...out.passives, nightImmune: !!d.nightImmune, lives: d.extraLife ? 1 : 0, joinWolves: !!d.joinWolves, appears: d.appears || '', multi: !!d.multi };
  out.abilities = [];
  const map = { kill: 'kill', protect: 'protect', inspect_align: 'learnCamp', inspect_role: 'learnRole', poison: 'poison', revive: 'revive', neighbors: 'learnCount', evil_count: 'learnCount' };
  if (d.act && d.act !== 'none' && d.when !== 'none') {
    const ab = blankAbility('night');
    Object.assign(ab, { sched: d.when === 'first' ? 'first' : d.when === 'others' ? 'others' : 'each', order: d.order || 15, uses: d.uses || 0, optional: !!d.optional });
    ab.target = { ...ab.target, mode: d.act === 'neighbors' ? 'neighbors' : d.act === 'evil_count' ? 'all' : 'choose', n: d.targets || 1, self: !!d.self, dead: d.act === 'revive' ? 'only' : 'no' };
    ab.effects = [{ ...blankEffect(), type: map[d.act] || 'learnRole' }];
    out.abilities.push(ab);
  }
  if (d.deathShot) { const ab = blankAbility('death'); ab.target.mode = 'choose'; ab.effects = [{ ...blankEffect(), type: 'kill' }]; out.abilities.push(ab); }
  return out;
}

export function normalizeRole(d) {
  d = migrate(d);
  if (!d || !d.id || !String(d.name || '').trim()) throw new Error('il faut au moins un nom');
  const teams = d.game === 'lg' ? ['village', 'loup', 'solo'] : ['townsfolk', 'outsider', 'minion', 'demon'];
  if (!teams.includes(d.team)) throw new Error('camp invalide');
  const p = d.passives || {};
  return {
    v: 2, id: str(d.id, 20), game: d.game === 'botc' ? 'botc' : 'lg', name: str(d.name, 40).trim(), icon: str(d.icon || '✨', 4), text: str(d.text, 600), team: d.team,
    passives: { nightImmune: !!p.nightImmune, voteImmune: !!p.voteImmune, lives: num(p.lives, 0, 0, 9), voteWeight: num(p.voteWeight, 1, 0, 9), noVote: !!p.noVote, joinWolves: !!p.joinWolves, appears: ['', 'good', 'evil'].includes(p.appears) ? p.appears : '', multi: !!p.multi, hideOnDeath: !!p.hideOnDeath, knowsCamp: !!p.knowsCamp },
    abilities: (Array.isArray(d.abilities) ? d.abilities : []).slice(0, 8).map(normAbility),
    win: { mode: WINS[d.win?.mode] ? d.win.mode : (d.team === 'solo' ? 'lastAlive' : 'team'), v: str(d.win?.v, 40) },
  };
}

export function normalizeEvent(d) {
  if (!d || !d.id || !String(d.name || '').trim()) throw new Error('il faut au moins un nom');
  return {
    v: 2, kind: 'event', id: str(d.id, 20), game: ['lg', 'botc', 'both'].includes(d.game) ? d.game : 'both', name: str(d.name, 40).trim(), icon: str(d.icon || '🌩️', 4), text: str(d.text, 400),
    chance: num(d.chance, 30, 0, 100), when: d.when === 'dusk' ? 'dusk' : 'dawn', timing: EV_TIMINGS[d.timing] ? d.timing : 'range',
    n: num(d.n, 2, 1, 99), a: num(d.a, 2, 1, 99), b: num(d.b, 4, 1, 99), every: num(d.every, 20, 0, 100), announce: d.announce !== false,
    target: normTarget(d.target), effects: (Array.isArray(d.effects) ? d.effects : []).slice(0, 12).map(normEffect),
  };
}

/** Rôle jouable à partir d'une définition. */
export function compileRole(raw) {
  const d = normalizeRole(raw);
  const lg = d.game === 'lg';
  return {
    id: d.id, custom: true, def: d, game: d.game, ed: 'custom', team: d.team, name: d.name, icon: d.icon,
    text: d.text || describeRole(d), wolf: lg && (d.team === 'loup' || d.passives.joinWolves), multi: d.passives.multi,
    nightImmune: d.passives.nightImmune, appears: d.passives.appears, abilities: d.abilities, passives: d.passives, winRule: d.win,
    setup(E, p) {
      if (d.passives.lives) p.f.lives = d.passives.lives;
      if (d.passives.noVote) p.f.noVote = true;
      if (d.passives.hideOnDeath) p.f.hideRole = true;
    },
  };
}

// ---------- exécution ----------
const camp = (E, t) => (E.s.mode === 'lg' && (t.f.wolf || getRole(t.role)?.wolf) && getRole(t.role)?.team !== 'solo') ? 'evil' : t.align;
const isWolf = (t) => !!(t.f.wolf || getRole(t.role)?.wolf);
const upcomingDay = (E) => (E.s.cursor?.phase === 'night' ? E.s.night : E.s.day);
const fmt = (text, c) => String(text || '').replace(/\{acteur\}/g, c.actor?.name || '?').replace(/\{cible\}/g, c.target?.name || '?').replace(/\{role\}/g, c.target ? rn(c.target.role) : '?');

function test(E, cond, t, c) {
  let r;
  switch (cond.k) {
    case 'always': r = true; break;
    case 'evil': r = camp(E, t) === 'evil'; break;
    case 'good': r = camp(E, t) === 'good'; break;
    case 'solo': r = t.align === 'solo'; break;
    case 'wolf': r = isWolf(t); break;
    case 'demon': case 'minion': case 'outsider': case 'townsfolk': r = getRole(t.role)?.team === cond.k; break;
    case 'hasRole': r = t.role === cond.v; break;
    case 'chosenRole': r = !!c.role && t.role === c.role; break;
    case 'hasTag': r = !!(t.f.tags && t.f.tags[cond.v]); break;
    case 'sameCamp': r = !!c.actor && camp(E, t) === camp(E, c.actor); break;
    case 'alive': r = t.alive; break;
    case 'dead': r = !t.alive; break;
    case 'isActor': r = t === c.actor; break;
    case 'chance': r = chance((+cond.v || 50) / 100); break;
    default: r = true;
  }
  return cond.neg ? !r : r;
}

function nightMatches(ab, n) {
  switch (ab.sched) {
    case 'first': return n === 1;
    case 'others': return n > 1;
    case 'even': return n % 2 === 0;
    case 'odd': return n % 2 === 1;
    case 'from': return n >= ab.n;
    case 'only': return n === ab.n;
    default: return true;
  }
}

function stateOk(ab, p) { return ab.state === 'any' || (ab.state === 'alive' ? p.alive : !p.alive); }

function ready(E, p, ab, k, phase) {
  const u = (p.f.u || {})[k] || {};
  if (ab.uses && (u.n || 0) >= ab.uses) return false;
  if (ab.minNight && E.s.night < ab.minNight) return false;
  if (ab.needDeath && E.s.g.deathDay !== E.s.day) return false;
  if (phase === 'night' && ab.cooldown && u.night && E.s.night - u.night <= ab.cooldown) return false;
  if (phase === 'day' && ab.perDay && u.day === E.s.day) return false;
  return true;
}

/** Entrées de la file de nuit pour un joueur au rôle sur mesure. */
export function nightEntries(E, p, r) {
  const out = [];
  (r.abilities || []).forEach((ab, k) => {
    if (ab.trigger !== 'night' || !nightMatches(ab, E.s.night) || !stateOk(ab, p)) return;
    out.push({ pid: p.id, rid: r.id, o: ab.order, k });
  });
  return out;
}

/** Boutons de jour proposés par un rôle sur mesure. */
export function dayActions(E, p) {
  const r = getRole(p.seen || p.role);
  if (!r || !r.abilities) return [];
  return r.abilities.map((ab, k) => ({ ab, k })).filter(({ ab, k }) => ab.trigger === 'day' && stateOk(ab, p) && ready(E, p, ab, k, 'day'))
    .map(({ ab, k }) => ({ k, label: ab.label || `${r.icon} ${r.name}` }));
}

export async function runAbilityAt(E, p, rid, k, ctx = {}) {
  const r = getRole(rid);
  const ab = r && r.abilities && r.abilities[k];
  if (!ab) return;
  return runAbility(E, p, r, ab, k, ctx);
}

async function runAbility(E, p, r, ab, k, ctx) {
  const phase = E.s.cursor?.phase;
  if (!ready(E, p, ab, k, ctx.trigger === 'day' ? 'day' : ctx.trigger ? 'other' : 'night')) return;
  if (ab.chance < 100 && !chance(ab.chance / 100)) return;
  const title = ab.label || `${r.icon} ${r.name}`;
  if (ab.optional && ab.target.mode !== 'choose') { if (!(await E.yesno(p, title, 'Utiliser ce pouvoir maintenant ?'))) return; }
  const c = { ...ctx, actor: p, role: null };
  const u = ((p.f.u = p.f.u || {})[k] = (p.f.u || {})[k] || {});
  const targets = await resolveTargets(E, ab.target, c, { title, optional: ab.optional || ab.uses > 0, last: u.lt || [] });
  if (ab.target.mode === 'choose' && !targets.length) return;
  if (ab.askRole) c.role = await E.chooseRole(p, `${title} : choisis un rôle`, roleChoices(E, ab.askRole));
  u.n = (u.n || 0) + 1;
  if (phase === 'night') u.night = E.s.night; else u.day = E.s.day;
  u.lt = targets.map((t) => t.id);
  const M = E.mode;
  c.real = M.real(E, p) && !blocked(E, p);
  c.lies = M.lies(E, p);
  await applyEffects(E, ab.effects, targets, c);
}

const blocked = (E, p) => (p.f.blockUntil || 0) > E.s.clock;

function roleChoices(E, kind) {
  let ids = (E.s.g.script && E.s.g.script.length ? E.s.g.script : allRoles(E.s.mode).map((r) => r.id));
  const tm = (id) => getRole(id)?.team;
  if (kind === 'good') ids = ids.filter((id) => ['townsfolk', 'outsider', 'village'].includes(tm(id)));
  if (kind === 'evil') ids = ids.filter((id) => ['minion', 'demon', 'loup'].includes(tm(id)));
  if (kind === 'absent') ids = ids.filter((id) => !E.inPlay(id));
  return ids.length ? ids : allRoles(E.s.mode).map((r) => r.id);
}

async function resolveTargets(E, t, c, o = {}) {
  const a = c.actor;
  let list;
  const alive = E.alive();
  switch (t.mode) {
    case 'self': list = a ? [a] : []; break;
    case 'choose': {
      if (!a) { list = []; break; }
      const min = o.optional ? 0 : t.min ?? t.n;
      list = await E.choose(a, {
        n: t.n, min, self: t.self, dead: t.dead === 'yes', deadOnly: t.dead === 'only', title: o.title,
        text: (min === 0 ? 'Tu peux ne choisir personne.' : '') + (t.notLast ? ' Pas la même cible que la dernière fois.' : ''),
        filter: (x) => (!t.notLast || !o.last.includes(x.id)) && test(E, t.filter, x, c),
      });
      return list;
    }
    case 'random': list = shuffle(alive.filter((x) => t.self || x !== a)).filter((x) => test(E, t.filter, x, c)).slice(0, t.n); return list;
    case 'neighbors': list = a ? E.neighbors(a) : []; break;
    case 'all': list = alive; break;
    case 'others': list = alive.filter((x) => x !== a); break;
    case 'killer': list = c.by ? [c.by] : []; break;
    case 'dead': list = c.dead ? [c.dead] : []; break;
    case 'victim': { const v = E.s.nd && E.s.nd.wolfVictim && E.p(E.s.nd.wolfVictim); list = v ? [v] : []; break; }
    case 'tagged': list = E.seated().filter((x) => x.f.tags && x.f.tags[t.v] && (x.alive || t.dead !== 'no')); break;
    case 'camp': list = alive.filter((x) => (t.v === 'wolf' ? isWolf(x) : camp(E, x) === t.v)); break;
    case 'role': list = alive.filter((x) => x.role === t.v); break;
    default: list = [];
  }
  return list.filter((x) => test(E, t.filter, x, c));
}

async function applyEffects(E, effects, targets, c) {
  for (const eff of effects) {
    if (E.s.winner) return;
    const kind = EFFECTS[eff.type]?.k;
    if (kind === 'g') {
      // Effet global : sa condition est remplie si au moins une cible la remplit (ou l'acteur, sans cible).
      let ok = eff.if.k === 'always';
      if (!ok && targets.length) ok = targets.some((t) => test(E, eff.if, t, { ...c, target: t }));
      else if (!ok && c.actor) ok = test(E, eff.if, c.actor, c);
      else if (!ok) ok = eff.if.k === 'chance' && test(E, eff.if, { f: {} }, c);
      if (ok) await effect(E, eff, null, c, targets);
      continue;
    }
    const ts = targets.filter((t) => test(E, eff.if, t, c));
    if (kind === 'a') { if (ts.length || eff.type === 'learnCount') await effect(E, eff, null, c, ts); continue; }
    for (const t of ts) await effect(E, eff, eff.on === 'actor' ? c.actor : t, { ...c, target: t }, ts);
  }
}

async function effect(E, eff, t, c, ts) {
  const M = E.mode, s = E.s, a = c.actor, real = c.real !== false, lies = !!c.lies, lg = s.mode === 'lg';
  const say = (txt, title) => a && E.tell(a, txt, title ? { title } : {});
  const evilWord = (b) => (lg ? (b ? 'un loup' : 'pas un loup') : (b ? 'Mauvais' : 'Bon'));
  const otherRole = (id) => pick(allRoles(s.mode).map((r) => r.id).filter((x) => x !== id)) || id;
  if (!t && EFFECTS[eff.type].k === 't') return;
  switch (eff.type) {
    case 'kill': if (real) await M.attack(E, a, t, 'pouvoir', false); break;
    case 'killForce': if (real) await M.attack(E, a, t, 'pouvoir', true); break;
    case 'protect': if (real) t.f.shield = s.cursor.phase === 'night' ? s.night : s.day + 1; break;
    case 'extraLife': if (real) t.f.lives = (t.f.lives || 0) + 1; break;
    case 'revive': if (real && !t.alive) { t.alive = true; t.ghost = true; t.dead = null; delete t.f.revealed; E.pub(`✨ ${t.name} revient à la vie !`); } break;
    case 'delayedKill': if (real) (s.g.delayed = s.g.delayed || []).push({ id: t.id, n: s.cursor.phase === 'night' ? s.night : s.day + 1 }); break;
    case 'learnRole': { let r = M.regRole(E, t); if (lies) r = otherRole(t.role); await say(`${t.name} est ${rn(r)}.`); break; }
    case 'learnCamp': { let b = M.regEvil(E, t); if (lies) b = !b; await say(`${t.name} est ${evilWord(b)}.`); break; }
    case 'learnIsRole': { const r = c.role || eff.v; let y = t.role === r; if (lies) y = !y; await say(`${t.name} ${y ? 'est' : 'n\'est pas'} ${rn(r)}.`); break; }
    case 'learnCount': { let n = ts.filter((x) => M.regEvil(E, x)).length; if (lies) n = Math.max(0, n + (chance(0.5) ? 1 : -1)); await say(`${n} joueur(s) ${lg ? 'loup(s)' : 'Mauvais'} parmi ${names(ts) || 'personne'}.`); break; }
    case 'learnAny': { let y = ts.some((x) => M.regEvil(E, x)); if (lies) y = !y; await say(`${names(ts)} : ${y ? `au moins un est ${evilWord(true)}` : `aucun n'est ${evilWord(true)}`}.`); break; }
    case 'learnNames': await say(ts.length ? ts.map((x) => (eff.v === 'withRoles' ? `${x.name} (${rn(x.role)})` : x.name)).join(', ') : 'Personne.'); break;
    case 'revealPublic': if (real) { t.f.revealed = t.role; E.pub(`📢 ${t.name} est ${rn(t.role)} ${getRole(t.role)?.icon || ''}.`); } break;
    case 'revealActor': if (a) await E.tell(t, `${a.name} est ${rn(a.role)}.`); break;
    case 'tell': await E.tell(t, fmt(eff.v, c) || '…', { title: a ? `${getRole(a.role)?.icon || ''} ${rn(a.role)}` : 'Événement' }); break;
    case 'announce': E.pub(fmt(eff.v, c) || '…', 'mj'); break;
    case 'block': if (real) t.f.blockUntil = Math.max(t.f.blockUntil || 0, s.clock + 2); break;
    case 'poison': if (real) { if (lg) t.f.blockUntil = Math.max(t.f.blockUntil || 0, s.clock + 2); else M.poison(E, t); } break;
    case 'mute': if (real) t.f.muteDay = upcomingDay(E); break;
    case 'extraVotes': if (real) { (s.g.extra = s.g.extra || {})[t.id] = { day: upcomingDay(E), n: +eff.v || 2 }; } break;
    case 'voteWeight': if (real) t.f.weight = { day: upcomingDay(E), n: Math.max(0, +eff.v || 2) }; break;
    case 'tag': if (real && eff.v) { (t.f.tags = t.f.tags || {})[eff.v] = eff.vis; if (eff.vis === 'self') await E.tell(t, `On t'a marqué : « ${eff.v} ».`, { silent: true }); } break;
    case 'untag': if (real && t.f.tags) delete t.f.tags[eff.v]; break;
    case 'link': {
      if (!real) break;
      const pair = ts.length >= 2 ? ts.slice(0, 2) : a && ts[0] ? [a, ts[0]] : null;
      if (pair && pair[0] !== pair[1]) { (s.g.links = s.g.links || []).push(pair.map((x) => x.id)); for (const [x, y] of [pair, pair.slice().reverse()]) await E.tell(x, `🔗 Ton destin est lié à ${y.name} : si l'un meurt, l'autre aussi.`, { silent: true }); }
      break;
    }
    case 'convert': {
      if (!real) break;
      const v = eff.v || 'evil';
      if (lg) { t.f.wolf = v === 'wolf' || v === 'evil'; if (v === 'good') t.f.wolf = false; }
      t.align = v === 'wolf' ? 'evil' : v;
      await E.tell(t, `🔄 Ton camp change : tu es désormais ${v === 'wolf' ? 'Loup-Garou' : CAMPS[v] || v}.`, { silent: true });
      break;
    }
    case 'setRole': {
      const r = eff.v === '@chosen' || !eff.v ? c.role : eff.v;
      if (!real || !getRole(r)) break;
      t.role = r; t.seen = r; t.align = M.alignOf(E, t);
      const nr = getRole(r); if (nr.setup) try { nr.setup(E, t); } catch { }
      await E.tell(t, `🎭 Tu deviens ${rn(r)} ${nr.icon}. ${nr.text}`, { title: 'Ton rôle', silent: true });
      break;
    }
    case 'swapRole': {
      if (!real || !a || a === t) break;
      [a.role, t.role] = [t.role, a.role]; [a.align, t.align] = [t.align, a.align];
      a.seen = a.role; t.seen = t.role;
      await E.tell(a, `🔀 Tu as pris le rôle de ${t.name} : tu es ${rn(a.role)}.`, { silent: true });
      await E.tell(t, `🔀 ${a.name} a échangé son rôle avec le tien : tu es ${rn(t.role)}.`, { silent: true });
      break;
    }
    case 'peace': if (s.cursor.phase === 'night') s.nd.peace = true; else s.g.peaceNight = s.day + 1; break;
    case 'noVote': s.g.noVoteDay = upcomingDay(E); break;
    case 'doubleVote': s.g.doubleVoteDay = upcomingDay(E); break;
    case 'powersOff': for (const x of E.seated()) x.f.blockUntil = Math.max(x.f.blockUntil || 0, s.clock + 2); break;
    case 'win': {
      if (!real) break;
      if (eff.v === 'camp' && a) E.win(camp(E, a) === 'evil' ? 'evil' : camp(E, a), `${a.name} (${rn(a.role)}) fait gagner son camp !`);
      else if (eff.v === 'good' || eff.v === 'evil') E.win(eff.v, eff.v === 'good' ? 'Le Bien / le Village l\'emporte !' : 'Le Mal / les Loups l\'emportent !');
      else E.win('solo', a ? `${a.name} (${rn(a.role)}) gagne seul !` : 'Victoire !');
      break;
    }
  }
}

// ---------- crochets appelés par les modes ----------
/** Mort d'un joueur : vies, liens, capacités « à sa mort » et « quand un autre meurt ». */
export async function fireDeath(E, p, cause, by) {
  const s = E.s;
  const night = s.cursor?.phase === 'night';
  const kind = cause === 'vote' || cause === 'exec' ? 'vote' : ['demon', 'loups', 'pouvoir', 'assassin', 'godfather', 'slayer', 'chasseur', 'sorciere'].includes(cause) ? 'kill' : 'other';
  const causeOk = (ab) => ab.cause === 'any' || (ab.cause === 'night' && night) || (ab.cause === 'day' && !night) || ab.cause === kind;
  const r = getRole(p.seen || p.role);
  if (r && r.abilities) {
    for (const [k, ab] of r.abilities.entries()) if (ab.trigger === 'death' && causeOk(ab) && !s.winner) await runAbility(E, p, r, ab, k, { trigger: 'death', by, cause });
  }
  for (const pair of s.g.links || []) {
    if (!pair.includes(p.id)) continue;
    const o = E.p(pair.find((id) => id !== p.id));
    if (o && o.alive && !s.winner) { E.pub(`🔗 ${o.name} était lié(e) à ${p.name}…`); await E.mode.forceDeath(E, o, 'lien'); }
  }
  for (const q of E.seated()) {
    if (q === p || s.winner) continue;
    const qr = getRole(q.seen || q.role);
    if (!qr || !qr.abilities) continue;
    for (const [k, ab] of qr.abilities.entries()) if (ab.trigger === 'otherDeath' && stateOk(ab, q) && causeOk(ab) && !s.winner) await runAbility(E, q, qr, ab, k, { trigger: 'otherDeath', dead: p, by, cause });
  }
}

/** Élimination par le vote : renvoie true si le joueur survit. */
export async function fireExecuted(E, p) {
  const r = getRole(p.role);
  if (!r || !r.custom) return false;
  if (r.winRule?.mode === 'executed') { E.win('solo', `${p.name} (${r.name}) voulait être éliminé : il gagne seul !`); return true; }
  for (const [k, ab] of r.abilities.entries()) if (ab.trigger === 'executed' && !E.s.winner) await runAbility(E, p, r, ab, k, { trigger: 'executed' });
  if (r.passives.voteImmune && !p.f.voteImmuneUsed) {
    p.f.voteImmuneUsed = true; p.f.revealed = p.role;
    E.pub(`🛡️ ${p.name} est ${r.name} : le vote ne peut pas l'éliminer.`);
    return true;
  }
  return false;
}

/** Début de nuit : paix programmée, événements du crépuscule. */
export async function fireDusk(E) {
  const s = E.s;
  if (s.g.peaceNight === s.night) s.nd.peace = true;
  await runEvents(E, 'dusk');
}

/** Matin : morts différées, capacités « chaque matin », événements de l'aube, victoires sur mesure. */
export async function fireDawn(E) {
  const s = E.s;
  for (const d of (s.g.delayed || []).filter((x) => x.n === s.night)) {
    const t = E.p(d.id);
    if (t && t.alive && !s.winner) { E.pub(`⏳ ${t.name} succombe…`); await E.mode.forceDeath(E, t, 'maléfice'); }
  }
  s.g.delayed = (s.g.delayed || []).filter((x) => x.n > s.night);
  for (const p of E.seated()) {
    const r = getRole(p.seen || p.role);
    if (!r || !r.abilities || s.winner) continue;
    for (const [k, ab] of r.abilities.entries()) if (ab.trigger === 'dawn' && stateOk(ab, p) && !s.winner) await runAbility(E, p, r, ab, k, { trigger: 'dawn' });
  }
  if (!s.winner) await runEvents(E, 'dawn');
  if (!s.winner) { const w = customWin(E, true); if (w) E.win(w.team, w.text); }
}

/** Victoires sur mesure (appelé par la vérification de victoire de chaque mode). */
export function customWin(E, dawn = false) {
  const A = E.alive();
  for (const p of E.seated()) {
    const r = getRole(p.role);
    if (!r || !r.custom || !p.alive) continue;
    const w = r.winRule, v = w.v;
    const lbl = `${p.name} (${r.name})`;
    if (w.mode === 'lastAlive' && A.length === 1) return { team: 'solo', text: `${lbl} est le dernier survivant : il gagne seul !` };
    if (w.mode === 'allTagged' && v && A.length > 1 && A.every((x) => x === p || (x.f.tags && x.f.tags[v]))) return { team: 'solo', text: `${lbl} a marqué tous les vivants (« ${v} ») : il gagne seul !` };
    if (w.mode === 'taggedDead' && v) { const tg = E.seated().filter((x) => x !== p && x.f.tags && x.f.tags[v]); if (tg.length && tg.every((x) => !x.alive)) return { team: 'solo', text: `${lbl} a vu mourir tous les « ${v} » : il gagne seul !` }; }
    if (w.mode === 'surviveNight' && dawn && E.s.night >= (+v || 3)) return { team: 'solo', text: `${lbl} a survécu jusqu'à la nuit ${+v || 3} : il gagne seul !` };
  }
  return null;
}

/** Joueurs Solitaires sur mesure encore en lice (ils empêchent la victoire du village en LG). */
export const customSoloAlive = (E) => E.alive().some((x) => { const r = getRole(x.role); return r && r.custom && r.team === 'solo'; });

// ---------- événements ----------
export function rollEvents(E) {
  const s = E.s;
  s.g.ev = [];
  for (const raw of s.events || []) {
    let ev; try { ev = normalizeEvent(raw); } catch { continue; }
    if (ev.game !== 'both' && ev.game !== s.mode) continue;
    if (!chance(ev.chance / 100)) continue;
    const e = { id: ev.id };
    if (ev.timing === 'fixed') e.night = ev.n;
    else if (ev.timing === 'range') e.night = randInt(Math.min(ev.a, ev.b), Math.max(ev.a, ev.b));
    else e.every = ev.every;
    s.g.ev.push(e);
  }
  E.log('Événements tirés : ' + (s.g.ev.map((e) => `${(s.events.find((x) => x.id === e.id) || {}).name}${e.night ? ` (nuit ${e.night})` : ' (chaque nuit ?)'}`).join(', ') || 'aucun'));
  if (s.options.announceEvents && s.g.ev.length) E.pub(`🎲 Événements possibles dans cette partie : ${s.g.ev.map((e) => { const d = s.events.find((x) => x.id === e.id); return `${d.icon} ${d.name}`; }).join(', ')}.`, 'mj');
}

async function runEvents(E, when) {
  const s = E.s;
  for (const e of s.g.ev || []) {
    if (s.winner) return;
    const raw = (s.events || []).find((x) => x.id === e.id);
    if (!raw) continue;
    const ev = normalizeEvent(raw);
    if (ev.when !== when) continue;
    const fires = e.night ? e.night === s.night : chance((e.every || 0) / 100);
    if (!fires) continue;
    await runEvent(E, ev);
  }
}

export async function runEvent(E, ev) {
  E.log(`Événement : ${ev.name}`);
  if (ev.announce) E.pub(`${ev.icon} ${ev.name}${ev.text ? ` — ${ev.text}` : ''}`, 'event');
  const c = { actor: null, real: true, lies: false };
  const targets = await resolveTargets(E, ev.target, c, {});
  await applyEffects(E, ev.effects, targets, c);
  E.checkWin();
}

// ---------- descriptions en français ----------
function condText(c) {
  if (!c || c.k === 'always') return '';
  const v = c.k === 'hasRole' ? rn(c.v) : c.v;
  const base = CONDS[c.k].replace('…', `« ${v} »`).replace('(%)', `${c.v || 50} %`);
  return c.neg ? `n'${base.replace(/^est /, 'est pas ').replace(/^a /, 'a pas ').replace(/^porte /, 'porte pas ')}` : base;
}
function targetText(t) {
  let s = TARGETS[t.mode] || '';
  if (t.mode === 'choose' || t.mode === 'random') s = `${t.mode === 'choose' ? 'choisit' : 'prend au hasard'} ${t.n} joueur${t.n > 1 ? 's' : ''}${t.dead === 'only' ? ' mort(s)' : t.dead === 'yes' ? ' (morts compris)' : ''}${t.self ? ' (lui compris)' : ''}${t.notLast ? ', jamais deux fois le même' : ''}`;
  if (t.mode === 'tagged') s += ` « ${t.v} »`;
  if (t.mode === 'camp') s += ` ${CAMPS[t.v] || t.v}`;
  if (t.mode === 'role') s += ` ${rn(t.v)}`;
  const f = condText(t.filter);
  return s.toLowerCase() + (f ? ` qui ${f}` : '');
}
function effectText(e) {
  let s = EFFECTS[e.type].l.replace(/^\S+\s/, '');
  if (e.v && EFFECTS[e.type].v) s += e.type === 'setRole' ? ` (${e.v === '@chosen' ? 'rôle choisi' : rn(e.v)})` : e.type === 'convert' ? ` (${CAMPS[e.v] || e.v})` : e.type === 'win' ? '' : ` (${e.v})`;
  if (e.on === 'actor' && EFFECTS[e.type].k === 't') s = `l'acteur subit : ${s.toLowerCase()}`;
  const c = condText(e.if);
  return s + (c ? (EFFECTS[e.type].k === 'g' ? ` si au moins une cible ${c}` : ` si la cible ${c}`) : '');
}
export function describeAbility(ab) {
  const when = ab.trigger === 'night' ? `${SCHEDULES[ab.sched].replace('N', ab.n)}` : TRIGGERS[ab.trigger].replace(/^\S+\s/, '');
  const lim = [ab.uses ? `${ab.uses} fois par partie` : '', ab.cooldown ? `repos de ${ab.cooldown} nuit(s)` : '', ab.chance < 100 ? `${ab.chance} % de chance` : '', ab.state !== 'alive' && ab.trigger !== 'death' ? (ab.state === 'dead' ? 'une fois mort' : 'même mort') : ''].filter(Boolean).join(', ');
  const tgt = ab.target.mode === 'none' ? '' : `, ${targetText(ab.target)}`;
  const role = ab.askRole ? ', choisit un rôle' : '';
  return `${when}${lim ? ` (${lim})` : ''}${tgt}${role} : ${ab.effects.map(effectText).join(' ; ') || 'rien'}.`;
}
export function describeRole(d) {
  const p = d.passives || {};
  const pas = [p.nightImmune && 'ne peut pas mourir la nuit', p.voteImmune && 'survit une fois au vote', p.lives && `${p.lives} vie(s) en plus`, p.voteWeight !== 1 && p.voteWeight != null && `sa voix compte ${p.voteWeight} fois`, p.noVote && 'ne vote pas', p.joinWolves && 'se réveille avec les loups', p.appears && `apparaît ${p.appears === 'evil' ? 'Mauvais' : 'Bon'}`].filter(Boolean);
  const parts = (d.abilities || []).map(describeAbility);
  if (pas.length) parts.push(pas.join(', ').replace(/^./, (x) => x.toUpperCase()) + '.');
  if (d.win && d.win.mode !== 'team') parts.push(`Victoire : ${WINS[d.win.mode].toLowerCase().replace('une étiquette', `l'étiquette « ${d.win.v} »`).replace('la nuit n', `la nuit ${d.win.v}`)}.`);
  return parts.join(' ') || 'Aucun pouvoir.';
}
export function describeEvent(ev) {
  const when = ev.timing === 'fixed' ? `nuit ${ev.n}` : ev.timing === 'range' ? `une nuit entre ${ev.a} et ${ev.b}` : `chaque nuit (${ev.every} %)`;
  return `${ev.chance} % de chance d'être dans la partie. ${ev.when === 'dawn' ? 'Au matin' : 'Au crépuscule'}, ${when} : ${targetText(ev.target)} — ${ev.effects.map(effectText).join(' ; ') || 'rien'}.`;
}

// ---------- modèles prêts à l'emploi ----------
const E_ = (type, x = {}) => ({ ...blankEffect(), type, ...x });
const A_ = (trigger, x = {}, tg = {}, effects = []) => { const a = blankAbility(trigger); Object.assign(a, x); a.target = { ...a.target, ...tg }; a.effects = effects; return a; };
export const ROLE_TEMPLATES = [
  { name: 'Garde du corps', icon: '🛡️', game: 'lg', team: 'village', text: 'Chaque nuit, protège un joueur de la mort (pas deux fois de suite le même).', abilities: [A_('night', { order: 10 }, { mode: 'choose', notLast: true, self: true }, [E_('protect')])] },
  { name: 'Augure', icon: '🦉', game: 'lg', team: 'village', abilities: [A_('night', { order: 12 }, { mode: 'choose', n: 2 }, [E_('learnAny')])] },
  { name: 'Ensorceleuse', icon: '🧙', game: 'lg', team: 'solo', text: 'Chaque nuit, ensorcelle un joueur. Gagne seule quand tous les vivants sont ensorcelés.', abilities: [A_('night', { order: 35 }, { mode: 'choose', filter: { k: 'hasTag', neg: true, v: 'ensorcelé' } }, [E_('tag', { v: 'ensorcelé', vis: 'self' })])], win: { mode: 'allTagged', v: 'ensorcelé' } },
  { name: 'Vengeur', icon: '🗡️', game: 'lg', team: 'village', text: 'S\'il est tué la nuit, son meurtrier… enfin, un loup au hasard meurt.', abilities: [A_('death', { cause: 'night', state: 'any' }, { mode: 'camp', v: 'wolf' }, [])] },
  { name: 'Parieur fou', icon: '🎲', game: 'botc', team: 'townsfolk', text: 'Chaque nuit, devine le rôle d\'un joueur : juste, tu l\'apprends en entier ; faux, tu meurs.', abilities: [A_('night', { order: 20, sched: 'others', askRole: 'any' }, { mode: 'choose' }, [E_('kill', { on: 'actor', if: { k: 'chosenRole', neg: true, v: '' } }), E_('tell', { on: 'actor', v: 'Bien vu : {cible} est bien {role}.', if: { k: 'chosenRole', neg: false, v: '' } })])] },
  { name: 'Héritier', icon: '👑', game: 'lg', team: 'village', text: 'La première nuit, choisis un mentor. À sa mort, tu prends son rôle.', abilities: [A_('night', { order: 4, sched: 'first' }, { mode: 'choose' }, [E_('tag', { v: 'mentor', vis: 'secret' })]), A_('otherDeath', {}, { mode: 'dead', filter: { k: 'hasTag', neg: false, v: 'mentor' } }, [E_('swapRole')])] },
];
// Le Vengeur tue un seul loup au hasard : cible « camp loup » filtrée en aléatoire.
ROLE_TEMPLATES[3].abilities[0].target = { ...ROLE_TEMPLATES[3].abilities[0].target, mode: 'random', n: 1, self: false, filter: { k: 'wolf', neg: false, v: '' } };
ROLE_TEMPLATES[3].abilities[0].effects = [E_('kill')];

export const EVENT_TEMPLATES = [
  { name: 'Pleine lune', icon: '🌕', game: 'lg', text: 'Les pouvoirs du village sont brouillés cette nuit.', chance: 40, when: 'dusk', timing: 'range', a: 2, b: 4, target: { mode: 'none' }, effects: [E_('powersOff')] },
  { name: 'Épidémie', icon: '🦠', game: 'both', text: 'Un mal mystérieux frappe le village.', chance: 25, when: 'dawn', timing: 'range', a: 2, b: 5, target: { mode: 'random', n: 1, self: true }, effects: [E_('kill')] },
  { name: 'Trêve', icon: '🕊️', game: 'both', text: 'Personne ne mourra cette nuit.', chance: 30, when: 'dusk', timing: 'every', every: 15, target: { mode: 'none' }, effects: [E_('peace')] },
  { name: 'Grand procès', icon: '⚖️', game: 'lg', text: 'Le village votera deux fois aujourd\'hui.', chance: 30, when: 'dawn', timing: 'range', a: 2, b: 4, target: { mode: 'none' }, effects: [E_('doubleVote')] },
  { name: 'Aveux', icon: '📢', game: 'both', text: 'Le rôle d\'un joueur est dévoilé.', chance: 30, when: 'dawn', timing: 'range', a: 2, b: 5, target: { mode: 'random', n: 1, self: true }, effects: [E_('revealPublic')] },
];
