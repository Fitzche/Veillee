// Les Loups-Garous de Thiercelieux : jeu de base, Nouvelle Lune, Personnages / Le Village.
import { register, getRole, roleName, allRoles } from './roles/index.js';
import { shuffle, pick, chance, names } from './util.js';
import { nightEntries, runAbilityAt, dayActions, fireDeath, fireExecuted, customWin } from './rules.js';

const rn = roleName;
export const isWolf = (p) => !!(p.f.wolf || getRole(p.role)?.wolf);
const powers = (E, p) => !(E.s.g.noPowers && getRole(p.role)?.team === 'village') && !((p.f.blockUntil || 0) > E.s.clock);

const R = [];
const def = (ed, team, id, name, icon, text, x = {}) => R.push({ game: 'lg', ed, team, id, name, icon, text, ...x });

// ===== Jeu de base =====
def('base', 'loup', 'loup_garou', 'Loup-Garou', '🐺', 'Chaque nuit, avec les autres loups, dévore un villageois. Gagne quand tous les villageois sont morts.', { wolf: true, multi: true });
def('base', 'village', 'villageois', 'Simple Villageois', '🧑‍🌾', 'Aucun pouvoir, sauf son flair et sa voix au vote.', { multi: true });
def('base', 'village', 'voyante', 'Voyante', '🔮', 'Chaque nuit, découvre le rôle d\'un joueur.', {
  first: 12, other: 12, async night(E, p) {
    const t = await E.choose1(p, { title: 'Voyante : quel joueur sondes-tu ?' });
    if (t) await E.tell(p, `${t.name} est ${rn(t.role)}${t.f.wolf && !getRole(t.role).wolf ? '' : ''}.`);
  },
});
def('base', 'village', 'sorciere', 'Sorcière', '🧪', 'Possède une potion de vie (sauve la victime des loups) et une potion de mort (tue un joueur), une fois chacune.', {
  first: 30, other: 30, async night(E, p) {
    const nd = E.s.nd, v = nd.wolfVictim && E.p(nd.wolfVictim);
    if (!p.f.lifeUsed && v) {
      if (await E.yesno(p, 'Sorcière', `Les loups ont attaqué ${v.name}. Utiliser ta potion de vie ?`)) { p.f.lifeUsed = true; nd.saved = true; }
    } else if (v) await E.tell(p, `Les loups ont attaqué ${v.name}.`, { silent: true });
    else await E.tell(p, 'Les loups n\'ont attaqué personne cette nuit.', { silent: true });
    if (!p.f.deathUsed) {
      const t = await E.choose(p, { n: 1, min: 0, self: true, title: 'Sorcière : potion de mort ?', text: 'Ne choisis personne pour la garder.' });
      if (t[0]) { p.f.deathUsed = true; nd.kills.push({ id: t[0].id, cause: 'sorciere', force: true }); }
    }
  },
});
def('base', 'village', 'chasseur', 'Chasseur', '🔫', 'En mourant, il abat immédiatement un joueur de son choix.');
def('base', 'village', 'cupidon', 'Cupidon', '💘', 'La première nuit, désigne deux amoureux. Si l\'un meurt, l\'autre meurt de chagrin. S\'ils sont de camps opposés, ils gagnent ensemble.', {
  first: 2, async night(E, p) {
    const ts = await E.choose(p, { n: 2, self: true, title: 'Cupidon : désigne les deux amoureux' });
    if (ts.length !== 2) return;
    E.s.g.lovers = ts.map((t) => t.id);
    for (const [a, b] of [[ts[0], ts[1]], [ts[1], ts[0]]]) await E.tell(a, `💘 Tu es amoureux de ${b.name}, qui est ${rn(b.role)}. Si l'un meurt, l'autre aussi.`, { title: 'Cupidon' });
  },
});
def('base', 'village', 'petite_fille', 'Petite Fille', '👧', 'Chaque nuit, peut espionner les loups : elle découvre l\'un d\'eux, mais risque d\'être repérée.', {
  first: 24, other: 24, async night(E, p) {
    if (!(await E.yesno(p, 'Petite Fille', 'Entrouvrir les yeux et espionner les loups ?'))) return;
    const wolves = E.alive().filter(isWolf);
    if (!wolves.length) return;
    const w = pick(wolves);
    await E.tell(p, `Tu aperçois un loup : ${w.name}.`);
    if (chance(0.3)) for (const x of wolves) await E.tell(x, `👀 La Petite Fille vous a espionnés : c'est ${p.name} !`, { silent: true });
  },
});
def('base', 'village', 'voleur', 'Voleur', '🦹', 'La première nuit, peut échanger sa carte contre l\'une des deux cartes restées au centre.', {
  first: 1, async night(E, p) {
    const c = E.s.g.center || [];
    if (!c.length) return;
    const bothWolves = c.every((r) => getRole(r)?.wolf);
    const opts = c.map((r, i) => ({ v: String(i), l: `${getRole(r).icon} ${rn(r)}` }));
    if (!bothWolves) opts.unshift({ v: 'keep', l: 'Rester Voleur (Simple Villageois)' });
    const ch = await E.choice(p, 'Voleur : quelle carte prends-tu ?', opts, bothWolves ? 'Les deux cartes sont des loups : tu dois en prendre une.' : '');
    if (ch === 'keep') return;
    const r = c[+ch];
    c[+ch] = 'voleur';
    p.role = r; p.seen = r; p.align = alignOf(p);
    await E.tell(p, `Tu es désormais ${rn(r)}. ${getRole(r).text}`, { title: 'Ton rôle' });
    const rr = getRole(r);
    if (rr.night && rr.first != null) E.queueLater({ pid: p.id, rid: r, o: rr.first });
  },
});

