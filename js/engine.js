// Moteur commun : joueurs, invites (prompts), messages, boucle de phases.
// Tourne uniquement chez l'hôte. Les modes (botc.js, lg.js) apportent les règles.
import { MODES } from './modes.js';
import { getRole, roleName, installCustom } from './roles/index.js';
import { uid, shuffle, pick, chance } from './util.js';
import { rollEvents, fireDusk, fireDawn } from './rules.js';

export function newState(code, host) {
  return {
    v: 1, code, mode: 'lg', phase: 'lobby',
    hostId: host.id, stId: null,
    players: [mkPlayer(host, 0)],
    roles: [],            // ids choisis (doublons possibles pour LG)
    custom: [],           // définitions de rôles sur mesure apportées par l'hôte
    events: [],           // événements sur mesure (chacun a sa probabilité d'apparaître)
    options: { autoRoles: true, stValidates: true, revealOnDeath: true, captain: true, fakeActions: true, dayMinutes: 0, announceEvents: true },
    day: 0, night: 0, clock: 0,
    cursor: null, nightQ: [], nightI: 0, nd: {}, dayState: null,
    pub: [], log: [], prompts: {}, winner: null, bluffs: [], g: {},
  };
}

export function mkPlayer({ id, name, token }, seat) {
  return { id, token, name, seat, alive: true, role: null, seen: null, align: null, ghost: true, notes: [], f: {}, connected: true, dead: null };
}

export class Engine {
  constructor(state, hooks = {}) {
    this.s = state;
    this.hooks = hooks;
    this.resolvers = {};
    this.auto = null;           // (prompt) => valeur : bots de simulation
    this.waiters = [];
    installCustom(state.custom);
  }

  get mode() { return MODES[this.s.mode]; }
  get players() { return this.s.players; }
  changed() { this.hooks.changed && this.hooks.changed(); }

  // ---------- joueurs ----------
  p(id) { return this.s.players.find((x) => x.id === id); }
  seated() { return this.s.players.filter((x) => x.id !== this.s.stId).sort((a, b) => a.seat - b.seat); }
  alive() { return this.seated().filter((x) => x.alive); }
  dead() { return this.seated().filter((x) => !x.alive); }
  role(p) { return getRole(p.role); }
  seen(p) { return getRole(p.seen || p.role); }
  withRole(id) { return this.seated().filter((x) => x.role === id); }
  aliveWith(id) { return this.alive().filter((x) => x.role === id); }
  inPlay(id) { return this.seated().some((x) => x.role === id); }
  rn(id) { return roleName(id); }

  /** Voisins dans le cercle (vivants par défaut), [gauche, droite]. */
  neighbors(p, aliveOnly = true) {
    const list = aliveOnly ? this.seated().filter((x) => x.alive || x === p) : this.seated();
    const i = list.indexOf(p);
    if (i < 0 || list.length < 2) return [];
    const l = list[(i - 1 + list.length) % list.length], r = list[(i + 1) % list.length];
    return l === r ? [l] : [l, r];
  }
  /** Distance en sièges (dans les deux sens, la plus courte), sur tous les joueurs. */
  seatDistance(a, b) {
    const list = this.seated(), n = list.length;
    const d = Math.abs(list.indexOf(a) - list.indexOf(b));
    return Math.min(d, n - d);
  }

  // ---------- invites ----------
  ask(pid, spec) {
    const p = this.p(pid);
    if (this.s.winner || !p) return new Promise(() => {});
    const id = uid();
    const pr = { id, pid, spec, t: Date.now() };
    if (p && p.f) spec.forName = p.name;
    this.s.prompts[id] = pr;
    this.changed();
    return new Promise((res) => {
      this.resolvers[id] = res;
      if (this.auto) setTimeout(() => { if (this.s.prompts[id]) this.answer(pid, id, this.auto(pr, this), true); }, 0);
    });
  }

  answer(pid, id, value, force = false) {
    const pr = this.s.prompts[id];
    if (!pr) return false;
    if (!force && pr.pid !== pid) return false;
    const v = this.validate(pr, value);
    if (v === undefined) return false;
    delete this.s.prompts[id];
    const r = this.resolvers[id];
    delete this.resolvers[id];
    this.changed();
    if (r) r(v);
    return true;
  }

  /** Réponse au hasard mais valide (bouton « forcer » ou bot). */
  randomAnswer(pr) {
    const sp = pr.spec;
    switch (sp.type) {
      case 'players': {
        const opts = shuffle(sp.options);
        const min = sp.min ?? sp.n;
        const k = min + Math.floor(Math.random() * (sp.n - min + 1));
        return opts.slice(0, Math.min(k, opts.length));
      }
      case 'choice': return pick(sp.options).v;
      case 'role': return pick(sp.options);
      case 'yesno': return chance(0.5);
      case 'vote': return chance(0.4);
      case 'approve': return sp.text;
      case 'ack': return true;
      case 'text': return sp.placeholder || '…';
      default: return null;
    }
  }

