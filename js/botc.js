// Blood on the Clocktower : Trouble Brewing, Bad Moon Rising, Sects & Violets.
// Le conteur automatique tranche au hasard là où un MJ humain choisirait ; si un MJ est présent,
// chaque information passe par lui et il peut corriger le grimoire à la main.
import { register, getRole, roleName, allRoles } from './roles/index.js';
import { shuffle, pick, chance, randInt, names } from './util.js';
import { nightEntries, runAbilityAt, dayActions, fireDeath, fireExecuted, customWin } from './rules.js';

const TEAM_FR = { townsfolk: 'Villageois', outsider: 'Étranger', minion: 'Sbire', demon: 'Démon', traveller: 'Voyageur' };
const team = (p) => getRole(p.role)?.team;
const seenTeam = (p) => getRole(p.seen || p.role)?.team;
const isDemon = (p) => team(p) === 'demon';
const isMinion = (p) => team(p) === 'minion';
const good = (p) => p.align !== 'evil';

// ---------- états ----------
function noDashiiVictims(E) {
  const d = E.alive().find((x) => x.role === 'no_dashii' && !impaired(E, x, true));
  if (!d) return [];
  const ring = E.seated().filter((x) => x.alive || x === d);
  const i = ring.indexOf(d), out = [];
  for (const dir of [1, -1]) {
    for (let k = 1; k < ring.length; k++) {
      const q = ring[(i + dir * k + ring.length * 4) % ring.length];
      if (q === d) break;
      if (team(q) === 'townsfolk') { out.push(q); break; }
    }
  }
  return out;
}

/** Ivre ou empoisonné (l'Ivrogne l'est toujours). */
export function impaired(E, p, skipDashii = false) {
  const f = p.f, c = E.s.clock;
  if (f.mjPoison || f.permPoison || f.permDrunk) return true;
  if (p.role === 'drunk' && p.seen !== 'drunk') return true;
  if ((f.poison || 0) > c || (f.drunk || 0) > c || (f.blockUntil || 0) > c) return true;
  if (!skipDashii && noDashiiVictims(E).includes(p)) return true;
  return false;
}
const sober = (E, p) => !impaired(E, p);
const vortox = (E) => E.alive().some((x) => x.role === 'vortox' && sober(E, x));

/** L'info donnée à p doit-elle être fausse ? */
function lies(E, p) {
  const bad = impaired(E, p) || (vortox(E) && seenTeam(p) === 'townsfolk');
  if (bad && !E.s.nd.abn.includes(p.id)) E.s.nd.abn.push(p.id);
  return bad;
}
/** L'action de p a-t-elle un effet réel ? (pas ivre, pas empoisonné, pas Ivrogne/Lunatique) */
const real = (E, p) => sober(E, p) && (p.seen || p.role) === p.role;

function regEvil(E, t) {
  const cr = getRole(t.role);
  if (cr?.custom && cr.appears && sober(E, t)) return cr.appears === 'evil';
  if (t.role === 'recluse' && sober(E, t)) return chance(0.5);
  if (t.role === 'spy' && sober(E, t)) return chance(0.5) ? false : true;
  return t.align === 'evil';
}
function regTeam(E, t) {
  if (t.role === 'recluse' && sober(E, t) && chance(0.5)) return pick(['minion', 'demon']);
  if (t.role === 'spy' && sober(E, t) && chance(0.5)) return pick(['townsfolk', 'outsider']);
  return team(t);
}
function regRole(E, t) {
  const tm = regTeam(E, t);
  if (tm === team(t)) return t.role;
  return pick(scriptOf(E, tm)) || t.role;
}
const regDemon = (E, t) => regTeam(E, t) === 'demon';

function scriptOf(E, tm) { return (E.s.g.script || []).filter((id) => !tm || getRole(id)?.team === tm); }
function notInPlay(E, tm) { return scriptOf(E, tm).filter((id) => !E.inPlay(id)); }
const rn = roleName;

/** Fausse valeur plausible, différente de la vraie quand c'est possible. */
function fakeNum(v, max) { const opts = []; for (let i = 0; i <= Math.max(max, 1); i++) if (i !== v) opts.push(i); return pick(opts); }

// ---------- morts ----------
function cantDie(E, t, cause) {
  if (!t.alive && !(t.role === 'zombuul' && t.f.fakeDead && !t.f.realDead)) return true;
  const n = E.s.night, atNight = E.s.cursor.phase === 'night';
  if (t.f.safe === n && cause === 'demon') return true;
  if (atNight && (t.f.shield === n || E.s.nd.peace)) return true;
  if (atNight && getRole(t.role)?.custom && getRole(t.role).nightImmune) return true;
  if (t.f.innSafe === n && E.s.cursor.phase === 'night') return true;
  if (t.role === 'sailor' && sober(E, t)) return true;
  if (t.role === 'soldier' && sober(E, t) && cause === 'demon') return true;
  const tea = E.alive().filter((x) => x.role === 'tea_lady' && sober(E, x));
  for (const tl of tea) {
    const nb = E.neighbors(tl);
    if (nb.length === 2 && nb.every((x) => x.align !== 'evil') && nb.includes(t)) return true;
  }
  if (t.role === 'fool' && sober(E, t) && !t.f.foolUsed) { t.f.foolUsed = true; E.log(`${t.name} (Fou) échappe à la mort.`); return true; }
  if (t.f.lives > 0) { t.f.lives--; E.log(`${t.name} perd une vie supplémentaire.`); return true; }
  return false;
}

/** Attaque du Démon (ou d'une capacité « tue ») ; renvoie vrai si la cible meurt. */
async function attack(E, by, t, cause = 'demon', ignoreProtect = false) {
  if (!t || !t.alive) return false;
  if (!ignoreProtect && t.role === 'mayor' && sober(E, t) && cause === 'demon' && chance(0.5)) {
    const alt = pick(E.alive().filter((x) => x !== t && !isDemon(x)));
    if (alt) { E.log(`Le Maire ${t.name} détourne l'attaque vers ${alt.name}.`); t = alt; }
  }
  if (!ignoreProtect && cantDie(E, t, cause)) { E.log(`${t.name} survit à l'attaque.`); return false; }
  await die(E, t, cause, by);
  return true;
}

export async function die(E, t, cause, by) {
  if (!t.alive && !(t.role === 'zombuul' && t.f.fakeDead && !t.f.realDead)) return;
  const s = E.s, night = s.cursor.phase === 'night';
  const aliveBefore = E.alive().length;
  if (t.role === 'zombuul' && sober(E, t) && !t.f.fakeDead) {
    t.f.fakeDead = true; t.alive = false;
  } else if (t.role === 'zombuul' && t.f.fakeDead) {
    t.f.realDead = true; t.alive = false; return void E.log(`${t.name} (Zombuul) meurt pour de bon.`);
  } else t.alive = false;
  t.dead = { cause, day: s.day, night: s.night };
  s.g.deathDay = s.day;
  if (night) s.nd.deaths.push(t.id); else E.pub(`💀 ${t.name} meurt.`, 'death');
  E.log(`${t.name} (${rn(t.role)}) meurt [${cause}].`);
  if (team(t) === 'outsider') s.g.outsiderDied = s.day;

  // Femme écarlate
  if (isDemon(t) && !t.f.fakeDead && cause !== 'starpass' && aliveBefore >= 5) {
    const sw = E.alive().find((x) => x.role === 'scarlet_woman' && sober(E, x));
    if (sw) { sw.role = t.role; sw.seen = t.role; E.log(`${sw.name} (Femme écarlate) devient ${rn(t.role)}.`); await E.tell(sw, `Le Démon est mort : tu deviens le Démon (${rn(t.role)}).`); }
  }
  // Grand-mère
  if (cause === 'demon') for (const gm of E.alive().filter((x) => x.role === 'grandmother' && x.f.grandchild === t.id && sober(E, x))) await die(E, gm, 'chagrin');
  // Ménestrel
  if (cause === 'exec' && isMinion(t)) for (const m of E.alive().filter((x) => x.role === 'minstrel' && sober(E, x))) {
    for (const q of E.seated()) if (q !== m) q.f.drunk = Math.max(q.f.drunk || 0, s.clock + 2);
    E.log('Ménestrel : tout le monde est ivre jusqu\'à demain soir.');
  }
  const r = getRole(t.f.phil || t.seen || t.role);
  if (r && r.death) await r.death(E, t, cause, night);
  await fireDeath(E, t, cause, by);
}