// ===== Nouvelle Lune =====
def('nl', 'village', 'ancien', 'Ancien', '👴', 'Survit à la première attaque des loups. S\'il est tué par le village, le Chasseur ou la Sorcière, les villageois perdent leurs pouvoirs.');
def('nl', 'village', 'bouc', 'Bouc émissaire', '🐐', 'En cas d\'égalité au vote, c\'est lui qui est éliminé.');
def('nl', 'village', 'idiot', 'Idiot du village', '🤡', 'S\'il est désigné par le vote, il est épargné et révélé, mais ne vote plus.');
def('nl', 'solo', 'flutiste', 'Joueur de flûte', '🪈', 'Chaque nuit, charme deux joueurs. Gagne seul quand tous les vivants sont charmés.', {
  first: 35, other: 35, async night(E, p) {
    const ts = await E.choose(p, { n: 2, title: 'Joueur de flûte : qui charmes-tu ?', filter: (x) => !x.f.charmed });
    ts.forEach((t) => (t.f.charmed = true));
    const ch = E.alive().filter((x) => x.f.charmed);
    for (const t of ts) await E.tell(t, `🎵 Tu as été charmé(e). Les charmés : ${names(ch)}.`, { silent: true });
  },
});
def('nl', 'village', 'salvateur', 'Salvateur', '🛡️', 'Chaque nuit, protège un joueur (lui-même compris) de l\'attaque des loups, jamais deux fois de suite le même.', {
  first: 10, other: 10, async night(E, p) {
    const t = await E.choose1(p, { self: true, title: 'Salvateur : qui protèges-tu ?', filter: (x) => x.id !== p.f.last });
    if (t) { p.f.last = t.id; t.f.safeN = E.s.night; }
  },
});