  validate(pr, v) {
    const sp = pr.spec;
    switch (sp.type) {
      case 'players': {
        if (!Array.isArray(v)) return undefined;
        const min = sp.min ?? sp.n, max = sp.n;
        if (v.length < min || v.length > max || new Set(v).size !== v.length) return undefined;
        if (!v.every((x) => sp.options.includes(x))) return undefined;
        return v;
      }
      case 'choice': return sp.options.some((o) => o.v === v) ? v : undefined;
      case 'role': return sp.options.includes(v) ? v : undefined;
      case 'yesno': case 'vote': case 'ack': return !!v;
      case 'approve': case 'text': return typeof v === 'string' ? v.slice(0, 500) : undefined;
      default: return v;
    }
  }

  /** Choisir des joueurs. Renvoie des objets joueurs. */
  async choose(p, { n = 1, min, title, text, self = false, dead = false, deadOnly = false, filter, exclude = [] } = {}) {
    let opts = this.seated().filter((x) => (deadOnly ? !x.alive : dead || x.alive) && (self || x !== p) && !exclude.includes(x) && (!filter || filter(x)));
    if (!opts.length) return [];
    n = Math.min(n, opts.length);
    if (min !== undefined) min = Math.min(min, n);
    const ids = await this.ask(p.id, { type: 'players', n, min, title, text, options: opts.map((x) => x.id) });
    return ids.map((id) => this.p(id));
  }
  async choose1(p, o) { return (await this.choose(p, { ...o, n: 1 }))[0] || null; }
  choice(p, title, options, text) { return this.ask(p.id, { type: 'choice', title, text, options }); }
  chooseRole(p, title, roleIds, text) { return this.ask(p.id, { type: 'role', title, text, options: roleIds }); }
  yesno(p, title, text) { return this.ask(p.id, { type: 'yesno', title, text }); }

  // ---------- messages ----------
  /** Information privée. Passe par le MJ s'il valide les infos. */
  async tell(p, text, { title = 'Information', silent = false } = {}) {
    if (this.s.stId && this.s.options.stValidates && !silent && this.p(this.s.stId)?.connected !== false) {
      text = await this.ask(this.s.stId, { type: 'approve', title: `Info pour ${p.name} (${this.rn(p.role)})`, text });
    }
    p.notes.push({ n: this.s.night, d: this.s.day, ph: this.s.cursor?.phase || 'setup', title, text });
    this.log(`→ ${p.name} : ${text}`);
    this.changed();
  }
  pub(text, kind = 'info') { this.s.pub.push({ t: Date.now(), kind, text, d: this.s.day, n: this.s.night }); this.log(`[public] ${text}`); this.changed(); }
  log(text) { this.s.log.push(text); if (this.s.log.length > 600) this.s.log.shift(); if (this.hooks.log) this.hooks.log(text); }

  // ---------- partie ----------
  canStart() {
    const n = this.seated().length;
    const M = this.mode;
    if (n < M.min) return `Il faut au moins ${M.min} joueurs (hors MJ).`;
    if (this.forcedSeats) return this.forcedSeats.length === n ? null : 'Un rôle par joueur, svp.';
    if (!this.s.options.autoRoles) {
      const err = M.checkRoles(this, this.s.roles);
      if (err) return err;
    }
    return null;
  }

  start() {
    const s = this.s;
    installCustom(s.custom);
    s.phase = 'game';
    s.seat = 0;
    const seated = this.forcedSeats ? this.seated() : shuffle(this.seated());
    seated.forEach((p, i) => { p.seat = i; p.alive = true; p.ghost = true; p.notes = []; p.f = {}; p.dead = null; });
    s.pub = []; s.log = []; s.winner = null; s.day = 0; s.night = 0; s.g = {}; s.nd = {};
    this.mode.deal(this);
    rollEvents(this);
    this.log('Distribution : ' + this.seated().map((p) => `${p.name}=${this.rn(p.role)}${p.seen && p.seen !== p.role ? ` (croit ${this.rn(p.seen)})` : ''}`).join(', '));
    s.cursor = { phase: this.mode.startsWithDay && this.mode.startsWithDay(this) ? 'day' : 'night' };
    if (s.cursor.phase === 'night') { s.night = 1; s.clock = 2; s.nightQ = null; } else { s.day = 0; s.clock = 1; }
    this.changed();
    return this.run();
  }