async function execute(E, t) {
  const s = E.s, ds = s.dayState;
  ds.executed = t.id;
  E.pub(`⚖️ ${t.name} est exécuté(e).`, 'exec');
  if (!t.alive && !(t.role === 'zombuul' && t.f.fakeDead)) { E.pub(`${t.name} était déjà mort(e).`); return; }
  if (await fireExecuted(E, t) || s.winner) return;
  if (t.f.daSafe === s.day && E.inPlay('devils_advocate')) { E.pub(`… mais ${t.name} ne meurt pas.`); return; }
  if (t.align !== 'evil' && E.alive().some((x) => x.role === 'pacifist' && sober(E, x)) && chance(0.5)) { E.pub(`… mais ${t.name} ne meurt pas.`); return; }
  if (cantDie(E, t, 'exec')) { E.pub(`… mais ${t.name} ne meurt pas.`); return; }
  if (t.role === 'saint' && sober(E, t)) { await die(E, t, 'exec'); return E.win('evil', `Le Saint (${t.name}) a été exécuté : le Mal l'emporte !`); }
  const twin = E.seated().find((x) => x.role === 'evil_twin');
  if (twin && twin.f.twin === t.id && sober(E, twin)) { await die(E, t, 'exec'); return E.win('evil', `Le jumeau Bon (${t.name}) a été exécuté : le Mal l'emporte !`); }
  if (isDemon(t) && E.alive().some((x) => x.role === 'mastermind' && sober(E, x))) s.g.mmDay = s.day + 1;
  await die(E, t, 'exec');
  if (!t.alive) s.g.execRole = { day: s.day, role: t.role, id: t.id };
}

// ---------- outils de nuit ----------
async function chooseT(E, p, o) {
  const ts = await E.choose(p, o);
  if (E.s.cursor.phase === 'night' && !E.s.nd.goon) {
    const g = ts.find((t) => t.role === 'goon' && t.alive && sober(E, t));
    if (g && p !== g) { E.s.nd.goon = true; p.f.drunk = Math.max(p.f.drunk || 0, E.s.clock + 2); g.align = p.align; E.log(`La Brute ${g.name} rend ${p.name} ivre et rejoint le camp ${p.align === 'evil' ? 'du Mal' : 'du Bien'}.`); }
  }
  return ts;
}
const one = async (E, p, o) => (await chooseT(E, p, { ...o, n: 1 }))[0] || null;
const say = (E, p, text) => E.tell(p, text);

function goodRolesNotInPlay(E) { return [...notInPlay(E, 'townsfolk'), ...notInPlay(E, 'outsider')]; }

// ---------- rôles ----------
const R = [];
const def = (ed, teamId, id, name, icon, text, x = {}) => R.push({ game: 'botc', ed, team: teamId, id, name, icon, text, ...x });

// ===== Trouble Brewing =====
def('tb', 'townsfolk', 'washerwoman', 'Lavandière', '🧺', 'Première nuit : tu apprends que l\'un de deux joueurs est un Villageois précis.', {
  first: 32, async night(E, p) {
    let ts = E.seated().filter((x) => x !== p && regTeam(E, x) === 'townsfolk');
    if (lies(E, p) || !ts.length) {
      const a = pick(E.seated().filter((x) => x !== p)), b = pick(E.seated().filter((x) => x !== p && x !== a));
      return say(E, p, `L'un de ${a.name} ou ${b?.name} est ${rn(pick(scriptOf(E, 'townsfolk')))}.`);
    }
    const t = pick(ts), o = pick(E.seated().filter((x) => x !== p && x !== t));
    const [a, b] = shuffle([t, o]);
    say(E, p, `L'un de ${a.name} ou ${b.name} est ${rn(regRole(E, t) === t.role && team(t) === 'townsfolk' ? t.role : pick(scriptOf(E, 'townsfolk')))}.`);
  },
});
def('tb', 'townsfolk', 'librarian', 'Bibliothécaire', '📚', 'Première nuit : tu apprends que l\'un de deux joueurs est un Étranger précis (ou qu\'il n\'y en a aucun).', {
  first: 33, async night(E, p) {
    const ts = E.seated().filter((x) => x !== p && regTeam(E, x) === 'outsider');
    if (lies(E, p)) {
      if (chance(0.2)) return say(E, p, 'Il n\'y a aucun Étranger en jeu.');
      const a = pick(E.seated().filter((x) => x !== p)), b = pick(E.seated().filter((x) => x !== p && x !== a));
      return say(E, p, `L'un de ${a.name} ou ${b.name} est ${rn(pick(scriptOf(E, 'outsider')) || 'drunk')}.`);
    }
    if (!ts.length) return say(E, p, 'Il n\'y a aucun Étranger en jeu.');
    const t = pick(ts), o = pick(E.seated().filter((x) => x !== p && x !== t));
    const [a, b] = shuffle([t, o]);
    say(E, p, `L'un de ${a.name} ou ${b.name} est ${rn(team(t) === 'outsider' ? t.role : pick(scriptOf(E, 'outsider')))}.`);
  },
});
def('tb', 'townsfolk', 'investigator', 'Enquêteur', '🔎', 'Première nuit : tu apprends que l\'un de deux joueurs est un Sbire précis.', {
  first: 34, async night(E, p) {
    const ts = E.seated().filter((x) => x !== p && regTeam(E, x) === 'minion');
    if (lies(E, p) || !ts.length) {
      const a = pick(E.seated().filter((x) => x !== p)), b = pick(E.seated().filter((x) => x !== p && x !== a));
      return say(E, p, `L'un de ${a.name} ou ${b.name} est ${rn(pick(scriptOf(E, 'minion')))}.`);
    }
    const t = pick(ts), o = pick(E.seated().filter((x) => x !== p && x !== t));
    const [a, b] = shuffle([t, o]);
    say(E, p, `L'un de ${a.name} ou ${b.name} est ${rn(isMinion(t) ? t.role : pick(scriptOf(E, 'minion')))}.`);
  },
});
def('tb', 'townsfolk', 'chef', 'Cuisinier', '👨‍🍳', 'Première nuit : tu apprends combien de paires de joueurs Mauvais sont assis côte à côte.', {
  first: 35, async night(E, p) {
    const ring = E.seated(); let n = 0;
    for (let i = 0; i < ring.length; i++) if (regEvil(E, ring[i]) && regEvil(E, ring[(i + 1) % ring.length])) n++;
    if (lies(E, p)) n = fakeNum(n, 3);
    say(E, p, `Il y a ${n} paire(s) de joueurs Mauvais voisins.`);
  },
});
def('tb', 'townsfolk', 'empath', 'Empathique', '💗', 'Chaque nuit : tu apprends combien de tes deux voisins vivants sont Mauvais.', {
  first: 36, other: 56, async night(E, p) {
    let n = E.neighbors(p).filter((x) => regEvil(E, x)).length;
    if (lies(E, p)) n = fakeNum(n, 2);
    say(E, p, `${n} de tes voisins vivants ${n > 1 ? 'sont Mauvais' : 'est Mauvais'}.`);
  },
});
def('tb', 'townsfolk', 'fortune_teller', 'Diseuse de bonne aventure', '🔮', 'Chaque nuit : choisis 2 joueurs, tu apprends si l\'un d\'eux est le Démon. Un joueur Bon est un faux positif.', {
  first: 37, other: 57,
  setup(E, p) { const g = pick(E.seated().filter((x) => x.align !== 'evil' && x !== p)) || p; p.f.herring = g.id; },
  async night(E, p) {
    const ts = await chooseT(E, p, { n: 2, self: true, dead: true, title: 'Diseuse : choisis 2 joueurs' });
    let yes = ts.some((t) => regDemon(E, t) || t.id === p.f.herring);
    if (lies(E, p)) yes = chance(0.5);
    say(E, p, `${names(ts)} : ${yes ? 'OUI, le Démon est parmi eux.' : 'NON.'}`);
  },
});
def('tb', 'townsfolk', 'undertaker', 'Croque-mort', '⚰️', 'Chaque nuit sauf la première : tu apprends le personnage du joueur exécuté aujourd\'hui.', {
  other: 58, async night(E, p) {
    const x = E.s.g.execRole;
    if (!x || x.day !== E.s.day) return;
    let r = x.role; const t = E.p(x.id);
    if (t && regRole(E, t) !== t.role) r = regRole(E, t);
    if (lies(E, p)) r = pick(scriptOf(E).filter((id) => id !== x.role));
    say(E, p, `Le joueur exécuté aujourd'hui était : ${rn(r)}.`);
  },
});
def('tb', 'townsfolk', 'monk', 'Moine', '🙏', 'Chaque nuit sauf la première : choisis un joueur (pas toi), il est protégé du Démon cette nuit.', {
  other: 13, async night(E, p) {
    const t = await one(E, p, { title: 'Moine : qui protèges-tu ?' });
    if (t && real(E, p)) t.f.safe = E.s.night;
  },
});
def('tb', 'townsfolk', 'ravenkeeper', 'Gardien des corbeaux', '🐦‍⬛', 'Si tu meurs la nuit, tu choisis un joueur et tu apprends son personnage.', {
  async death(E, p, cause, night) {
    if (!night) return;
    const t = await E.choose1(p, { title: 'Gardien des corbeaux : choisis un joueur', dead: true, self: true });
    if (!t) return;
    let r = regRole(E, t);
    if (lies(E, p)) r = pick(scriptOf(E).filter((x) => x !== t.role));
    say(E, p, `${t.name} est ${rn(r)}.`);
  },
});
def('tb', 'townsfolk', 'virgin', 'Vierge', '🕊️', 'La première fois que tu es nommée, si le nominateur est un Villageois, il est exécuté immédiatement.');
def('tb', 'townsfolk', 'slayer', 'Pourfendeur', '🏹', 'Une fois par partie, de jour, choisis publiquement un joueur : si c\'est le Démon, il meurt.', {
  day: {
    label: 'Tirer (Pourfendeur)', can: (E, p) => p.alive && !p.f.used,
    async run(E, p) {
      const t = await E.choose1(p, { title: 'Pourfendeur : sur qui tires-tu ?' });
      if (!t) return;
      p.f.used = true;
      E.pub(`🏹 ${p.name} tire sur ${t.name} en se déclarant Pourfendeur…`);
      if (real(E, p) && regDemon(E, t) && isDemon(t)) await die(E, t, 'slayer'); else E.pub('… rien ne se passe.');
      E.checkWin();
    },
  },
});
def('tb', 'townsfolk', 'soldier', 'Soldat', '🛡️', 'Tu es à l\'abri du Démon.');
def('tb', 'townsfolk', 'mayor', 'Maire', '🎩', 'S\'il reste 3 joueurs et qu\'il n\'y a pas d\'exécution, ton camp gagne. Si tu meurs la nuit, un autre joueur peut mourir à ta place.');
def('tb', 'outsider', 'butler', 'Majordome', '🤵', 'Chaque nuit, choisis ton maître : demain, tu ne peux voter que si ton maître vote aussi.', {
  first: 38, other: 59, async night(E, p) {
    const t = await one(E, p, { title: 'Majordome : choisis ton maître' });
    if (t) { p.f.master = t.id; say(E, p, `Ton maître est ${t.name}.`); }
  },
});
def('tb', 'outsider', 'drunk', 'Ivrogne', '🍺', 'Tu ne sais pas que tu es l\'Ivrogne : tu crois être un Villageois, mais ta capacité ne marche pas.');
def('tb', 'outsider', 'recluse', 'Reclus', '🏚️', 'Tu peux être détecté comme Mauvais, Sbire ou Démon, même mort.');
def('tb', 'outsider', 'saint', 'Saint', '😇', 'Si tu meurs exécuté, ton camp perd.');
def('tb', 'minion', 'poisoner', 'Empoisonneur', '🧪', 'Chaque nuit : choisis un joueur, il est empoisonné cette nuit et demain.', {
  first: 17, other: 8, async night(E, p) {
    const t = await one(E, p, { title: 'Empoisonneur : qui empoisonnes-tu ?', self: true });
    if (t && real(E, p)) t.f.poison = E.s.clock + 2;
  },
});
def('tb', 'minion', 'spy', 'Espion', '🕵️', 'Chaque nuit, tu vois le grimoire. Tu peux être détecté comme Bon, Villageois ou Étranger.', {
  first: 49, other: 68, async night(E, p) {
    if (!sober(E, p)) return say(E, p, 'Grimoire : ' + E.seated().map((x) => `${x.name}=${rn(pick(scriptOf(E)))}`).join(' · '));
    say(E, p, 'Grimoire : ' + E.seated().map((x) => `${x.name}=${rn(x.role)}${impaired(E, x) ? ' (ivre/emp.)' : ''}${x.alive ? '' : ' †'}`).join(' · '));
  },
});
def('tb', 'minion', 'scarlet_woman', 'Femme écarlate', '💃', 'S\'il reste 5 joueurs ou plus et que le Démon meurt, tu deviens le Démon.');
def('tb', 'minion', 'baron', 'Baron', '🎖️', 'Il y a 2 Étrangers de plus en jeu. [+2 Étrangers]');
def('tb', 'demon', 'imp', 'Diablotin', '😈', 'Chaque nuit sauf la première : choisis un joueur, il meurt. Si tu te choisis, un Sbire devient le Diablotin.', {
  other: 24, async night(E, p) {
    const t = await demonPick(E, p, { self: true, title: 'Diablotin : qui tues-tu ?' });
    if (!t || !real(E, p)) return;
    if (t === p) {
      const m = pick(E.alive().filter(isMinion));
      await die(E, p, 'starpass');
      if (m) { m.role = 'imp'; m.seen = 'imp'; await E.tell(m, 'Le Diablotin s\'est sacrifié : tu deviens le Diablotin.'); }
      return;
    }
    await attack(E, p, t);
  },
});