// ===== Personnages / Le Village =====
def('perso', 'solo', 'sectaire', 'Abominable Sectaire', '🕯️', 'Le village est coupé en deux groupes. Gagne seul quand tous les joueurs de l\'autre groupe sont morts.', {
  setup(E, p) {
    const others = shuffle(E.seated().filter((x) => x !== p));
    const A = [p.id, ...others.slice(0, Math.floor(others.length / 2)).map((x) => x.id)];
    E.s.g.sect = { owner: p.id, A };
  },
});
def('perso', 'solo', 'ange', 'Ange', '👼', 'La partie commence par un vote. S\'il est éliminé au premier vote, il gagne seul ; sinon il devient Simple Villageois.');
def('perso', 'village', 'chevalier', 'Chevalier à l\'épée rouillée', '⚔️', 'S\'il est dévoré, le premier loup à sa gauche meurt du tétanos la nuit suivante.');
def('perso', 'village', 'chien_loup', 'Chien-Loup', '🐕', 'La première nuit, choisit d\'être Simple Villageois ou Loup-Garou.', {
  first: 5, async night(E, p) {
    const v = await E.choice(p, 'Chien-Loup : quel camp choisis-tu ?', [{ v: 'village', l: '🧑‍🌾 Village' }, { v: 'loup', l: '🐺 Loups' }]);
    if (v === 'loup') { p.f.wolf = true; p.align = 'evil'; await E.tell(p, 'Tu rejoins la meute : tu te réveilles désormais avec les loups.'); }
  },
});
def('perso', 'village', 'comedien', 'Comédien', '🎭', 'Trois rôles de villageois sont mis de côté ; chaque nuit, il peut utiliser le pouvoir de l\'un d\'eux (une fois chacun).', {
  first: 8, other: 8,
  setup(E, p) {
    const pool = R.filter((r) => r.team === 'village' && r.night && !['comedien', 'cupidon', 'voleur', 'chien_loup', 'enfant_sauvage', 'deux_soeurs', 'trois_freres'].includes(r.id) && !E.inPlay(r.id)).map((r) => r.id);
    p.f.cards = shuffle(pool).slice(0, 3);
  },
  async night(E, p) {
    const cards = p.f.cards || [];
    if (!cards.length) return;
    const ch = await E.choice(p, 'Comédien : quel rôle joues-tu cette nuit ?', [{ v: '-', l: 'Aucun' }, ...cards.map((r) => ({ v: r, l: `${getRole(r).icon} ${rn(r)}` }))]);
    if (ch === '-') return;
    p.f.cards = cards.filter((r) => r !== ch);
    await getRole(ch).night(E, p, {});
  },
});
def('perso', 'village', 'deux_soeurs', 'Deux Sœurs', '👭', 'Les deux sœurs se connaissent et peuvent se concerter.', { pack: 2, first: 6, async night(E, p) { const o = E.withRole('deux_soeurs').filter((x) => x !== p); await E.tell(p, `Ta sœur : ${names(o) || 'aucune'}.`, { silent: true }); } });
def('perso', 'village', 'trois_freres', 'Trois Frères', '👬', 'Les trois frères se connaissent et peuvent se concerter.', { pack: 3, first: 7, async night(E, p) { const o = E.withRole('trois_freres').filter((x) => x !== p); await E.tell(p, `Tes frères : ${names(o) || 'aucun'}.`, { silent: true }); } });
def('perso', 'village', 'enfant_sauvage', 'Enfant sauvage', '🧒', 'La première nuit, choisit un modèle. Si le modèle meurt, il devient Loup-Garou.', {
  first: 4, async night(E, p) {
    const t = await E.choose1(p, { title: 'Enfant sauvage : choisis ton modèle' });
    if (t) { p.f.model = t.id; await E.tell(p, `Ton modèle est ${t.name}.`, { silent: true }); }
  },
});
def('perso', 'loup', 'gml', 'Grand Méchant Loup', '🐺', 'Loup-Garou. Tant qu\'aucun loup n\'est mort, il dévore seul une victime de plus chaque nuit.', {
  wolf: true, other: 22, async night(E, p) {
    if (E.seated().some((x) => isWolf(x) && !x.alive)) return;
    const t = await E.choose(p, { n: 1, min: 0, title: 'Grand Méchant Loup : une seconde victime ?', filter: (x) => !isWolf(x) && x.id !== E.s.nd.wolfVictim });
    if (t[0]) E.s.nd.kills.push({ id: t[0].id, cause: 'loups' });
  },
});
def('perso', 'loup', 'infect', 'Infect Père des Loups', '🦠', 'Loup-Garou. Une fois par partie, il peut infecter la victime des loups : elle devient loup en secret au lieu de mourir.', {
  wolf: true, other: 21, async night(E, p) {
    const v = E.s.nd.wolfVictim && E.p(E.s.nd.wolfVictim);
    if (p.f.used || !v) return;
    if (await E.yesno(p, 'Infect Père des Loups', `Infecter ${v.name} au lieu de le dévorer ?`)) { p.f.used = true; E.s.nd.infect = true; }
  },
});
def('perso', 'village', 'juge', 'Juge bègue', '⚖️', 'Une fois par partie, il peut déclencher un second vote juste après le premier.');
def('perso', 'solo', 'loup_blanc', 'Loup-Garou Blanc', '🤍', 'Se réveille avec les loups, mais une nuit sur deux, il peut dévorer un loup. Gagne seul.', {
  wolf: true, other: 23, async night(E, p) {
    if (E.s.night % 2) return;
    const t = await E.choose(p, { n: 1, min: 0, title: 'Loup Blanc : dévorer un loup ?', filter: (x) => isWolf(x) });
    if (t[0]) E.s.nd.kills.push({ id: t[0].id, cause: 'loups' });
  },
});
def('perso', 'village', 'montreur', 'Montreur d\'ours', '🐻', 'Chaque matin, si l\'un de ses voisins vivants est un loup, l\'ours grogne.');
def('perso', 'village', 'renard', 'Renard', '🦊', 'Chaque nuit, flaire un groupe de 3 voisins : s\'il n\'y a aucun loup, il perd son pouvoir.', {
  first: 13, other: 13, async night(E, p) {
    if (p.f.lost) return;
    const t = await E.choose1(p, { self: true, title: 'Renard : choisis le centre du groupe à flairer' });
    if (!t) return;
    const grp = [t, ...E.neighbors(t)];
    const y = grp.some(isWolf);
    if (!y) p.f.lost = true;
    await E.tell(p, `${names(grp)} : ${y ? 'au moins un loup se cache parmi eux.' : 'aucun loup. Tu perds ton flair.'}`);
  },
});
def('perso', 'village', 'servante', 'Servante dévouée', '🧹', 'Quand un joueur est éliminé par le vote, elle peut prendre son rôle en secret.');
def('perso', 'village', 'vv', 'Villageois-Villageois', '🙋', 'Simple Villageois dont la carte est visible de tous : il est innocent, c\'est prouvé.', { setup(E, p) { p.f.revealed = p.role; } });
def('perso', 'village', 'corbeau', 'Corbeau', '🐦‍⬛', 'Chaque nuit, désigne un joueur qui aura deux voix de plus contre lui au prochain vote.', {
  first: 36, other: 36, async night(E, p) {
    const t = await E.choose(p, { n: 1, min: 0, title: 'Corbeau : qui accuses-tu ?' });
    if (t[0]) E.s.g.corbeau = { id: t[0].id, day: E.s.night };
  },
});