  async run() {
    const s = this.s;
    this.running = true;
    try {
      while (!s.winner && s.phase === 'game') {
        if (s.cursor.phase === 'night') {
          await this.mode.night(this);
          if (s.winner || s.phase !== 'game') break;
          if (this.mode.dawn) await this.mode.dawn(this);
          if (s.winner || s.phase !== 'game') break;
          // Le matin appartient déjà au jour : les événements de l'aube tuent immédiatement.
          s.day = s.night; s.clock = s.night * 2 + 1; s.cursor = { phase: 'day' }; s.dayState = null;
          await fireDawn(this);
          if (s.winner || s.phase !== 'game') break;
          this.checkWin();
          if (s.winner) break;
          this.changed();
        } else {
          await this.mode.day(this);
          if (s.winner || s.phase !== 'game') break;
          this.checkWin();
          if (s.winner) break;
          s.night = s.day + 1; s.clock = s.night * 2; s.cursor = { phase: 'night' }; s.nightQ = null;
          this.changed();
        }
      }
    } finally { this.running = false; }
  }

  /** Reprise après rechargement de l'hôte : on relance l'étape en cours. */
  resume() {
    if (this.s.phase !== 'game' || this.running) return;
    this.s.prompts = {};
    if (this.s.dayState) this.s.dayState.voting = null;
    this.pub('La partie reprend (l\'hôte s\'est reconnecté).', 'sys');
    this.run();
  }

  checkWin() {
    if (this.s.winner) return true;
    const w = this.mode.win(this);
    if (w) this.win(w.team, w.text);
    return !!w;
  }

  /** Fin de partie : les attentes en cours sont abandonnées (jamais résolues). */
  win(team, text) {
    if (this.s.winner) return;
    this.s.winner = { team, text };
    this.flush();
    this.finish();
  }
  flush() {
    this.s.prompts = {};
    this.resolvers = {};
    this.waiters = [];
  }

  finish() {
    const s = this.s;
    if (s.phase === 'end') return;
    s.phase = 'end';
    this.pub(`🏁 ${s.winner.text}`, 'win');
    this.changed();
  }

  /**
   * Déroule une nuit : file triée d'entrées {pid, rid, o}, reprise possible à l'entrée en cours.
   * runEntry(e) exécute une entrée ; build() construit la file en début de nuit.
   */
  async runNight(build, runEntry) {
    const s = this.s;
    if (!s.nightQ) {
      s.nd = { deaths: [], woke: [], abn: [] };
      s.nightQ = build().sort((a, b) => a.o - b.o);
      s.nightI = 0;
      this.pub(`🌙 Nuit ${s.night}. Tout le monde ferme les yeux.`, 'night');
      if (s.options.fakeActions) this.fakeActions();
    }
    if (!s.nd.duskDone) { s.nd.duskDone = true; await fireDusk(this); if (s.winner) return; }
    while (s.nightI < s.nightQ.length) {
      const e = s.nightQ[s.nightI];
      const p = e.pid && this.p(e.pid);
      if (p && !s.nd.woke.includes(p.id)) s.nd.woke.push(p.id);
      await runEntry(e);
      if (s.winner) return;
      s.nightI++;
      this.changed();
    }
    for (const [id, pr] of Object.entries(s.prompts)) if (pr.spec.dummy) { delete s.prompts[id]; delete this.resolvers[id]; }
  }

  /** Insère une entrée dans la file de la nuit en cours, après l'entrée courante. */
  queueLater(e) {
    const q = this.s.nightQ;
    if (!q) return;
    let i = this.s.nightI + 1;
    while (i < q.length && q[i].o <= e.o) i++;
    q.splice(i, 0, e);
  }

  /** Les joueurs sans action reçoivent un choix sans effet, pour que personne ne se trahisse. */
  fakeActions() {
    const active = new Set(this.s.nightQ.flatMap((e) => e.pids || (e.pid ? [e.pid] : [])));
    for (const p of this.alive()) {
      if (active.has(p.id)) continue;
      const opts = this.alive().filter((x) => x !== p).map((x) => x.id);
      if (!opts.length) continue;
      this.ask(p.id, { type: 'players', n: 1, dummy: true, title: 'Tu dors…', text: 'Touche un joueur au hasard pour faire comme les autres. Cela n\'a aucun effet.', options: opts });
    }
  }

  /** Attendre un signal (fin du jour, lancement du vote…). */
  waitSignal() { return new Promise((r) => this.waiters.push(r)); }
  signal() { const w = this.waiters.splice(0); w.forEach((f) => f()); }