// Choix du Démon, avec l'Exorciste et le Lunatique.
async function demonPick(E, p, o) {
  if (E.s.nd.exorcised === p.id) return null;
  const t = await one(E, p, o);
  if (p.role === 'lunatic') {
    const d = E.alive().find(isDemon);
    if (d && t) await E.tell(d, `Le Lunatique (${p.name}) a choisi ${t.name} cette nuit.`, { silent: true });
    return null;
  }
  return t;
}

// ===== Bad Moon Rising =====
def('bmr', 'townsfolk', 'grandmother', 'Grand-mère', '👵', 'Première nuit : tu apprends un joueur Bon et son personnage. Si le Démon le tue, tu meurs aussi.', {
  first: 31, async night(E, p) {
    const t = pick(E.seated().filter((x) => x !== p && x.align !== 'evil'));
    if (!t) return;
    p.f.grandchild = t.id;
    say(E, p, `Ton petit-enfant est ${t.name}, qui est ${rn(lies(E, p) ? pick(scriptOf(E, 'townsfolk')) : t.role)}.`);
  },
});
def('bmr', 'townsfolk', 'sailor', 'Marin', '⚓', 'Chaque nuit : choisis un joueur vivant, l\'un de vous deux est ivre jusqu\'au crépuscule. Tu ne peux pas mourir.', {
  first: 11, other: 4, async night(E, p) {
    const t = await one(E, p, { title: 'Marin : avec qui bois-tu ?' });
    if (!t || !real(E, p)) return;
    const d = t.align === 'evil' || chance(0.5) ? t : p;
    d.f.drunk = Math.max(d.f.drunk || 0, E.s.clock + 2);
  },
});
def('bmr', 'townsfolk', 'chambermaid', 'Femme de chambre', '🛏️', 'Chaque nuit : choisis 2 joueurs vivants (pas toi), tu apprends combien se sont réveillés cette nuit pour leur capacité.', {
  first: 51, other: 70, async night(E, p) {
    const ts = await chooseT(E, p, { n: 2, title: 'Femme de chambre : choisis 2 joueurs' });
    let n = ts.filter((t) => E.s.nd.woke.includes(t.id)).length;
    if (lies(E, p)) n = fakeNum(n, 2);
    say(E, p, `${n} de ${names(ts)} se sont réveillés cette nuit.`);
  },
});
def('bmr', 'townsfolk', 'exorcist', 'Exorciste', '✝️', 'Chaque nuit sauf la première : choisis un joueur (différent de la veille). Si c\'est le Démon, il apprend qui tu es et ne se réveille pas.', {
  other: 21, async night(E, p) {
    const t = await one(E, p, { title: 'Exorciste : choisis un joueur', filter: (x) => x.id !== p.f.last });
    if (!t) return;
    p.f.last = t.id;
    if (real(E, p) && isDemon(t)) { E.s.nd.exorcised = t.id; await E.tell(t, `L'Exorciste (${p.name}) t'a choisi : tu ne te réveilles pas cette nuit.`); }
  },
});
def('bmr', 'townsfolk', 'innkeeper', 'Aubergiste', '🍻', 'Chaque nuit sauf la première : choisis 2 joueurs, ils ne peuvent pas mourir cette nuit, mais l\'un d\'eux est ivre jusqu\'au crépuscule.', {
  other: 9, async night(E, p) {
    const ts = await chooseT(E, p, { n: 2, self: true, title: 'Aubergiste : qui héberges-tu ?' });
    if (!real(E, p)) return;
    ts.forEach((t) => (t.f.innSafe = E.s.night));
    const d = pick(ts); if (d) d.f.drunk = Math.max(d.f.drunk || 0, E.s.clock + 2);
  },
});
def('bmr', 'townsfolk', 'gambler', 'Parieur', '🎲', 'Chaque nuit sauf la première : choisis un joueur et devine son personnage. Si tu te trompes, tu meurs.', {
  other: 10, async night(E, p) {
    const t = await one(E, p, { title: 'Parieur : sur qui paries-tu ?' });
    if (!t) return;
    const g = await E.chooseRole(p, `Quel est le personnage de ${t.name} ?`, scriptOf(E));
    if (real(E, p) && g !== t.role) await attack(E, p, p, 'gambler', true);
  },
});
def('bmr', 'townsfolk', 'gossip', 'Commère', '🗣️', 'Chaque jour, tu peux faire une déclaration publique. Cette nuit-là, si elle est vraie, un joueur meurt.', {
  other: 26,
  day: {
    label: 'Déclaration (Commère)', can: (E, p) => p.alive && p.f.gossipDay !== E.s.day,
    async run(E, p) {
      const t = await E.choose1(p, { title: 'Commère : ta déclaration porte sur…', self: true, dead: true });
      if (!t) return;
      const k = await E.choice(p, `Que déclares-tu sur ${t.name} ?`, [{ v: 'demon', l: 'C\'est le Démon' }, { v: 'minion', l: 'C\'est un Sbire' }, { v: 'outsider', l: 'C\'est un Étranger' }, { v: 'evil', l: 'Il est Mauvais' }, { v: 'good', l: 'Il est Bon' }]);
      p.f.gossipDay = E.s.day;
      const lbl = { demon: 'est le Démon', minion: 'est un Sbire', outsider: 'est un Étranger', evil: 'est Mauvais', good: 'est Bon' }[k];
      E.pub(`🗣️ ${p.name} déclare : « ${t.name} ${lbl}. »`);
      const truth = k === 'evil' ? t.align === 'evil' : k === 'good' ? t.align !== 'evil' : team(t) === k;
      if (truth && real(E, p)) E.s.g.gossip = E.s.day;
    },
  },
  async night(E, p) {
    if (E.s.g.gossip === E.s.day && E.s.day > 0) { const v = pick(E.alive()); if (v) await die(E, v, 'gossip'); }
  },
});
def('bmr', 'townsfolk', 'courtier', 'Courtisan', '🥂', 'Une fois par partie, la nuit : choisis un personnage, il est ivre pendant 3 nuits et 3 jours.', {
  first: 12, other: 5, async night(E, p) {
    if (p.f.used) return;
    if (!(await E.yesno(p, 'Courtisan', 'Utiliser ta capacité cette nuit ?'))) return;
    const r = await E.chooseRole(p, 'Quel personnage enivres-tu ?', scriptOf(E));
    p.f.used = true;
    if (real(E, p)) for (const t of E.withRole(r)) t.f.drunk = Math.max(t.f.drunk || 0, E.s.clock + 6);
  },
});
def('bmr', 'townsfolk', 'professor', 'Professeur', '🎓', 'Une fois par partie, la nuit sauf la première : choisis un joueur mort. Si c\'est un Villageois, il ressuscite.', {
  other: 40, async night(E, p) {
    if (p.f.used || !E.dead().length) return;
    if (!(await E.yesno(p, 'Professeur', 'Tenter une résurrection cette nuit ?'))) return;
    const t = await E.choose1(p, { deadOnly: true, title: 'Professeur : qui ressuscites-tu ?' });
    p.f.used = true;
    if (t && real(E, p) && team(t) === 'townsfolk') { t.alive = true; t.ghost = true; t.dead = null; E.s.nd.revived = (E.s.nd.revived || []).concat(t.id); }
  },
});
def('bmr', 'townsfolk', 'minstrel', 'Ménestrel', '🎻', 'Quand un Sbire meurt exécuté, tous les autres joueurs sont ivres jusqu\'au crépuscule suivant.');
def('bmr', 'townsfolk', 'tea_lady', 'Dame de compagnie', '🫖', 'Si tes deux voisins vivants sont Bons, ils ne peuvent pas mourir.');
def('bmr', 'townsfolk', 'pacifist', 'Pacifiste', '☮️', 'Les joueurs Bons exécutés peuvent ne pas mourir.');
def('bmr', 'townsfolk', 'fool', 'Fou', '🃏', 'La première fois que tu devrais mourir, tu ne meurs pas.');
def('bmr', 'outsider', 'tinker', 'Bricoleur', '🔧', 'Tu peux mourir à tout moment.', {
  other: 30, async night(E, p) { if (!E.s.stId && chance(0.1)) await die(E, p, 'tinker'); },
});
def('bmr', 'outsider', 'moonchild', 'Enfant de la lune', '🌙', 'Quand tu apprends ta mort, choisis publiquement un joueur vivant : s\'il est Bon, il meurt cette nuit.', {
  async death(E, p) {
    const t = await E.choose1(p, { title: 'Enfant de la lune : désigne un joueur' });
    if (!t) return;
    E.pub(`🌙 ${p.name} désigne ${t.name}.`);
    if (t.align !== 'evil' && real(E, p)) E.s.g.moon = t.id;
  },
  other: 27, async night(E) { const t = E.s.g.moon && E.p(E.s.g.moon); E.s.g.moon = null; if (t && t.alive) await attack(E, null, t, 'moonchild'); },
  nightDead: true,
});
def('bmr', 'outsider', 'goon', 'Brute', '🦍', 'Chaque nuit, le premier joueur qui te choisit est ivre jusqu\'au crépuscule. Tu rejoins son camp.');
def('bmr', 'outsider', 'lunatic', 'Lunatique', '🤪', 'Tu crois être le Démon, mais tu ne l\'es pas. Le Démon sait qui tu es et ce que tu choisis.');
def('bmr', 'minion', 'godfather', 'Parrain', '🤌', 'Première nuit : tu apprends quels Étrangers sont en jeu. Si un Étranger est mort aujourd\'hui, choisis un joueur cette nuit : il meurt. [±1 Étranger]', {
  first: 21, other: 33, async night(E, p, ctx) {
    if (ctx.first) {
      const os = E.seated().filter((x) => team(x) === 'outsider').map((x) => rn(x.role));
      return say(E, p, os.length ? `Étrangers en jeu : ${os.join(', ')}.` : 'Aucun Étranger en jeu.');
    }
    if (E.s.g.outsiderDied !== E.s.day) return;
    const t = await one(E, p, { title: 'Parrain : un Étranger est mort aujourd\'hui. Qui tues-tu ?' });
    if (t && real(E, p)) await attack(E, p, t, 'godfather');
  },
});
def('bmr', 'minion', 'devils_advocate', 'Avocat du diable', '👨‍⚖️', 'Chaque nuit : choisis un joueur vivant (différent de la veille). S\'il est exécuté demain, il ne meurt pas.', {
  first: 18, other: 14, async night(E, p) {
    const t = await one(E, p, { self: true, title: 'Avocat du diable : qui défends-tu ?', filter: (x) => x.id !== p.f.last });
    if (!t) return; p.f.last = t.id;
    if (real(E, p)) t.f.daSafe = E.s.night;
  },
});
def('bmr', 'minion', 'assassin', 'Assassin', '🗡️', 'Une fois par partie, la nuit sauf la première : choisis un joueur, il meurt même s\'il est protégé.', {
  other: 34, async night(E, p) {
    if (p.f.used) return;
    if (!(await E.yesno(p, 'Assassin', 'Assassiner quelqu\'un cette nuit ?'))) return;
    const t = await one(E, p, { title: 'Assassin : ta cible ?' });
    p.f.used = true;
    if (t && real(E, p)) await die(E, t, 'assassin', p);
  },
});
def('bmr', 'minion', 'mastermind', 'Cerveau', '🧠', 'Si le Démon meurt exécuté, la partie continue un jour de plus. Si un joueur Bon est exécuté ce jour-là, le Mal gagne.');
def('bmr', 'demon', 'zombuul', 'Zombuul', '🧟', 'Chaque nuit sauf la première, si personne n\'est mort aujourd\'hui : choisis un joueur, il meurt. La première fois que tu meurs, tu fais semblant d\'être mort.', {
  other: 25, nightDead: true, async night(E, p) {
    if (p.f.realDead) return;
    if (E.s.g.deathDay === E.s.day && E.s.day > 0) return;
    const t = await demonPick(E, p, { title: 'Zombuul : qui tues-tu ?' });
    if (t && real(E, p)) await attack(E, p, t);
  },
});
def('bmr', 'demon', 'pukka', 'Pukka', '🐍', 'Chaque nuit : choisis un joueur, il est empoisonné. Le joueur empoisonné la veille meurt puis guérit.', {
  first: 28, other: 26, async night(E, p) {
    const prev = p.f.prey && E.p(p.f.prey);
    const t = await demonPick(E, p, { title: 'Pukka : qui empoisonnes-tu ?' });
    if (prev && real(E, p)) { prev.f.permPoison = false; await attack(E, p, prev); }
    if (t && real(E, p)) { t.f.permPoison = true; p.f.prey = t.id; }
  },
});
def('bmr', 'demon', 'shabaloth', 'Shabaloth', '👹', 'Chaque nuit sauf la première : choisis 2 joueurs, ils meurent. Un joueur mort la veille peut être régurgité.', {
  other: 27, async night(E, p) {
    if (E.s.nd.exorcised === p.id) return;
    const ts = await chooseT(E, p, { n: 2, self: true, title: 'Shabaloth : qui dévores-tu ?' });
    if (!real(E, p)) return;
    const prev = (p.f.eaten || []).map((id) => E.p(id)).filter((x) => x && !x.alive);
    if (prev.length && chance(0.25)) { const r = pick(prev); r.alive = true; r.dead = null; E.s.nd.revived = (E.s.nd.revived || []).concat(r.id); }
    p.f.eaten = [];
    for (const t of ts) if (await attack(E, p, t)) p.f.eaten.push(t.id);
  },
});
def('bmr', 'demon', 'po', 'Po', '🔥', 'Chaque nuit sauf la première : tu peux choisir un joueur, il meurt. Si tu n\'as choisi personne la veille, choisis-en 3.', {
  other: 28, async night(E, p) {
    if (E.s.nd.exorcised === p.id) return;
    const n = p.f.charged ? 3 : 1;
    const ts = await chooseT(E, p, { n, min: 0, self: true, title: n === 3 ? 'Po : choisis 3 victimes' : 'Po : une victime (ou personne pour charger)' });
    if (!real(E, p)) return;
    p.f.charged = !ts.length && !p.f.charged;
    for (const t of ts) await attack(E, p, t);
  },
});