register(R);
export const LG_ROLES = R;

function alignOf(p) {
  const r = getRole(p.role);
  if (isWolf(p) && r.team !== 'solo') return 'evil';
  if (r.team === 'solo') return 'solo';
  return r.team === 'loup' ? 'evil' : 'good';
}

// ---------- morts ----------
async function lgDie(E, p, cause) {
  if (!p || !p.alive) return;
  const s = E.s;
  const r = getRole(p.role);
  if (p.f.lives > 0 && cause !== 'chagrin' && cause !== 'lien') { p.f.lives--; E.log(`${p.name} perd une vie supplémentaire.`); return; }
  p.alive = false;
  p.dead = { cause, day: s.day, night: s.night };
  if (s.options.revealOnDeath && !p.f.hideRole) p.f.revealed = p.role;
  E.pub(`💀 ${p.name} meurt${p.f.revealed ? ` — c'était ${rn(p.role)} ${getRole(p.role).icon}` : ''}.`, 'death');
  E.log(`${p.name} (${rn(p.role)}) meurt [${cause}]`);
  if (p.role === 'ancien' && ['vote', 'chasseur', 'sorciere'].includes(cause) && !s.g.noPowers) {
    s.g.noPowers = true;
    E.pub('👴 Le village a tué son Ancien : les villageois perdent leurs pouvoirs !');
  }
  if (s.g.captain === p.id) {
    s.g.captain = null;
    const t = await E.choose1(p, { title: '👑 Capitaine : désigne ton successeur' });
    if (t) { s.g.captain = t.id; E.pub(`👑 ${t.name} devient Capitaine.`); }
  }
  if (s.g.lovers && s.g.lovers.includes(p.id)) {
    const o = E.p(s.g.lovers.find((id) => id !== p.id));
    if (o && o.alive) { E.pub(`💔 ${o.name} meurt de chagrin.`); await lgDie(E, o, 'chagrin'); }
  }
  for (const es of E.alive().filter((x) => x.role === 'enfant_sauvage' && x.f.model === p.id && !x.f.wolf)) {
    es.f.wolf = true; es.align = 'evil';
    await E.tell(es, 'Ton modèle est mort : tu deviens Loup-Garou et rejoins la meute.', { silent: true });
  }
  await fireDeath(E, p, cause);
  const shooter = p.role === 'chasseur' && !s.g.noPowers;
  if (shooter && !E.s.winner) {
    const t = await E.choose1(p, { title: `${r.icon} ${r.name} : sur qui tires-tu en mourant ?` });
    if (t) { E.pub(`${r.icon} ${p.name} abat ${t.name} !`); await lgDie(E, t, 'chasseur'); }
  }
  E.checkWin();
}

function lgImmune(E, t, cause) {
  if (t.f.safeN === E.s.night && cause === 'loups') return true;
  if (t.f.shield === E.s.night && E.s.cursor.phase === 'night') return true;
  const r = getRole(t.role);
  if (r.custom && r.nightImmune && E.s.cursor.phase === 'night') return true;
  if (t.role === 'ancien' && cause === 'loups' && !t.f.hurt) { t.f.hurt = true; return true; }
  return false;
}

async function lgVote(E, title, opts = {}) {
  const s = E.s;
  const voters = E.alive().filter((x) => !x.f.noVote && x.f.muteDay !== s.day);
  s.dayState.voting = { done: [], total: voters.length, title };
  E.changed();
  const res = await Promise.all(voters.map(async (v) => {
    const t = await E.ask(v.id, { type: 'players', n: 1, min: 0, title, text: opts.text || 'Désigne le joueur à éliminer (ou personne pour voter blanc).', options: (opts.cands || E.alive()).filter((x) => opts.self || x !== v).map((x) => x.id) });
    s.dayState.voting && s.dayState.voting.done.push(v.id); E.changed();
    return [v, t[0]];
  }));
  s.dayState.voting = null;
  const tally = {};
  const lines = [];
  for (const [v, t] of res) {
    if (!t) continue;
    let w = s.options.captain && s.g.captain === v.id && !opts.noCaptain ? 2 : 1;
    if (!opts.noCaptain) w *= v.f.weight && v.f.weight.day === s.day ? v.f.weight.n : getRole(v.role)?.passives?.voteWeight ?? 1;
    if (!w) continue;
    tally[t] = (tally[t] || 0) + w;
    lines.push(`${v.name} → ${E.p(t).name}${w > 1 ? ' (×2)' : ''}`);
  }
  const cb = s.g.corbeau;
  if (cb && cb.day === s.day && opts.corbeau && E.p(cb.id)?.alive) tally[cb.id] = (tally[cb.id] || 0) + 2;
  if (opts.corbeau) for (const [id, x] of Object.entries(s.g.extra || {})) if (x.day === s.day && E.p(id)?.alive) tally[id] = (tally[id] || 0) + x.n;
  E.pub(`🗳️ ${title} — ${lines.join(' · ') || 'que des votes blancs'}`, 'vote');
  const max = Math.max(0, ...Object.values(tally));
  if (!max) return null;
  const top = Object.keys(tally).filter((id) => tally[id] === max).map((id) => E.p(id));
  if (top.length === 1) return top[0];
  const cap = s.g.captain && E.p(s.g.captain);
  if (opts.tie === 'random') return pick(top);
  if (cap && cap.alive && s.options.captain) {
    const t = await E.ask(cap.id, { type: 'players', n: 1, title: '👑 Égalité : le Capitaine tranche', options: top.map((x) => x.id) });
    E.pub(`👑 Le Capitaine ${cap.name} tranche.`);
    return E.p(t[0]);
  }
  const bouc = E.alive().find((x) => x.role === 'bouc');
  if (bouc && powers(E, bouc)) { E.pub('🐐 Égalité : le Bouc émissaire est sacrifié.'); return bouc; }
  E.pub('Égalité : personne n\'est éliminé.');
  return null;
}

async function eliminate(E, t) {
  const s = E.s;
  if (!t) return;
  E.pub(`⚖️ Le village élimine ${t.name}.`, 'exec');
  if (t.role === 'ange' && !s.g.firstVoteDone) { t.alive = false; t.f.revealed = 'ange'; return E.win('solo', `L'Ange (${t.name}) a été éliminé au premier vote : il gagne seul !`); }
  if (t.role === 'idiot' && !t.f.noVote && powers(E, t)) {
    t.f.noVote = true; t.f.revealed = 'idiot';
    return E.pub(`🤡 ${t.name} est l'Idiot du village : il est épargné, mais ne votera plus.`);
  }
  if (await fireExecuted(E, t) || s.winner) return;
  const sv = E.alive().find((x) => x.role === 'servante' && x !== t && !(s.g.lovers || []).includes(x.id));
  if (sv && powers(E, sv) && await E.yesno(sv, 'Servante dévouée', `${t.name} va mourir. Prendre son rôle en secret ?`)) {
    const r = t.role;
    E.pub(`🧹 ${sv.name} se dévoile : c'était la Servante dévouée. Elle reprend le rôle de ${t.name}.`);
    sv.f.revealed = 'servante';
    t.f.hideRole = true;
    sv.role = r; sv.seen = r; sv.f = { revealed: 'servante' }; sv.align = alignOf(sv);
    await E.tell(sv, `Tu es désormais ${rn(r)}. ${getRole(r).text}`, { title: 'Ton rôle', silent: true });
  }
  await lgDie(E, t, 'vote');
}

// ---------- composition ----------
function poolFor(E) {
  const eds = E.s.options.lgEditions || ['base'];
  return allRoles('lg').filter((r) => eds.includes(r.ed) || (r.custom && r.game === 'lg'));
}

function autoRoles(E, n) {
  const pool = poolFor(E);
  const nw = n <= 6 ? 1 : n <= 11 ? 2 : n <= 16 ? 3 : 4;
  const roles = [];
  const wolfSpecials = shuffle(pool.filter((r) => r.wolf && r.id !== 'loup_garou'));
  for (let i = 0; i < nw; i++) roles.push(i > 0 && wolfSpecials.length && chance(0.4) ? wolfSpecials.pop().id : 'loup_garou');
  if (n >= 9 && chance(0.4)) { const solo = pick(pool.filter((r) => r.team === 'solo' && !r.wolf)); if (solo) roles.push(solo.id); }
  const specials = shuffle(pool.filter((r) => r.team === 'village' && !r.multi && !['voleur', 'voyante', 'vv'].includes(r.id)));
  if (pool.some((r) => r.id === 'voyante')) roles.push('voyante');
  const villagers = Math.max(1, Math.floor((n - roles.length) / 4));
  for (const r of specials) {
    const k = r.pack || 1;
    if (roles.length + k > n - villagers) continue;
    for (let i = 0; i < k; i++) roles.push(r.id);
  }
  while (roles.length < n) roles.push('villageois');
  return roles.slice(0, n);
}

export const lgMode = {
  id: 'lg', name: 'Loups-Garous de Thiercelieux', min: 4,
  editions: [{ id: 'base', name: 'Jeu de base' }, { id: 'nl', name: 'Nouvelle Lune' }, { id: 'perso', name: 'Personnages & Village' }],

  checkRoles(E, roles) {
    const n = E.seated().length, k = roles.includes('voleur') ? n + 2 : n;
    if (roles.length !== k) return `La composition doit compter ${k} cartes${k > n ? ' (Voleur : 2 de plus)' : ''}, elle en a ${roles.length}.`;
    if (!roles.some((id) => getRole(id)?.wolf)) return 'Il faut au moins un loup.';
    return null;
  },
  alignOf: (E, p) => alignOf(p),
  startsWithDay: (E) => E.inPlay('ange'),

  deal(E) {
    const s = E.s, ps = E.seated();
    let roles = E.forcedSeats ? E.forcedSeats.slice() : shuffle(s.options.autoRoles ? autoRoles(E, ps.length) : s.roles.slice());
    if (!E.forcedSeats && roles.includes('voleur') && roles.length >= ps.length + 2) {
      roles = roles.filter((r) => r !== 'voleur');
      roles = shuffle(roles);
      s.g.center = roles.splice(ps.length - 1, 2);
      roles.push('voleur');
      roles = shuffle(roles).slice(0, ps.length);
    }
    ps.forEach((p, i) => { p.role = roles[i]; p.seen = roles[i]; p.align = alignOf(p); });
    for (const p of ps) { const r = getRole(p.role); if (r.setup) r.setup(E, p); }
    for (const p of ps) E.tell(p, `Tu es ${rn(p.role)} ${getRole(p.role).icon}. ${getRole(p.role).text}`, { title: 'Ton rôle', silent: true });
    if (s.g.sect) E.pub('🕯️ L\'Abominable Sectaire a divisé le village en deux groupes (🔺 / 🔷).');
    const vv = ps.filter((p) => p.role === 'vv');
    for (const p of vv) E.pub(`🙋 ${p.name} est le Villageois-Villageois : son innocence est prouvée.`);
  },

  async night(E) {
    const s = E.s, first = s.night === 1;
    await E.runNight(() => {
      const nd = s.nd;
      Object.assign(nd, { wolfVictim: null, saved: false, infect: false, kills: [] });
      const q = [];
      for (const p of E.seated()) {
        const r = getRole(p.role);
        if (r && r.abilities) { if (powers(E, p)) q.push(...nightEntries(E, p, r)); continue; }
        if (!p.alive || !r || !r.night || !powers(E, p)) continue;
        const o = first ? r.first : r.other;
        if (o == null) continue;
        if (first && r.first == null) continue;
        q.push({ pid: p.id, rid: p.role, o });
      }
      const wolves = E.alive().filter(isWolf);
      if (wolves.length) q.push({ o: 20, kind: 'wolves', pids: wolves.map((w) => w.id) });
      return q;
    }, async (e) => {
      if (e.kind === 'wolves') return wolvesStep(E);
      const p = E.p(e.pid);
      if (e.k != null) return p && runAbilityAt(E, p, e.rid, e.k);
      if (!p || !p.alive) return;
      await getRole(e.rid).night(E, p, { first });
    });
  },

  async dawn(E) {
    const s = E.s, nd = s.nd;
    const deaths = [];
    const v = nd.wolfVictim && E.p(nd.wolfVictim);
    if (v && v.alive) {
      if (nd.infect) { v.f.wolf = true; v.align = getRole(v.role).team === 'solo' ? 'solo' : 'evil'; await E.tell(v, '🦠 Tu as été infecté(e) : tu es désormais un Loup-Garou (en gardant ton rôle) et tu te réveilles avec la meute.', { silent: true }); }
      else if (!nd.saved && !lgImmune(E, v, 'loups')) { deaths.push([v, 'loups']); if (v.role === 'chevalier' && powers(E, v)) s.g.rust = { night: s.night + 1, from: v.id }; }
    }
    for (const k of nd.kills) {
      const t = E.p(k.id);
      if (!t || !t.alive || deaths.some(([d]) => d === t)) continue;
      if (!k.force && lgImmune(E, t, k.cause)) continue;
      deaths.push([t, k.cause]);
    }
    if (s.g.rust && s.g.rust.night === s.night) {
      const ring = E.seated(), i = ring.findIndex((x) => x.id === s.g.rust.from);
      for (let k = 1; k < ring.length; k++) {
        const q = ring[(i - k + ring.length * 2) % ring.length];
        if (q.alive && isWolf(q)) { if (!deaths.some(([d]) => d === q)) deaths.push([q, 'tetanos']); break; }
      }
      s.g.rust = null;
    }
    if (nd.peace) { const kept = deaths.filter(([d]) => nd.kills.some((k) => k.id === d.id && k.force)); deaths.splice(0, deaths.length, ...kept); }
    if (!deaths.length) E.pub('☀️ Le village se réveille. Personne n\'est mort cette nuit !', 'day');
    else E.pub(`☀️ Le village se réveille. Cette nuit, ${names(deaths.map(([d]) => d))} ${deaths.length > 1 ? 'ont péri' : 'a péri'}.`, 'day');
    for (const [d, c] of deaths) { await lgDie(E, d, c); if (s.winner) return; }
    for (const m of E.alive().filter((x) => x.role === 'montreur' && powers(E, x)))
      if (E.neighbors(m).some(isWolf)) E.pub('🐻 Grrrr ! L\'ours du Montreur grogne…'); else E.pub('🐻 L\'ours du Montreur reste calme.');
    const cb = s.g.corbeau;
    if (cb && cb.day === s.night && E.p(cb.id)?.alive) E.pub(`🐦‍⬛ Le Corbeau accuse ${E.p(cb.id).name} : 2 voix de plus contre lui aujourd'hui.`);
  },

  async day(E) {
    const s = E.s;
    if (!s.dayState) {
      s.dayState = { stage: 'talk', voting: null, started: Date.now(), ended: false };
      if (s.day === 0) E.pub('☀️ Premier jour : l\'Ange est peut-être parmi vous… Le village vote dès maintenant.', 'day');
      else E.pub(`Jour ${s.day} : débattez, puis lancez le vote.`, 'day');
    }
    const ds = s.dayState;
    if (s.options.captain && !(s.g.captain && E.p(s.g.captain)?.alive) && !s.g.captainElected && E.alive().length > 2 && s.day >= 1) {
      ds.stage = 'captain';
      const t = await lgVote(E, '👑 Élection du Capitaine', { self: true, noCaptain: true, tie: 'random', text: 'Qui doit devenir Capitaine ? (sa voix compte double)' });
      s.g.captainElected = true;
      if (t) { s.g.captain = t.id; E.pub(`👑 ${t.name} est élu(e) Capitaine.`); }
      ds.stage = 'talk';
    }
    if (s.g.noVoteDay === s.day) E.pub('🙊 Pas de vote aujourd\'hui.');
    while (ds.stage === 'talk' && !s.winner) await E.waitSignal();
    if (s.winner) return;
    if (s.g.noVoteDay === s.day) { ds.stage = 'done'; return; }
    const t = await lgVote(E, 'Vote du village', { corbeau: true });
    await eliminate(E, t);
    if (s.g.doubleVoteDay === s.day && !s.winner && !E.checkWin()) {
      E.pub('✌️ Second vote de la journée !');
      await eliminate(E, await lgVote(E, 'Second vote du village'));
    }
    if (!s.g.firstVoteDone) {
      s.g.firstVoteDone = true;
      for (const a of E.alive().filter((x) => x.role === 'ange')) { a.role = 'villageois'; a.seen = 'villageois'; a.align = 'good'; await E.tell(a, 'Tu as survécu au premier vote : tu deviens Simple Villageois.', { silent: true }); }
    }
    if (s.winner || E.checkWin()) return;
    const juge = E.alive().find((x) => x.role === 'juge' && !x.f.used && powers(E, x));
    if (juge && await E.yesno(juge, 'Juge bègue', 'Déclencher un second vote maintenant ?')) {
      juge.f.used = true;
      E.pub('⚖️ Le Juge bègue exige un second vote !');
      const t2 = await lgVote(E, 'Second vote du village');
      await eliminate(E, t2);
    }
    ds.stage = 'done';
  },

  win(E) {
    const s = E.s, A = E.alive();
    if (!A.length) return { team: 'none', text: 'Tout le monde est mort : personne ne gagne.' };
    const cw = customWin(E);
    if (cw) return cw;
    const L = s.g.lovers;
    if (L && A.length === 2 && L.every((id) => E.p(id).alive)) return { team: 'lovers', text: `Les amoureux (${names(L.map((id) => E.p(id)))}) sont les derniers survivants : l'amour triomphe !` };
    const fl = A.find((x) => x.role === 'flutiste');
    if (fl && A.every((x) => x === fl || x.f.charmed)) return { team: 'solo', text: `Le Joueur de flûte (${fl.name}) a charmé tout le village : il gagne seul !` };
    const sc = s.g.sect && E.p(s.g.sect.owner);
    if (sc && sc.alive) {
      const inA = (x) => s.g.sect.A.includes(x.id);
      if (A.every((x) => inA(x) === inA(sc))) return { team: 'solo', text: `L'Abominable Sectaire (${sc.name}) a éliminé l'autre groupe : il gagne seul !` };
    }
    const lb = A.find((x) => x.role === 'loup_blanc');
    if (lb && A.length === 1) return { team: 'solo', text: `Le Loup-Garou Blanc (${lb.name}) est le dernier survivant : il gagne seul !` };


    const wolves = A.filter(isWolf);
    const solos = A.filter((x) => getRole(x.role).team === 'solo' && !(x.role === 'ange'));
    if (!wolves.length && !solos.length) return { team: 'good', text: 'Tous les loups sont morts : le village l\'emporte !' };
    if (wolves.length === A.length && !lb) return { team: 'evil', text: 'Les loups ont dévoré tout le village : les Loups-Garous l\'emportent !' };
    return null;
  },

  forceDeath(E, t, cause) { return lgDie(E, t, cause); },

  actionsFor(E, p, ctl) {
    const s = E.s, ds = s.dayState, out = [];
    if (s.cursor.phase === 'day' && ds && ds.stage === 'talk') {
      for (const d of dayActions(E, p)) out.push({ id: 'ability', k: d.k, label: d.label });
      if (ctl) out.push({ id: 'startVote', label: s.g.noVoteDay === s.day ? 'Passer à la nuit' : 'Lancer le vote du village', ctl: true });
    }
    return out;
  },
  async action(E, p, a, ctl) {
    const ds = E.s.dayState;
    if (a.type === 'ability' && ds && ds.stage === 'talk' && !p.f.busy && dayActions(E, p).some((d) => d.k === +a.k)) {
      p.f.busy = true; try { await runAbilityAt(E, p, p.role, +a.k, { trigger: 'day' }); } finally { p.f.busy = false; }
      E.checkWin(); E.changed(); return;
    }
    if (a.type === 'startVote' && ctl && ds && ds.stage === 'talk') { ds.stage = 'vote'; E.changed(); E.signal(); }
  },
  dayView(E) {
    const ds = E.s.dayState;
    return { stage: ds.stage, voting: ds.voting ? { done: ds.voting.done.length, total: ds.voting.total, title: ds.voting.title } : null, started: ds.started };
  },
  publicTags(E, p) {
    const s = E.s, t = [];
    if (s.g.captain === p.id) t.push('👑 Capitaine');
    if (p.f.noVote) t.push('🤡 sans vote');
    if (s.g.sect) t.push(s.g.sect.A.includes(p.id) ? '🔺' : '🔷');
    return t;
  },
  privateTags(E, p) {
    const s = E.s, t = [];
    if (s.g.lovers && s.g.lovers.includes(p.id)) t.push(`💘 Amoureux de ${E.p(s.g.lovers.find((id) => id !== p.id)).name}`);
    if (p.f.charmed) t.push('🎵 Charmé');
    if (isWolf(p)) { const m = E.seated().filter((x) => isWolf(x) && x !== p); t.push(`🐺 Meute : ${names(m) || 'seul'}`); }
    if (p.f.model) t.push(`Modèle : ${E.p(p.f.model)?.name}`);
    if (p.role === 'sorciere') t.push(`Potions : ${p.f.lifeUsed ? '' : '❤️'}${p.f.deathUsed ? '' : '☠️'}` || 'aucune');
    return t;
  },
  seenAlign(E, p) { return alignOf(p); },

  // pour les rôles sur mesure
  async attack(E, by, t, cause, force) {
    if (E.s.cursor.phase === 'night') { E.s.nd.kills.push({ id: t.id, cause: 'pouvoir', force: !!force }); return true; }
    if (!force && lgImmune(E, t, 'pouvoir')) return false;
    await lgDie(E, t, 'pouvoir'); return true;
  },
  lies: () => false,
  regEvil: (E, t) => { const r = getRole(t.role); return r?.custom && r.appears ? r.appears === 'evil' : isWolf(t); },
  real: (E, p) => powers(E, p),
  impaired: () => false,
  protect(E, t) { t.f.safeN = E.s.night; },
  poison() {},
  regRole: (E, t) => t.role,
};

async function wolvesStep(E) {
  const s = E.s;
  const wolves = E.alive().filter(isWolf);
  if (!wolves.length) return;
  const cands = E.alive().filter((x) => !isWolf(x)).map((x) => x.id);
  if (!cands.length) return;
  const ask = (w, text) => E.ask(w.id, { type: 'players', n: 1, title: '🐺 Les loups choisissent leur victime', text, options: cands });
  const mates = (w) => names(wolves.filter((x) => x !== w)) || 'tu chasses seul';
  let picks = await Promise.all(wolves.map((w) => ask(w, `Ta meute : ${mates(w)}.`)));
  let ids = picks.map((x) => x[0]);
  if (wolves.length > 1 && new Set(ids).size > 1) {
    const recap = wolves.map((w, i) => `${w.name} → ${E.p(ids[i]).name}`).join(' · ');
    picks = await Promise.all(wolves.map((w) => ask(w, `Désaccord ! Votes : ${recap}. Mettez-vous d'accord (la majorité l'emporte, au hasard en cas d'égalité).`)));
    ids = picks.map((x) => x[0]);
  }
  const tally = {};
  ids.forEach((id) => (tally[id] = (tally[id] || 0) + 1));
  const max = Math.max(...Object.values(tally));
  const v = pick(Object.keys(tally).filter((id) => tally[id] === max));
  s.nd.wolfVictim = v;
  for (const w of wolves) await E.tell(w, `La meute a choisi : ${E.p(v).name}.`, { silent: true });
}