  // ---------- actions joueurs hors invites ----------
  action(pid, a) {
    const p = this.p(pid);
    if (!p) return;
    const isCtl = pid === this.s.hostId || pid === this.s.stId;
    if (a.type === 'force' && isCtl) {
      const pr = this.s.prompts[a.id];
      if (pr && (pid === this.s.stId || pr.pid !== pid || true)) this.answer(pr.pid, pr.id, this.randomAnswer(pr), true);
      return;
    }
    if (a.type === 'forceAll' && isCtl) {
      for (const pr of Object.values(this.s.prompts)) if (pr.spec.type !== 'approve' || pid === this.s.stId) this.answer(pr.pid, pr.id, this.randomAnswer(pr), true);
      return;
    }
    if (a.type === 'st' && pid === this.s.stId) return this.stTool(a);
    if (a.type === 'abort' && pid === this.s.hostId) { this.win('none', 'Partie interrompue par l\'hôte.'); return; }
    return this.mode.action(this, p, a, isCtl);
  }

  /** Outils manuels du MJ (grimoire). */
  stTool(a) {
    const t = this.p(a.target);
    switch (a.tool) {
      case 'kill': if (t && t.alive) { this.mode.forceDeath(this, t, 'mj'); } break;
      case 'revive': if (t && !t.alive) { t.alive = true; t.ghost = true; t.dead = null; this.pub(`${t.name} revient à la vie.`); } break;
      case 'poison': if (t) { t.f.mjPoison = !t.f.mjPoison; } break;
      case 'role': if (t && getRole(a.role)) { t.role = a.role; t.seen = a.role; t.align = this.mode.alignOf(this, t); this.tell(t, `Ton rôle est désormais : ${this.rn(a.role)}.`, { silent: true }); } break;
      case 'align': if (t) { t.align = t.align === 'evil' ? 'good' : 'evil'; this.tell(t, `Ton camp a changé : tu es désormais ${t.align === 'evil' ? 'Mauvais' : 'Bon'}.`, { silent: true }); } break;
      case 'msg': if (t && a.text) this.tell(t, a.text, { title: 'Message du MJ', silent: true }); break;
      case 'pub': if (a.text) this.pub(a.text, 'mj'); break;
      case 'win': this.win(a.team, a.team === 'good' ? 'Le MJ déclare la victoire du camp du Bien.' : 'Le MJ déclare la victoire du camp du Mal.'); break;
      case 'ghost': if (t) t.ghost = !t.ghost; break;
    }
    this.changed();
  }

  // ---------- vue filtrée par joueur ----------
  view(pid) {
    const s = this.s, me = this.p(pid);
    const isST = pid === s.stId, isHost = pid === s.hostId;
    const end = s.phase === 'end';
    const v = {
      code: s.code, mode: s.mode, phase: s.phase, day: s.day, night: s.night,
      cursor: s.cursor, hostId: s.hostId, stId: s.stId, winner: s.winner,
      options: s.options, roles: s.roles, custom: s.custom, events: s.events,
      pub: s.pub.slice(-80),
      players: s.players.slice().sort((a, b) => a.seat - b.seat).map((p) => ({
        id: p.id, name: p.name, seat: p.seat, alive: p.alive, ghost: p.ghost, connected: p.connected, ver: p.v,
        st: p.id === s.stId,
        shown: end || isST ? p.role : (p.f.revealed ? p.f.revealed : null),
        tags: this.mode.publicTags ? this.mode.publicTags(this, p) : [],
      })),
      me: me ? {
        id: me.id, name: me.name, alive: me.alive, ghost: me.ghost, isST, isHost,
        role: me.seen || me.role, align: me.role && this.mode.seenAlign ? this.mode.seenAlign(this, me) : me.align,
        notes: me.notes, tags: me.role && this.mode.privateTags ? this.mode.privateTags(this, me) : [],
      } : null,
      prompts: Object.values(s.prompts).filter((pr) => pr.pid === pid).map(({ id, spec, t }) => ({ id, spec, t })),
      pendingCount: Object.keys(s.prompts).length,
      pendingOld: Object.values(s.prompts).filter((pr) => pr.pid !== pid).map((pr) => ({ id: pr.id, t: pr.t, who: isST ? this.p(pr.pid)?.name : null, type: pr.spec.type })),
      dayState: s.dayState ? this.mode.dayView(this, me) : null,
      actions: me && s.phase === 'game' ? this.mode.actionsFor(this, me, isHost && !s.stId || isST) : [],
    };
    if (isST || end) v.grim = this.grimoire();
    return v;
  }

  grimoire() {
    const s = this.s;
    return {
      players: this.seated().map((p) => ({ id: p.id, role: p.role, seen: p.seen, align: p.align, f: p.f, alive: p.alive })),
      log: s.log.slice(-300), bluffs: s.bluffs,
      events: (s.g.ev || []).map((e) => ({ ...e, name: (s.events.find((x) => x.id === e.id) || {}).name })),
    };
  }
}