// ===== Sects & Violets =====
def('snv', 'townsfolk', 'clockmaker', 'Horloger', '🕰️', 'Première nuit : tu apprends à combien de sièges le Démon est de son Sbire le plus proche.', {
  first: 39, async night(E, p) {
    const d = E.seated().find(isDemon), ms = E.seated().filter(isMinion);
    let n = d && ms.length ? Math.min(...ms.map((m) => E.seatDistance(d, m))) : 0;
    if (lies(E, p)) n = fakeNum(n, Math.floor(E.seated().length / 2)) || 1;
    say(E, p, `Le Démon est à ${n} siège(s) de son Sbire le plus proche.`);
  },
});
def('snv', 'townsfolk', 'dreamer', 'Rêveur', '💤', 'Chaque nuit : choisis un joueur (pas toi), tu apprends 1 personnage Bon et 1 Mauvais, dont l\'un est le sien.', {
  first: 40, other: 61, async night(E, p) {
    const t = await one(E, p, { title: 'Rêveur : de qui rêves-tu ?' });
    if (!t) return;
    const goodR = [...scriptOf(E, 'townsfolk'), ...scriptOf(E, 'outsider')], evilR = [...scriptOf(E, 'minion'), ...scriptOf(E, 'demon')];
    let r = regRole(E, t); const isG = goodR.includes(r);
    let pair = isG ? [r, pick(evilR)] : [pick(goodR.filter((x) => x !== r)), r];
    if (lies(E, p)) pair = [pick(goodR.filter((x) => x !== t.role)), pick(evilR.filter((x) => x !== t.role))];
    say(E, p, `${t.name} est ${rn(pair[0])} ou ${rn(pair[1])}.`);
  },
});
def('snv', 'townsfolk', 'snake_charmer', 'Charmeur de serpents', '🐍', 'Chaque nuit : choisis un joueur vivant. Si c\'est le Démon, vous échangez personnages et camps, et il est empoisonné.', {
  first: 15, other: 11, async night(E, p) {
    const t = await one(E, p, { title: 'Charmeur : choisis un joueur' });
    if (!t || !real(E, p) || !isDemon(t)) return;
    const dr = t.role;
    t.role = 'snake_charmer'; t.seen = 'snake_charmer'; t.align = 'good'; t.f.permPoison = true;
    p.role = dr; p.seen = dr; p.align = 'evil';
    await E.tell(p, `Tu as charmé le Démon ! Tu es maintenant ${rn(dr)} (Mauvais).`);
    await E.tell(t, 'Le Charmeur de serpents t\'a charmé : tu es maintenant le Charmeur de serpents (Bon), et empoisonné.');
  },
});
def('snv', 'townsfolk', 'mathematician', 'Mathématicien', '➗', 'Chaque nuit : tu apprends combien de capacités ont mal fonctionné depuis l\'aube à cause d\'une autre capacité.', {
  first: 52, other: 71, async night(E, p) {
    let n = E.s.nd.abn.filter((id) => id !== p.id).length + (E.s.g.dayAbn || 0);
    if (lies(E, p)) n = fakeNum(n, 3);
    say(E, p, `${n} capacité(s) ont mal fonctionné.`);
  },
});
def('snv', 'townsfolk', 'flowergirl', 'Fleuriste', '💐', 'Chaque nuit sauf la première : tu apprends si un Démon a voté aujourd\'hui.', {
  other: 62, async night(E, p) {
    let y = E.s.g.demonVoted === E.s.day;
    if (lies(E, p)) y = !y;
    say(E, p, y ? 'Un Démon a voté aujourd\'hui.' : 'Aucun Démon n\'a voté aujourd\'hui.');
  },
});
def('snv', 'townsfolk', 'town_crier', 'Crieur public', '📣', 'Chaque nuit sauf la première : tu apprends si un Sbire a nommé quelqu\'un aujourd\'hui.', {
  other: 63, async night(E, p) {
    let y = E.s.g.minionNom === E.s.day;
    if (lies(E, p)) y = !y;
    say(E, p, y ? 'Un Sbire a nommé aujourd\'hui.' : 'Aucun Sbire n\'a nommé aujourd\'hui.');
  },
});
def('snv', 'townsfolk', 'oracle', 'Oracle', '👁️', 'Chaque nuit sauf la première : tu apprends combien de joueurs morts sont Mauvais.', {
  other: 64, async night(E, p) {
    let n = E.dead().filter((x) => regEvil(E, x)).length;
    if (lies(E, p)) n = fakeNum(n, Math.max(2, E.dead().length));
    say(E, p, `${n} joueur(s) mort(s) ${n > 1 ? 'sont Mauvais' : 'est Mauvais'}.`);
  },
});
def('snv', 'townsfolk', 'savant', 'Savant', '🧪', 'Chaque jour, tu peux consulter le conteur : tu apprends 2 choses, l\'une vraie et l\'autre fausse.', {
  day: {
    label: 'Consulter (Savant)', can: (E, p) => p.alive && p.f.savDay !== E.s.day,
    async run(E, p) {
      p.f.savDay = E.s.day;
      const facts = () => {
        const x = pick(E.seated().filter((q) => q !== p));
        const outs = E.seated().filter((q) => team(q) === 'outsider').length;
        const evilAlive = E.alive().filter((q) => q.align === 'evil').length;
        return pick([
          (t) => `${x.name} est ${t === (x.align === 'evil') ? 'Mauvais' : 'Bon'}.`,
          (t) => `Il y a ${t ? outs : fakeNum(outs, 3)} Étranger(s) en jeu.`,
          (t) => `${x.name} est ${t === isMinion(x) ? '' : 'pas '}un Sbire.`.replace('est pas', 'n\'est pas'),
          (t) => `Il y a ${t ? evilAlive : fakeNum(evilAlive, 4)} joueur(s) Mauvais vivant(s).`,
        ]);
      };
      const f1 = facts(), f2 = facts();
      let a = f1(true), b = f2(false);
      if (lies(E, p)) a = f1(false);
      const [x, y] = shuffle([a, b]);
      say(E, p, `L'une de ces affirmations est vraie : « ${x} » / « ${y} »`);
    },
  },
});
def('snv', 'townsfolk', 'seamstress', 'Couturière', '🧵', 'Une fois par partie, la nuit : choisis 2 joueurs (pas toi), tu apprends s\'ils sont du même camp.', {
  first: 41, other: 65, async night(E, p) {
    if (p.f.used || !(await E.yesno(p, 'Couturière', 'Utiliser ta capacité cette nuit ?'))) return;
    const ts = await chooseT(E, p, { n: 2, dead: true, title: 'Couturière : choisis 2 joueurs' });
    p.f.used = true;
    let same = ts.length === 2 && regEvil(E, ts[0]) === regEvil(E, ts[1]);
    if (lies(E, p)) same = !same;
    say(E, p, `${names(ts)} : ${same ? 'même camp' : 'camps différents'}.`);
  },
});
def('snv', 'townsfolk', 'philosopher', 'Philosophe', '🤔', 'Une fois par partie, la nuit : choisis un personnage Bon, tu gagnes sa capacité. S\'il est en jeu, ce joueur devient ivre.', {
  first: 1, other: 1, async night(E, p) {
    if (p.f.phil || !(await E.yesno(p, 'Philosophe', 'Choisir une capacité maintenant ?'))) return;
    const opts = [...scriptOf(E, 'townsfolk'), ...scriptOf(E, 'outsider')].filter((x) => x !== 'philosopher');
    const r = await E.chooseRole(p, 'Philosophe : quelle capacité prends-tu ?', opts);
    p.f.phil = r;
    if (real(E, p)) for (const t of E.withRole(r)) t.f.permDrunk = true;
    const rr = getRole(r), first = E.s.night === 1;
    const o = first ? rr.first : rr.other;
    if (o != null && rr.night) E.queueLater({ pid: p.id, rid: r, o });
    say(E, p, `Tu as maintenant la capacité : ${rn(r)}.`);
  },
});
def('snv', 'townsfolk', 'artist', 'Artiste', '🎨', 'Une fois par partie, de jour : pose une question fermée au conteur.', {
  day: {
    label: 'Question (Artiste)', can: (E, p) => p.alive && !p.f.used,
    async run(E, p) {
      const t = await E.choose1(p, { title: 'Artiste : ta question porte sur…', self: true, dead: true });
      if (!t) return;
      const k = await E.choice(p, `Question sur ${t.name}`, [{ v: 'demon', l: 'Est-ce le Démon ?' }, { v: 'minion', l: 'Est-ce un Sbire ?' }, { v: 'outsider', l: 'Est-ce un Étranger ?' }, { v: 'evil', l: 'Est-il Mauvais ?' }, { v: 'bad', l: 'Est-il ivre ou empoisonné ?' }]);
      p.f.used = true;
      let y = k === 'evil' ? t.align === 'evil' : k === 'bad' ? impaired(E, t) : team(t) === k;
      if (lies(E, p)) y = chance(0.5);
      say(E, p, `Réponse sur ${t.name} : ${y ? 'OUI' : 'NON'}.`);
    },
  },
});
def('snv', 'townsfolk', 'juggler', 'Jongleur', '🤹', 'Le premier jour, devine les personnages de jusqu\'à 5 joueurs. Cette nuit-là, tu apprends combien sont justes.', {
  other: 66,
  day: {
    label: 'Jongler (Jongleur)', can: (E, p) => p.alive && !p.f.juggle && E.s.day <= 1,
    async run(E, p) {
      const ts = await E.choose(p, { n: 5, min: 1, self: true, dead: true, title: 'Jongleur : choisis jusqu\'à 5 joueurs' });
      const guesses = [];
      for (const t of ts) guesses.push({ id: t.id, r: await E.chooseRole(p, `Personnage de ${t.name} ?`, scriptOf(E)) });
      p.f.juggle = { day: E.s.day, guesses };
      E.pub(`🤹 ${p.name} jongle : ` + guesses.map((g) => `${E.p(g.id).name} = ${rn(g.r)}`).join(', '));
    },
  },
  async night(E, p) {
    const j = p.f.juggle;
    if (!j || j.day !== E.s.day) return;
    let n = j.guesses.filter((g) => regRole(E, E.p(g.id)) === g.r).length;
    if (lies(E, p)) n = fakeNum(n, j.guesses.length);
    say(E, p, `${n} de tes devinettes sont justes.`);
  },
});
def('snv', 'townsfolk', 'sage', 'Sage', '📜', 'Si le Démon te tue, tu apprends que c\'est l\'un de 2 joueurs.', {
  async death(E, p, cause) {
    if (cause !== 'demon') return;
    const d = E.seated().find(isDemon), o = pick(E.seated().filter((x) => x !== p && x !== d));
    let pair = shuffle([d, o].filter(Boolean));
    if (lies(E, p)) pair = shuffle(E.seated().filter((x) => x !== p && x !== d)).slice(0, 2);
    say(E, p, `Le Démon est ${names(pair).replace(', ', ' ou ')}.`);
  },
});
def('snv', 'outsider', 'mutant', 'Mutant', '🧬', 'Si tu prétends « avec folie » être un Étranger, tu peux être exécuté. (Non vérifié par l\'appli.)');
def('snv', 'outsider', 'sweetheart', 'Bien-aimé', '💘', 'Quand tu meurs, un joueur devient ivre pour le reste de la partie.', {
  async death(E, p) { if (!sober(E, p)) return; const t = pick(E.seated().filter((x) => x !== p)); if (t) t.f.permDrunk = true; },
});
def('snv', 'outsider', 'barber', 'Barbier', '💈', 'Si tu meurs, cette nuit le Démon peut échanger les personnages de 2 joueurs (pas le Démon).', {
  async death(E, p) { if (sober(E, p)) E.s.g.barber = true; },
});
def('snv', 'outsider', 'klutz', 'Maladroit', '🤕', 'Quand tu apprends ta mort, choisis publiquement un joueur vivant : s\'il est Mauvais, ton camp perd.', {
  async death(E, p) {
    const t = await E.choose1(p, { title: 'Maladroit : choisis un joueur vivant' });
    if (!t) return;
    E.pub(`🤕 ${p.name} désigne ${t.name}.`);
    if (t.align === 'evil' && sober(E, p)) E.win('evil', `Le Maladroit (${p.name}) a désigné un joueur Mauvais : le Mal l'emporte !`);
  },
});
def('snv', 'minion', 'evil_twin', 'Jumeau maléfique', '👯', 'Toi et un joueur Bon vous connaissez. Si le Bon est exécuté, le Mal gagne. Le Bien ne peut pas gagner tant que vous vivez tous deux.', {
  first: 23,
  setup(E, p) { const t = pick(E.seated().filter((x) => x.align !== 'evil')); if (t) p.f.twin = t.id; },
  async night(E, p) {
    const t = E.p(p.f.twin); if (!t) return;
    await say(E, p, `Ton jumeau est ${t.name}, qui est ${rn(t.role)}.`);
    await say(E, t, `Tu as un jumeau maléfique : ${p.name}, qui est le Jumeau maléfique.`);
  },
});
def('snv', 'minion', 'witch', 'Sorcière', '🧙‍♀️', 'Chaque nuit : maudis un joueur. S\'il nomme demain, il meurt. (Perdu à 3 joueurs vivants.)', {
  first: 19, other: 15, async night(E, p) {
    if (E.alive().length <= 3) return;
    const t = await one(E, p, { self: true, title: 'Sorcière : qui maudis-tu ?' });
    if (t && real(E, p)) t.f.cursed = E.s.night;
  },
});
def('snv', 'minion', 'cerenovus', 'Cérénovus', '🌀', 'Chaque nuit : choisis un joueur et un personnage Bon. Il doit prétendre « avec folie » être ce personnage demain.', {
  first: 20, other: 16, async night(E, p) {
    const t = await one(E, p, { self: true, title: 'Cérénovus : qui rends-tu fou ?' });
    if (!t) return;
    const r = await E.chooseRole(p, 'Quel personnage doit-il prétendre être ?', goodRolesNotInPlay(E).concat(scriptOf(E, 'townsfolk')).filter((v, i, a) => a.indexOf(v) === i));
    if (real(E, p)) await E.tell(t, `Le Cérénovus t'a rendu fou : demain, tu dois prétendre être ${rn(r)}, sinon tu risques l'exécution.`);
  },
});
def('snv', 'minion', 'pit_hag', 'Mégère', '🧹', 'Chaque nuit sauf la première : choisis un joueur et un personnage absent du jeu, il le devient.', {
  other: 17, async night(E, p) {
    const t = await one(E, p, { self: true, title: 'Mégère : qui transformes-tu ?' });
    if (!t) return;
    const opts = notInPlay(E).filter((r) => r !== 'drunk');
    if (!opts.length) return;
    const r = await E.chooseRole(p, `En quoi transformes-tu ${t.name} ?`, opts);
    if (!real(E, p)) return;
    t.role = r; t.seen = r; t.f = {};
    const tm = getRole(r).team;
    if (tm === 'demon' || tm === 'minion') t.align = 'evil'; else if (t.align === 'evil' && !isDemon(t)) t.align = 'evil';
    await E.tell(t, `La Mégère t'a transformé : tu es désormais ${rn(r)}.`);
  },
});
def('snv', 'demon', 'fang_gu', 'Fang Gu', '🐉', 'Chaque nuit sauf la première : choisis un joueur, il meurt. La première fois qu\'un Étranger est choisi, il devient un Fang Gu Mauvais et tu meurs à sa place. [+1 Étranger]', {
  other: 29, async night(E, p) {
    const t = await demonPick(E, p, { title: 'Fang Gu : qui tues-tu ?' });
    if (!t || !real(E, p)) return;
    if (team(t) === 'outsider' && !E.s.g.fgJump && t.alive) {
      E.s.g.fgJump = true;
      t.role = 'fang_gu'; t.seen = 'fang_gu'; t.align = 'evil';
      await die(E, p, 'starpass');
      return E.tell(t, 'Le Fang Gu a sauté dans ton corps : tu es le Fang Gu (Mauvais).');
    }
    await attack(E, p, t);
  },
});
def('snv', 'demon', 'vigormortis', 'Vigormortis', '💀', 'Chaque nuit sauf la première : choisis un joueur, il meurt. Les Sbires que tu tues gardent leur capacité et empoisonnent un Villageois voisin. [−1 Étranger]', {
  other: 30, async night(E, p) {
    const t = await demonPick(E, p, { title: 'Vigormortis : qui tues-tu ?' });
    if (!t || !real(E, p)) return;
    if (await attack(E, p, t) && isMinion(t)) {
      t.f.vigor = true;
      const nb = E.neighbors(t, false).filter((x) => team(x) === 'townsfolk');
      const v = pick(nb); if (v) v.f.permPoison = true;
    }
  },
});
def('snv', 'demon', 'no_dashii', 'No Dashii', '🦑', 'Chaque nuit sauf la première : choisis un joueur, il meurt. Tes 2 voisins Villageois les plus proches sont empoisonnés.', {
  other: 31, async night(E, p) {
    const t = await demonPick(E, p, { title: 'No Dashii : qui tues-tu ?' });
    if (t && real(E, p)) await attack(E, p, t);
  },
});
def('snv', 'demon', 'vortox', 'Vortox', '🌪️', 'Chaque nuit sauf la première : choisis un joueur, il meurt. Les informations des Villageois sont fausses. Chaque jour sans exécution, le Mal gagne.', {
  other: 32, async night(E, p) {
    const t = await demonPick(E, p, { title: 'Vortox : qui tues-tu ?' });
    if (t && real(E, p)) await attack(E, p, t);
  },
});

