// Rôles sur mesure : une définition en données, compilée en rôle jouable.
// Les effets passent par les primitives du mode (attack, protect, regEvil…), pour suivre ses règles.

export const ACTS = {
  none: 'Aucune action de nuit',
  kill: 'Tuer un joueur',
  protect: 'Protéger un joueur',
  inspect_align: 'Découvrir le camp d\'un joueur',
  inspect_role: 'Découvrir le rôle d\'un joueur',
  poison: 'Empoisonner un joueur (BotC)',
  neighbors: 'Compter les méchants parmi ses voisins',
  evil_count: 'Compter les méchants vivants',
  revive: 'Ressusciter un mort',
};
const NO_TARGET = ['none', 'neighbors', 'evil_count'];

export const TEAMS = {
  lg: { village: 'Village', loup: 'Loups-Garous', solo: 'Solitaire' },
  botc: { townsfolk: 'Villageois', outsider: 'Étranger', minion: 'Sbire', demon: 'Démon' },
};

export function blankCustom(game = 'lg') {
  return {
    id: 'c_' + Math.random().toString(36).slice(2, 8), game, name: '', icon: '✨', text: '',
    team: game === 'lg' ? 'village' : 'townsfolk', when: 'each', order: 15, act: 'inspect_role',
    targets: 1, self: false, optional: false, uses: 0, multi: false,
    nightImmune: false, extraLife: false, deathShot: false, joinWolves: false, appears: '',
  };
}

const clamp = (x, a, b) => Math.max(a, Math.min(b, Math.round(+x || 0)));

export function compileCustom(d) {
  if (!d || !d.id || !d.name || !TEAMS[d.game] || !TEAMS[d.game][d.team]) throw new Error('définition incomplète');
  const lg = d.game === 'lg';
  const r = {
    id: d.id, custom: true, game: d.game, ed: 'custom', team: d.team,
    name: String(d.name).slice(0, 40), icon: String(d.icon || '✨').slice(0, 4), text: String(d.text || ACTS[d.act] || '').slice(0, 400),
    wolf: lg && (d.team === 'loup' || !!d.joinWolves), multi: !!d.multi,
    nightImmune: !!d.nightImmune, extraLife: !!d.extraLife, deathShot: !!d.deathShot, appears: d.appears || '',
  };
  const act = ACTS[d.act] ? d.act : 'none';
  if (d.when !== 'none' && act !== 'none') {
    const o = clamp(d.order, 1, 80);
    r.first = d.when === 'first' || d.when === 'each' ? o : null;
    r.other = d.when === 'each' || d.when === 'others' ? o : null;
    r.night = async (E, p) => {
      const M = E.mode, f = p.f;
      if (d.uses > 0 && (f.uses || 0) >= d.uses) return;
      const evilWord = (b) => (lg ? (b ? 'un loup' : 'pas un loup') : (b ? 'Mauvais' : 'Bon'));
      if (NO_TARGET.includes(act)) {
        let n = act === 'neighbors' ? E.neighbors(p).filter((x) => M.regEvil(E, x)).length : E.alive().filter((x) => M.regEvil(E, x)).length;
        if (M.lies(E, p)) n = Math.max(0, n + (Math.random() < 0.5 ? -1 : 1));
        f.uses = (f.uses || 0) + 1;
        return E.tell(p, act === 'neighbors' ? `${n} de tes voisins vivants ${lg ? 'sont des loups' : 'sont Mauvais'}.` : `Il y a ${n} joueur(s) ${lg ? 'loups' : 'Mauvais'} en vie.`);
      }
      const n = clamp(d.targets, 1, 3);
      const ts = await E.choose(p, { n, min: d.optional || d.uses > 0 ? 0 : n, self: !!d.self, deadOnly: act === 'revive', title: `${r.icon} ${r.name}`, text: ACTS[act] + (d.optional || d.uses > 0 ? ' (ou personne)' : '') });
      if (!ts.length) return;
      f.uses = (f.uses || 0) + 1;
      const real = M.real(E, p), lies = M.lies(E, p);
      for (const t of ts) {
        switch (act) {
          case 'kill': if (real) await M.attack(E, p, t, 'pouvoir'); break;
          case 'protect': if (real) M.protect(E, t); break;
          case 'poison': if (real) M.poison(E, t); break;
          case 'inspect_align': { let b = M.regEvil(E, t); if (lies) b = !b; await E.tell(p, `${t.name} est ${evilWord(b)}.`); break; }
          case 'inspect_role': {
            let role = M.regRole(E, t);
            if (lies) { const all = (E.s.g.script || E.seated().map((x) => x.role)).filter((x) => x !== t.role); role = all[Math.floor(Math.random() * all.length)] || role; }
            await E.tell(p, `${t.name} est ${E.rn(role)}.`); break;
          }
          case 'revive': if (real && !t.alive) { t.alive = true; t.ghost = true; t.dead = null; E.pub(`✨ ${t.name} revient à la vie !`); } break;
        }
      }
    };
  }
  return [r];
}

/** Partage : code texte compact (base64 du JSON). */
export function exportCode(d) { return 'VEIL1:' + btoa(unescape(encodeURIComponent(JSON.stringify(d)))); }
export function importCode(code) {
  const m = String(code).trim().match(/^VEIL1:([A-Za-z0-9+/=]+)$/);
  if (!m) throw new Error('Code invalide');
  const d = JSON.parse(decodeURIComponent(escape(atob(m[1]))));
  compileCustom(d);
  return d;
}