register(R);
export const BOTC_ROLES = R;

// ---------- mode de jeu ----------
const DIST = { 5: [3, 0, 1, 1], 6: [3, 1, 1, 1], 7: [5, 0, 1, 1], 8: [5, 1, 1, 1], 9: [5, 2, 1, 1], 10: [7, 0, 2, 1], 11: [7, 1, 2, 1], 12: [7, 2, 2, 1], 13: [9, 0, 3, 1], 14: [9, 1, 3, 1], 15: [9, 2, 3, 1] };
export function distribution(n) {
  if (n < 5) return [n - 2 > 0 ? n - 2 : 1, 0, n >= 4 ? 1 : 0, 1];
  return DIST[Math.min(n, 15)];
}
const OUT_MOD = { baron: 2, godfather: 1, fang_gu: 1, vigormortis: -1 };

function poolFor(E) {
  const eds = E.s.options.editions || ['tb'];
  return allRoles('botc').filter((r) => eds.includes(r.ed) || (r.custom && r.game === 'botc'));
}

function autoRoles(E, n) {
  const pool = poolFor(E);
  const by = (tm) => shuffle(pool.filter((r) => r.team === tm).map((r) => r.id));
  let [tf, os, mi, de] = distribution(n);
  const demon = by('demon')[0] || 'imp';
  const minions = by('minion').slice(0, mi);
  let mod = minions.reduce((a, m) => a + (OUT_MOD[m] || 0), 0) + (OUT_MOD[demon] || 0);
  os = Math.max(0, os + mod); tf = n - mi - de - os;
  const outs = by('outsider').slice(0, os);
  tf += os - outs.length;
  const towns = by('townsfolk').slice(0, tf);
  const roles = [demon, ...minions, ...outs, ...towns];
  while (roles.length < n) roles.push(pick(by('townsfolk')) || 'washerwoman');
  return roles.slice(0, n);
}

export const botcMode = {
  id: 'botc', name: 'Blood on the Clocktower', min: 5,
  editions: [{ id: 'tb', name: 'Trouble Brewing' }, { id: 'bmr', name: 'Bad Moon Rising' }, { id: 'snv', name: 'Sects & Violets' }],

  checkRoles(E, roles) {
    const n = E.seated().length;
    if (roles.length !== n) return `Choisis exactement ${n} personnages (actuellement ${roles.length}).`;
    if (!roles.some((id) => getRole(id)?.team === 'demon')) return 'Il faut au moins un Démon.';
    if (new Set(roles).size !== roles.length) return 'Chaque personnage ne peut être pris qu\'une fois.';
    return null;
  },
  alignOf(E, p) { const t = team(p); return t === 'minion' || t === 'demon' ? 'evil' : 'good'; },

  deal(E) {
    const s = E.s, ps = E.seated();
    const roles = E.forcedSeats ? E.forcedSeats.slice() : shuffle(s.options.autoRoles ? autoRoles(E, ps.length) : s.roles.slice());
    s.g.script = [...new Set([...poolFor(E).map((r) => r.id), ...roles])];
    ps.forEach((p, i) => { p.role = roles[i]; p.seen = roles[i]; p.align = this.alignOf(E, p); });
    for (const p of ps) {
      if (p.role === 'drunk') p.seen = pick(notInPlay(E, 'townsfolk')) || 'washerwoman';
      if (p.role === 'lunatic') p.seen = pick(scriptOf(E, 'demon')) || 'imp';
    }
    const taken = new Set(ps.map((p) => p.seen));
    s.bluffs = shuffle(goodRolesNotInPlay(E).filter((r) => !taken.has(r) && r !== 'drunk')).slice(0, 3);
    for (const p of ps) { const r = getRole(p.role); if (r.setup) r.setup(E, p); }
    for (const p of ps) E.tell(p, `Tu es ${rn(p.seen)} (${TEAM_FR[seenTeam(p)]}). ${getRole(p.seen).text}`, { title: 'Ton personnage', silent: true });
  },

  async night(E) {
    const s = E.s, first = s.night === 1;
    await E.runNight(() => {
      const q = [];
      if (first && E.seated().length >= 7) { q.push({ o: 5, kind: 'minionInfo' }, { o: 6, kind: 'demonInfo' }); }
      for (const p of E.seated()) {
        const rid = p.f.phil || p.seen || p.role, r = getRole(rid);
        if (r && r.abilities) { q.push(...nightEntries(E, p, r)); continue; }
        if (!r || !r.night) continue;
        const o = first ? r.first : r.other;
        if (o == null) continue;
        if (!p.alive && !(r.nightDead || p.f.vigor || (p.role === 'zombuul' && p.f.fakeDead))) continue;
        q.push({ pid: p.id, rid, o });
      }
      if (s.g.barber) q.push({ o: 35, kind: 'barber' });
      return q;
    }, async (e) => {
      if (e.kind === 'minionInfo') return evilInfo(E, 'minion');
      if (e.kind === 'demonInfo') return evilInfo(E, 'demon');
      if (e.kind === 'barber') return barber(E);
      const p = E.p(e.pid);
      if (!p) return;
      if (e.k != null) return runAbilityAt(E, p, e.rid, e.k);
      const r = getRole(e.rid);
      const ok = p.alive || r.nightDead || p.f.vigor || (p.role === 'zombuul' && p.f.fakeDead);
      if (ok) await r.night(E, p, { first });
    });
  },

  dawn(E) {
    const s = E.s;
    const ds = s.nd.deaths.map((id) => E.p(id));
    const rev = (s.nd.revived || []).map((id) => E.p(id));
    if (!ds.length) E.pub('☀️ Le jour se lève. Personne n\'est mort cette nuit.', 'day');
    else E.pub(`☀️ Le jour se lève. Cette nuit, ${names(ds)} ${ds.length > 1 ? 'sont morts' : 'est mort(e)'}.`, 'death');
    for (const r of rev) if (r.alive) E.pub(`✨ ${r.name} est revenu(e) à la vie.`);
  },

  async day(E) {
    const s = E.s;
    if (!s.dayState) {
      s.dayState = { noms: [], nominators: [], nominees: [], block: null, top: 0, voting: null, ended: false, executed: null, started: Date.now() };
      s.g.dayAbn = 0;
      if (s.day > 0) E.pub(`Jour ${s.day} : discutez, puis nommez. Le seuil d'exécution est de ${threshold(E)} voix.`, 'day');
    }
    while (!s.dayState.ended && !s.winner) await E.waitSignal();
    if (s.winner) return;
    const ds = s.dayState;
    if (ds.executed) { /* déjà exécuté (Vierge) */ }
    else if (ds.block) await execute(E, E.p(ds.block));
    else {
      E.pub('Personne n\'est exécuté aujourd\'hui.');
      if (vortox(E)) return E.win('evil', 'Aucune exécution sous le règne du Vortox : le Mal l\'emporte !');
      const mayor = E.alive().find((x) => x.role === 'mayor' && sober(E, x));
      if (mayor && E.alive().length === 3) return E.win('good', 'Il reste 3 joueurs et le Maire a tenu : le Bien l\'emporte !');
    }
    if (s.g.mmDay === s.day && s.day > 0) {
      const ex = ds.executed && E.p(ds.executed);
      return E.win(ex && ex.align !== 'evil' ? 'evil' : 'good', ex && ex.align !== 'evil' ? 'Le Cerveau a tenu : un joueur Bon a été exécuté, le Mal l\'emporte !' : 'Le plan du Cerveau a échoué : le Bien l\'emporte !');
    }
  },

  win(E) {
    const s = E.s;
    const cw = customWin(E);
    if (cw) return cw;
    const demons = E.seated().filter((x) => isDemon(x) && (x.alive || (x.role === 'zombuul' && x.f.fakeDead && !x.f.realDead)));
    const twin = E.seated().find((x) => x.role === 'evil_twin' && x.alive);
    const twinBlock = twin && E.p(twin.f.twin)?.alive;
    if (!demons.length) {
      if (s.g.mmDay && s.day < s.g.mmDay) return null;
      if (twinBlock) return null;
      return { team: 'good', text: 'Le Démon est mort : le Bien l\'emporte !' };
    }
    if (E.alive().length <= 2) return { team: 'evil', text: 'Il ne reste que 2 joueurs en vie : le Mal l\'emporte !' };
    return null;
  },

  forceDeath(E, t, cause) { return die(E, t, cause); },

  // ----- actions du jour -----
  actionsFor(E, p, ctl) {
    const s = E.s, ds = s.dayState, out = [];
    if (s.cursor.phase === 'day' && ds && !ds.ended) {
      if (p.alive && !ds.nominators.includes(p.id) && !ds.voting && p.id !== s.stId && s.g.noVoteDay !== s.day)
        out.push({ id: 'nominate', label: 'Nommer un joueur', pick: E.seated().filter((x) => !ds.nominees.includes(x.id)).map((x) => x.id) });
      const r = getRole(p.f.phil || p.seen || p.role);
      if (r && r.day && r.day.can(E, p) && !ds.voting) out.push({ id: 'ability', label: r.day.label });
      if (!ds.voting) for (const d of dayActions(E, p)) out.push({ id: 'ability', k: d.k, label: d.label });
      if (ctl && !ds.voting) out.push({ id: 'endDay', label: ds.block ? `Fin du jour : exécuter ${E.p(ds.block).name}` : 'Fin du jour (personne sur le billot)', ctl: true });
    }
    return out;
  },

  async action(E, p, a, ctl) {
    const s = E.s, ds = s.dayState;
    if (s.cursor.phase !== 'day' || !ds || ds.ended) return;
    if (a.type === 'endDay' && ctl && !ds.voting) { ds.ended = true; E.changed(); return E.signal(); }
    if (a.type === 'ability' && a.k != null) {
      if (p.f.busy || !dayActions(E, p).some((d) => d.k === +a.k)) return;
      p.f.busy = true; try { await runAbilityAt(E, p, p.seen || p.role, +a.k, { trigger: 'day' }); } finally { p.f.busy = false; }
      E.checkWin(); E.changed(); return;
    }
    if (a.type === 'ability') {
      const r = getRole(p.f.phil || p.seen || p.role);
      if (r && r.day && r.day.can(E, p) && !p.f.busy) { p.f.busy = true; try { await r.day.run(E, p); } finally { p.f.busy = false; } E.changed(); }
      return;
    }
    if (a.type === 'nominate') {
      const t = E.p(a.target);
      if (!t || !p.alive || ds.voting || ds.nominators.includes(p.id) || ds.nominees.includes(t.id) || t.id === s.stId) return;
      ds.nominators.push(p.id); ds.nominees.push(t.id);
      E.pub(`☝️ ${p.name} nomme ${t.name}.`, 'nom');
      if (isMinion(p)) s.g.minionNom = s.day;
      if (p.f.cursed === s.day && E.alive().some((x) => x.role === 'witch' && sober(E, x))) { await die(E, p, 'witch'); if (E.checkWin()) return; }
      if (t.role === 'virgin' && !t.f.virginUsed) {
        t.f.virginUsed = true;
        if (sober(E, t) && regTeam(E, p) === 'townsfolk') {
          E.pub(`⚡ ${p.name} est exécuté(e) sur-le-champ !`);
          ds.block = null;
          await execute(E, p);
          ds.ended = true; E.changed(); E.checkWin(); return E.signal();
        }
      }
      await vote(E, p, t);
      E.checkWin();
    }
  },

  dayView(E, me) {
    const ds = E.s.dayState;
    return {
      block: ds.block, top: ds.top, nominators: ds.nominators, nominees: ds.nominees, threshold: threshold(E),
      voting: ds.voting ? { by: ds.voting.by, target: ds.voting.target, done: ds.voting.done.length, total: ds.voting.total } : null,
      noms: ds.noms.slice(-12), started: ds.started,
    };
  },
  publicTags(E, p) {
    const t = [];
    const ds = E.s.dayState;
    if (ds && ds.block === p.id) t.push('🪓 billot');
    if (!p.alive && p.ghost) t.push('👻 vote fantôme');
    if (!p.alive && !p.ghost) t.push('vote utilisé');
    return t;
  },
  privateTags(E, p) {
    const t = [];
    if (p.f.master) t.push(`Maître : ${E.p(p.f.master)?.name}`);
    if (p.f.phil) t.push(`Capacité : ${rn(p.f.phil)}`);
    return t;
  },
  seenAlign(E, p) { const tm = seenTeam(p); return p.role === 'lunatic' ? 'evil' : (tm === 'minion' || tm === 'demon') ? 'evil' : p.align; },

  // pour les rôles sur mesure
  attack: (E, by, t, cause, force) => attack(E, by, t, cause || 'ability', !!force),
  lies, regEvil, real, impaired,
  protect(E, t) { t.f.safe = E.s.night; },
  poison(E, t) { t.f.poison = E.s.clock + 2; },
  regRole,
};

function threshold(E) { return Math.ceil(E.alive().length / 2); }

async function vote(E, by, t) {
  const s = E.s, ds = s.dayState;
  const voters = E.seated().filter((x) => (x.alive || x.ghost) && !x.f.noVote && x.f.muteDay !== s.day);
  ds.voting = { by: by.id, target: t.id, done: [], total: voters.length };
  E.changed();
  const answers = await Promise.all(voters.map(async (v) => {
    const yes = await E.ask(v.id, { type: 'vote', title: `Vote : exécuter ${t.name} ?`, text: `${by.name} a nommé ${t.name}. Seuil : ${threshold(E)} voix.${v.alive ? '' : ' Tu es mort : voter OUI utilise ton vote fantôme.'}${v.role === 'butler' && !impaired(E, v) && v.f.master ? ` (Majordome : ton OUI ne compte que si ${E.p(v.f.master).name} vote OUI.)` : ''}`, target: t.id });
    ds.voting && ds.voting.done.push(v.id); E.changed();
    return [v, yes];
  }));
  const yesBy = new Set(answers.filter(([, y]) => y).map(([v]) => v.id));
  const counted = answers.filter(([v, y]) => {
    if (!y) return false;
    if (v.role === 'butler' && !impaired(E, v) && v.f.master && !yesBy.has(v.f.master)) return false;
    return true;
  }).map(([v]) => v);
  for (const v of counted) if (!v.alive) v.ghost = false;
  if (counted.some(isDemon)) s.g.demonVoted = s.day;
  const weight = (v) => (v.f.weight && v.f.weight.day === s.day ? v.f.weight.n : getRole(v.role)?.passives?.voteWeight ?? 1);
  const extra = s.g.extra && s.g.extra[t.id] && s.g.extra[t.id].day === s.day ? s.g.extra[t.id].n : 0;
  const n = counted.reduce((a, v) => a + weight(v), 0) + extra, th = threshold(E);
  ds.noms.push({ by: by.id, target: t.id, yes: counted.map((v) => v.id), n });
  ds.voting = null;
  let res;
  if (n >= th && n > ds.top) { ds.block = t.id; ds.top = n; res = `${t.name} va sur le billot (${n} voix).`; }
  else if (n >= th && n === ds.top) { ds.block = null; res = `Égalité à ${n} voix : personne sur le billot.`; }
  else res = `${n} voix : pas assez.`;
  E.pub(`🗳️ ${t.name} : ${n} voix (${names(counted) || 'personne'}${extra ? ` + ${extra} imposée(s)` : ''}). ${res}`, 'vote');
}

async function evilInfo(E, kind) {
  const s = E.s;
  const minions = E.seated().filter(isMinion), demon = E.seated().find(isDemon);
  const lun = E.seated().find((x) => x.role === 'lunatic');
  if (kind === 'minion') {
    for (const m of minions) await E.tell(m, `Le Démon est ${demon ? demon.name : '?'}.${minions.length > 1 ? ` Les autres Sbires : ${names(minions.filter((x) => x !== m))}.` : ''}`, { title: 'Le Mal se reconnaît' });
  } else {
    if (demon) await E.tell(demon, `Tes Sbires : ${names(minions) || 'aucun'}. Personnages absents (pour bluffer) : ${s.bluffs.map(rn).join(', ')}.${lun ? ` Le Lunatique est ${lun.name}.` : ''}`, { title: 'Le Mal se reconnaît' });
    if (lun) {
      const fake = shuffle(E.seated().filter((x) => x !== lun)).slice(0, minions.length);
      await E.tell(lun, `Tes Sbires : ${names(fake)}. Personnages absents : ${shuffle(goodRolesNotInPlay(E)).slice(0, 3).map(rn).join(', ')}.`, { title: 'Le Mal se reconnaît' });
    }
  }
}

async function barber(E) {
  E.s.g.barber = false;
  const d = E.alive().find(isDemon);
  if (!d) return;
  if (!(await E.yesno(d, 'Barbier', 'Le Barbier est mort : échanger les personnages de 2 joueurs ?'))) return;
  const ts = await E.choose(d, { n: 2, self: false, dead: true, filter: (x) => !isDemon(x), title: 'Barbier : quels joueurs échanger ?' });
  if (ts.length !== 2) return;
  const [a, b] = ts;
  [a.role, b.role] = [b.role, a.role];
  a.seen = a.role; b.seen = b.role;
  await E.tell(a, `Le Barbier t'a coiffé : tu es désormais ${rn(a.role)}.`);
  await E.tell(b, `Le Barbier t'a coiffé : tu es désormais ${rn(b.role)}.`);
}
