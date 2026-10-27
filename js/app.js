// Interface : accueil, salon, partie, éditeur de rôles, almanach.
import { Engine, newState, mkPlayer } from './engine.js';
import { MODES } from './modes.js';
import { getRole, roleName, allRoles, installCustom } from './roles/index.js';
import { TEAMS, exportCode, importCode } from './roles/custom.js';
import { HostNet, ClientNet, makeCode, cleanCode } from './net.js';
import { uid } from './util.js';
import { VERSION } from './version.js';
import * as RU from './rules.js';
import { buildGame, batch, dayDriver } from './simcore.js';

// ---------- stockage local ----------
// ?profil=x isole un profil de test (plusieurs joueurs dans un même navigateur).
const PROFILE = (new URLSearchParams(location.search).get('profil') || '').replace(/[^a-z0-9_-]/gi, '');
const key = (k) => (PROFILE ? `${k}@${PROFILE}` : k);
const LS = {
  get(k, d) { try { const v = localStorage.getItem(key(k)); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(key(k), JSON.stringify(v)); } catch { } },
  del(k) { try { localStorage.removeItem(key(k)); } catch { } },
};
const me = { token: LS.get('vl-token') || (() => { const t = uid() + uid(); LS.set('vl-token', t); return t; })(), name: LS.get('vl-name', '') };
const myCustom = () => LS.get('vl-custom', []).map((d) => { try { return RU.normalizeRole(d); } catch { return null; } }).filter(Boolean);
const myEvents = () => LS.get('vl-events', []).map((d) => { try { return RU.normalizeEvent(d); } catch { return null; } }).filter(Boolean);

const ui = {
  screen: 'home', tab: 'game', view: null, status: 'idle', statusMsg: '', sel: {}, modal: null,
  edit: null, alm: { game: 'lg', q: '' }, showRole: false, toast: null, seenNotes: 0, promptIds: new Set(),
  joinCode: new URLSearchParams(location.search).get('code') || '', installEvt: null, stMsg: {}, drawn: new Set(),
  editKind: 'role', libTab: 'role', update: null, verWarn: null,
};
let lab = null;     // laboratoire : { E, viewAs, bots, dayAuto, delay, omni, cfg }
let host = null;    // { E, net, conns: Map pid→conn }
let client = null;  // ClientNet

const $app = document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const role = (id) => getRole(id);
const TEAM_LABEL = { townsfolk: 'Villageois', outsider: 'Étranger', minion: 'Sbire', demon: 'Démon', village: 'Village', loup: 'Loups-Garous', solo: 'Solitaire' };
const ALIGN_LABEL = { good: 'Bien', evil: 'Mal', solo: 'Solitaire' };
const ED_LABEL = { tb: 'Trouble Brewing', bmr: 'Bad Moon Rising', snv: 'Sects & Violets', base: 'Jeu de base', nl: 'Nouvelle Lune', perso: 'Personnages & Village', custom: 'Sur mesure' };

function toast(msg, ms = 2600) { ui.toast = msg; render(); clearTimeout(toast.t); toast.t = setTimeout(() => { ui.toast = null; render(); }, ms); }

// ---------- hôte ----------
function hostGame(resume) {
  const code = resume ? resume.code : makeCode();
  const s = resume || newState(code, { id: uid(), name: me.name || 'Hôte', token: me.token });
  const E = new Engine(s, { changed: scheduleSync });
  host = { E, conns: new Map(), net: null };
  host.net = new HostNet(code, {
    onMsg: hostMsg,
    onClose: (conn) => { const pid = conn._pid; if (pid && host.conns.get(pid) === conn) { host.conns.delete(pid); const p = E.p(pid); if (p) p.connected = false; scheduleSync(); } },
    onStatus: setStatus,
  });
  ui.screen = 'room'; ui.tab = 'game';
  if (resume) {
    for (const p of s.players) p.connected = p.token === me.token;
    if (s.phase === 'game') E.resume();
  }
  keepAwake();
  scheduleSync();
}

function hostMsg(conn, m) {
  if (!m || typeof m !== 'object') return;
  const E = host.E, s = E.s;
  if (m.t === 'hello') {
    const name = String(m.name || 'Joueur').trim().slice(0, 20) || 'Joueur';
    let p = s.players.find((x) => x.token === m.token);
    if (!p) {
      if (s.phase !== 'lobby') return host.net.send(conn, { t: 'reject', why: 'La partie a déjà commencé.' });
      if (s.players.length >= 24) return host.net.send(conn, { t: 'reject', why: 'La partie est pleine.' });
      p = mkPlayer({ id: uid(), name, token: m.token }, s.players.length);
      s.players.push(p);
    } else if (s.phase === 'lobby') p.name = name;
    p.v = String(m.v || '?');
    const old = host.conns.get(p.id);
    if (old && old !== conn) try { old.close(); } catch { }
    conn._pid = p.id; host.conns.set(p.id, conn); p.connected = true;
    host.net.send(conn, { t: 'welcome', pid: p.id, v: VERSION });
    scheduleSync();
    return;
  }
  const pid = conn._pid;
  if (!pid) return;
  if (m.t === 'answer') E.answer(pid, m.id, m.v);
  else if (m.t === 'act') E.action(pid, m.a || {});
  else if (m.t === 'leave' && s.phase === 'lobby') { s.players = s.players.filter((x) => x.id !== pid); host.conns.delete(pid); if (s.stId === pid) s.stId = null; scheduleSync(); }
}

let syncT = null;
function scheduleSync() { if (!syncT) syncT = setTimeout(sync, 30); }
function sync() {
  syncT = null;
  if (!host) return;
  const E = host.E;
  for (const [pid, conn] of host.conns) host.net.send(conn, { t: 'view', v: E.view(pid) });
  setView(E.view(E.s.hostId));
  LS.set('vl-host', E.s);
}

// ---------- client ----------
function joinGame(code) {
  code = cleanCode(code);
  if (code.length !== 5) return toast('Le code fait 5 lettres.');
  if (!me.name) return toast('Choisis d\'abord un pseudo.');
  leave(true);
  LS.set('vl-last', code);
  ui.screen = 'room'; ui.view = null; ui.tab = 'game';
  client = new ClientNet(code, {
    hello: () => ({ t: 'hello', name: me.name, token: me.token, v: VERSION }),
    onStatus: setStatus,
    onMsg: (m) => {
      if (m.t === 'view') setView(m.v);
      else if (m.t === 'welcome') { ui.verWarn = m.v && m.v !== VERSION ? m.v : null; render(); }
      else if (m.t === 'reject') { toast(m.why, 4000); leave(); }
      else if (m.t === 'kick') { toast('L\'hôte t\'a retiré de la partie.', 4000); LS.del('vl-last'); leave(); }
    },
  });
  keepAwake();
  render();
}

function setStatus(st, msg = '') { ui.status = st; ui.statusMsg = msg; if (st === 'error') toast(msg, 4000); render(); }

function setView(v) {
  const prev = ui.view;
  ui.view = v;
  installCustom(v.custom || []);
  if (ui.screen !== 'room' && ui.screen !== 'lab') ui.screen = 'room';
  const ids = new Set(v.prompts.map((p) => p.id));
  const fresh = [...ids].some((id) => !ui.promptIds.has(id));
  ui.promptIds = ids;
  if (fresh) { try { navigator.vibrate && navigator.vibrate(120); } catch { } if (ui.tab !== 'game' && ui.tab !== 'grim') ui.tab = 'game'; }
  if (prev && prev.phase === 'lobby' && v.phase === 'game') { ui.showRole = false; ui.seenNotes = 0; ui.tab = 'game'; }
  for (const id of Object.keys(ui.sel)) if (!ids.has(id)) delete ui.sel[id];
  document.body.dataset.phase = v.phase === 'game' ? v.cursor?.phase || 'night' : v.phase;
  render();
}

function send(kind, payload) {
  if (lab && lab.E && ui.screen === 'lab') return labSend(kind, payload);
  if (host) {
    const E = host.E, pid = E.s.hostId;
    if (kind === 'answer') E.answer(pid, payload.id, payload.v);
    else E.action(pid, payload);
  } else if (client) {
    if (!client.send(kind === 'answer' ? { t: 'answer', id: payload.id, v: payload.v } : { t: 'act', a: payload })) toast('Pas connecté pour l\'instant…');
  }
}

function leave(silent) {
  if (client) { client.send({ t: 'leave' }); client.close(); client = null; }
  if (host) { host.net.close(); host = null; }
  ui.view = null; ui.status = 'idle';
  if (!silent) { ui.screen = 'home'; document.body.dataset.phase = 'home'; render(); }
}

let wakeLock = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => (wakeLock = null)); } } catch { }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && ui.screen === 'room') keepAwake(); });

// ---------- rendu ----------
function render() {
  const a = document.activeElement;
  const focus = a && a.id ? { id: a.id, s: a.selectionStart, e: a.selectionEnd } : null;
  const scroll = document.querySelector('.scroll')?.scrollTop;
  let html;
  switch (ui.screen) {
    case 'room': html = renderRoom(); break;
    case 'editor': html = renderEditor(); break;
    case 'almanac': html = renderAlmanac(); break;
    case 'lab': html = lab && lab.E && ui.view ? renderGame(ui.view) : renderLabSetup(); break;
    default: html = renderHome();
  }
  $app.innerHTML = updateBanner() + html + renderModal() + (ui.toast ? `<div class="toast">${esc(ui.toast)}</div>` : '');
  if (focus) { const el = document.getElementById(focus.id); if (el) { el.focus(); try { el.setSelectionRange(focus.s, focus.e); } catch { } } }
  const sc = document.querySelector('.scroll'); if (sc && scroll) sc.scrollTop = scroll;
}

const moon = `<svg class="logo" viewBox="0 0 64 64" aria-hidden="true"><defs><radialGradient id="mg" cx="40%" cy="35%"><stop offset="0" stop-color="#fff6d8"/><stop offset="1" stop-color="#d9b86a"/></radialGradient></defs><circle cx="32" cy="32" r="22" fill="url(#mg)"/><circle cx="42" cy="26" r="19" fill="var(--bg)"/><circle cx="18" cy="40" r="2" fill="#b8954a" opacity=".6"/></svg>`;

function renderHome() {
  const saved = LS.get('vl-host');
  const last = LS.get('vl-last');
  const canResume = saved && saved.phase !== 'end' && saved.players?.some((p) => p.token === me.token);
  return `<main class="home scroll">
    <header class="hero">${moon}<h1>Veillée</h1><p class="sub">Loups-Garous &amp; Blood on the Clocktower, chacun sur son téléphone.</p></header>
    <section class="card">
      <label class="lbl" for="name">Ton pseudo</label>
      <input id="name" class="inp" maxlength="20" placeholder="ex. Camille" value="${esc(me.name)}" data-in="name" autocomplete="nickname">
      <button class="btn primary big" data-act="create">🌙 Créer une partie</button>
      <div class="or"><span>ou rejoindre</span></div>
      <div class="row">
        <input id="code" class="inp code" maxlength="5" placeholder="CODE" value="${esc(ui.joinCode)}" data-in="code" autocomplete="off" autocapitalize="characters">
        <button class="btn" data-act="join">Rejoindre</button>
      </div>
      ${last && !canResume ? `<button class="btn ghost" data-act="rejoin">↻ Revenir dans la partie ${esc(last)}</button>` : ''}
      ${canResume ? `<button class="btn ghost" data-act="resume">↻ Reprendre ma partie ${esc(saved.code)} (hôte)</button>` : ''}
    </section>
    <nav class="tiles">
      <button class="tile" data-act="go" data-v="editor"><span>🛠️</span>Atelier<small>${myCustom().length} rôle(s) · ${myEvents().length} événement(s)</small></button>
      <button class="tile" data-act="go" data-v="lab"><span>🧪</span>Laboratoire<small>parties de test en local</small></button>
      <button class="tile wide" data-act="go" data-v="almanac"><span>📖</span>Almanach des rôles<small>${allRoles('lg').filter((r) => !r.custom).length + allRoles('botc').filter((r) => !r.custom).length} personnages</small></button>
    </nav>
    ${installHint()}
    <p class="foot">Tout se passe entre vos appareils : pas de compte, pas de serveur. Gardez l'écran de l'hôte allumé.<br>Version ${VERSION}</p>
  </main>`;
}

function installHint() {
  if (matchMedia('(display-mode: standalone)').matches) return '';
  if (ui.installEvt) return `<button class="btn ghost" data-act="install">📲 Installer l'application</button>`;
  if (/iphone|ipad/i.test(navigator.userAgent)) return `<p class="hint">📲 Pour l'installer : bouton Partager ⎋ puis « Sur l'écran d'accueil ».</p>`;
  return '';
}

// ----- salle (salon + partie) -----
function renderRoom() {
  const v = ui.view;
  if (!v) return `<main class="center"><div class="spinner"></div><p>${esc(ui.statusMsg || 'Connexion à la partie…')}</p><button class="btn ghost" data-act="leave">Annuler</button></main>`;
  return v.phase === 'lobby' ? renderLobby(v) : renderGame(v);
}

function statusDot() {
  const st = ui.status;
  const cls = st === 'open' ? 'ok' : st === 'error' ? 'bad' : 'wait';
  return `<span class="dot ${cls}" title="${esc(ui.statusMsg || st)}"></span>`;
}

function renderLobby(v) {
  const isHost = v.me?.isHost;
  const M = MODES[v.mode];
  const seated = v.players.filter((p) => !p.st);
  const link = `${location.origin}${location.pathname}?code=${v.code}`;
  const err = isHost ? host.E.canStart() : null;
  return `<main class="scroll lobby">
    <header class="bar">${statusDot()}<button class="icon" data-act="leave" title="Quitter">✕</button><div class="grow"></div><span class="muted">Salon</span></header>
    <section class="codebox"><div class="muted">Code de la partie</div><div class="bigcode">${esc(v.code)}</div>
      <button class="btn small" data-act="share" data-v="${esc(link)}">🔗 Inviter des amis</button></section>
    <section class="card">
      <h2>Joueurs <span class="pill">${seated.length}</span></h2>
      <ul class="plist">${v.players.map((p) => `<li class="${p.connected ? '' : 'off'}"><span class="av">${esc(p.name[0] || '?')}</span><span class="grow">${esc(p.name)}${p.id === v.hostId ? ' <em>hôte</em>' : ''}${p.id === v.me?.id ? ' <em>toi</em>' : ''}${isHost && p.ver && p.ver !== VERSION ? ' <span class="pill warnp" title="Doit recharger l’appli">⚠️ v' + esc(p.ver) + '</span>' : ''}</span>
        ${p.st ? '<span class="pill gold">🎙️ MJ</span>' : ''}
        ${isHost ? `<button class="chip ${p.st ? 'on' : ''}" data-act="lobby" data-k="st" data-v="${p.id}">MJ</button>${p.id !== v.hostId ? `<button class="icon small" data-act="lobby" data-k="kick" data-v="${p.id}">✕</button>` : ''}` : ''}</li>`).join('')}</ul>
      <p class="hint">${v.stId ? 'Un maître du jeu humain mène la partie : il voit tout et valide les informations.' : 'Pas de maître du jeu : l\'appli mène la partie, tout le monde joue (l\'hôte aussi).'}</p>
    </section>
    <section class="card">
      <h2>Jeu</h2>
      <div class="seg">${Object.values(MODES).map((m) => `<button class="${v.mode === m.id ? 'on' : ''}" ${isHost ? `data-act="lobby" data-k="mode" data-v="${m.id}"` : 'disabled'}>${m.id === 'lg' ? '🐺' : '🩸'} ${esc(m.name)}</button>`).join('')}</div>
      <h3>Extensions</h3>
      <div class="chips">${M.editions.map((e) => { const key = v.mode === 'lg' ? 'lgEditions' : 'editions'; const on = (v.options[key] || (v.mode === 'lg' ? ['base'] : ['tb'])).includes(e.id); return `<button class="chip ${on ? 'on' : ''}" ${isHost ? `data-act="lobby" data-k="ed" data-v="${e.id}"` : 'disabled'}>${esc(e.name)}</button>`; }).join('')}</div>
      ${customPicker(v, isHost)}
      ${eventPicker(v, isHost)}
      <h3>Composition</h3>
      <div class="seg small">
        <button class="${v.options.autoRoles ? 'on' : ''}" ${isHost ? 'data-act="lobby" data-k="auto" data-v="1"' : 'disabled'}>🎲 Automatique</button>
        <button class="${!v.options.autoRoles ? 'on' : ''}" ${isHost ? 'data-act="lobby" data-k="auto" data-v="0"' : 'disabled'}>✋ Manuelle</button>
      </div>
      ${v.options.autoRoles ? `<p class="hint">${v.mode === 'botc' ? autoBotcHint(seated.length) : 'Loups, voyante et rôles spéciaux tirés au hasard dans les extensions choisies.'}</p>` : manualPicker(v, isHost, seated.length)}
      <h3>Options</h3>
      ${opt(v, isHost, 'stValidates', 'Le MJ valide chaque information avant envoi', !v.stId)}
      ${v.mode === 'lg' ? opt(v, isHost, 'revealOnDeath', 'Révéler le rôle des morts') + opt(v, isHost, 'captain', 'Élire un Capitaine (voix double)') : ''}
      ${v.events.length ? opt(v, isHost, 'announceEvents', 'Annoncer en début de partie les événements tirés') : ''}
      ${opt(v, isHost, 'fakeActions', 'Actions factices la nuit (personne ne se trahit en touchant son écran)')}
      <label class="optl"><span>Durée indicative des débats</span><select ${isHost ? 'data-in="dayMinutes"' : 'disabled'} id="dayMinutes">${[0, 2, 3, 5, 8, 10, 15].map((m) => `<option value="${m}" ${+v.options.dayMinutes === m ? 'selected' : ''}>${m ? m + ' min' : 'Libre'}</option>`).join('')}</select></label>
    </section>
    <div class="dock">${isHost ? `${err ? `<p class="warn">${esc(err)}</p>` : ''}<button class="btn primary big" data-act="start" ${err ? 'disabled' : ''}>Lancer la partie</button>` : '<p class="muted center-t">En attente du lancement par l\'hôte…</p>'}</div>
  </main>`;
}

function autoBotcHint(n) {
  if (n < 5) return 'Il faut au moins 5 joueurs (hors MJ).';
  const D = { 5: [3, 0, 1, 1], 6: [3, 1, 1, 1], 7: [5, 0, 1, 1], 8: [5, 1, 1, 1], 9: [5, 2, 1, 1], 10: [7, 0, 2, 1], 11: [7, 1, 2, 1], 12: [7, 2, 2, 1], 13: [9, 0, 3, 1], 14: [9, 1, 3, 1], 15: [9, 2, 3, 1] }[Math.min(n, 15)];
  return `${n} joueurs : ${D[0]} Villageois, ${D[1]} Étranger(s), ${D[2]} Sbire(s), ${D[3]} Démon (ajusté par le Baron, etc.).`;
}

function opt(v, isHost, k, label, disabled) {
  return `<label class="optl ${disabled ? 'dim' : ''}"><span>${esc(label)}</span><input type="checkbox" ${v.options[k] ? 'checked' : ''} ${isHost && !disabled ? `data-act="lobby" data-k="opt" data-v="${k}"` : 'disabled'}></label>`;
}

function customPicker(v, isHost) {
  const inGame = v.custom.filter((d) => d.game === v.mode);
  const mine = isHost ? myCustom().filter((d) => d.game === v.mode) : [];
  if (!inGame.length && !mine.length) return isHost ? `<p class="hint">Astuce : crée tes propres rôles et événements dans l'Atelier, depuis l'accueil.</p>` : '';
  const ids = new Set(inGame.map((d) => d.id));
  const list = isHost ? mine : inGame;
  return `<h3>Rôles sur mesure</h3><div class="chips">${list.map((d) => `<button class="chip ${ids.has(d.id) ? 'on' : ''}" ${isHost ? `data-act="lobby" data-k="custom" data-v="${d.id}"` : `data-act="roleinfo" data-v="${d.id}"`}>${esc(d.icon)} ${esc(d.name)}</button>`).join('')}</div>`;
}

function eventPicker(v, isHost) {
  const inGame = v.events.filter((d) => d.game === 'both' || d.game === v.mode);
  const mine = isHost ? myEvents().filter((d) => d.game === 'both' || d.game === v.mode) : [];
  if (!inGame.length && !mine.length) return '';
  const ids = new Set(inGame.map((d) => d.id));
  const list = isHost ? mine : inGame;
  return `<h3>Événements</h3><div class="chips">${list.map((d) => `<button class="chip ${ids.has(d.id) ? 'on' : ''}" ${isHost ? `data-act="lobby" data-k="event" data-v="${d.id}"` : `data-act="evinfo" data-v="${d.id}"`}>${esc(d.icon)} ${esc(d.name)} <small>${d.chance} %</small></button>`).join('')}</div>
    <p class="hint">Chaque événement choisi a sa propre chance d'apparaître dans la partie.</p>`;
}

function manualPicker(v, isHost, n) {
  const eds = v.mode === 'lg' ? (v.options.lgEditions || ['base']) : (v.options.editions || ['tb']);
  const pool = allRoles(v.mode).filter((r) => eds.includes(r.ed) || (r.custom && v.custom.some((d) => d.id === r.id)));
  const count = (id) => v.roles.filter((x) => x === id).length;
  const groups = {};
  for (const r of pool) (groups[r.team] = groups[r.team] || []).push(r);
  const total = v.roles.length;
  const need = v.mode === 'lg' && v.roles.includes('voleur') ? n + 2 : n;
  return `<p class="hint">Sélection : <b class="${total === need ? 'okc' : 'warnc'}">${total} / ${need}</b>${v.mode === 'lg' ? ' — touche + / − pour les rôles multiples' : ''}</p>
    ${Object.entries(groups).map(([t, rs]) => `<h4>${esc(TEAM_LABEL[t] || t)}</h4><div class="rgrid">${rs.map((r) => {
    const c = count(r.id);
    return `<div class="rtile ${c ? 'on' : ''} t-${r.team}"><button class="rt-main" ${isHost ? `data-act="lobby" data-k="role+" data-v="${r.id}"` : ''}><span class="ri">${esc(r.icon)}</span><span class="rn">${esc(r.name)}</span>${c > 1 ? `<span class="rc">×${c}</span>` : ''}</button>
      <button class="rt-i" data-act="roleinfo" data-v="${r.id}">i</button>${isHost && c ? `<button class="rt-minus" data-act="lobby" data-k="role-" data-v="${r.id}">−</button>` : ''}</div>`;
  }).join('')}</div>`).join('')}`;
}

function lobbyEdit(k, val) {
  const E = host.E, s = E.s;
  if (s.phase !== 'lobby') return;
  const o = s.options;
  switch (k) {
    case 'mode': if (s.mode !== val) { s.mode = val; s.roles = []; } break;
    case 'ed': {
      const key = s.mode === 'lg' ? 'lgEditions' : 'editions';
      const cur = o[key] || (s.mode === 'lg' ? ['base'] : ['tb']);
      o[key] = cur.includes(val) ? cur.filter((x) => x !== val) : [...cur, val];
      if (!o[key].length) o[key] = [val];
      break;
    }
    case 'auto': o.autoRoles = val === '1'; break;
    case 'opt': o[val] = !o[val]; break;
    case 'st': s.stId = s.stId === val ? null : val; break;
    case 'kick': { const c = host.conns.get(val); if (c) { host.net.send(c, { t: 'kick' }); host.conns.delete(val); } s.players = s.players.filter((p) => p.id !== val); if (s.stId === val) s.stId = null; break; }
    case 'custom': {
      const d = myCustom().find((x) => x.id === val);
      if (s.custom.some((x) => x.id === val)) { s.custom = s.custom.filter((x) => x.id !== val); s.roles = s.roles.filter((x) => x !== val); }
      else if (d) s.custom.push(d);
      installCustom(s.custom);
      break;
    }
    case 'event': {
      const d = myEvents().find((x) => x.id === val);
      if (s.events.some((x) => x.id === val)) s.events = s.events.filter((x) => x.id !== val);
      else if (d) s.events.push(d);
      break;
    }
    case 'role+': {
      const r = getRole(val); if (!r) break;
      const c = s.roles.filter((x) => x === val).length;
      if (s.mode === 'botc' || !(r.multi || r.pack)) { if (c) s.roles = s.roles.filter((x) => x !== val); else s.roles.push(...Array(r.pack || 1).fill(val)); }
      else s.roles.push(val);
      break;
    }
    case 'role-': {
      const r = getRole(val);
      if (r && r.pack) s.roles = s.roles.filter((x) => x !== val);
      else { const i = s.roles.lastIndexOf(val); if (i >= 0) s.roles.splice(i, 1); }
      break;
    }
  }
  scheduleSync();
}

// ----- partie -----
function renderGame(v) {
  const meP = v.me;
  const end = v.phase === 'end';
  const ph = v.cursor?.phase;
  const notes = meP?.notes || [];
  const unread = Math.max(0, notes.length - ui.seenNotes);
  if (ui.tab === 'journal') ui.seenNotes = notes.length;
  const title = end ? '🏁 Fin de partie' : ph === 'night' ? `🌙 Nuit ${v.night}` : `☀️ Jour ${v.day}`;
  const tabs = [['game', 'Partie'], ['journal', `Journal${unread && ui.tab !== 'journal' ? ` <b class="badge">${unread}</b>` : ''}`], ['roles', 'Rôles']];
  if (v.grim && (meP?.isST || lab)) tabs.push(['grim', 'Grimoire']);
  else if (end) tabs.push(['grim', 'Révélations']);
  return `<main class="game">
    ${lab ? labBar(v) : ''}
    <header class="bar">${lab ? '<span class="pill gold">🧪 LABO</span>' : statusDot()}<span class="ptitle">${title}</span><div class="grow"></div><span class="muted mono">${esc(v.code)}</span><button class="icon" data-act="menu" title="Menu">⋯</button></header>
    ${meP && !meP.isST ? roleChip(v) : meP?.isST ? `<div class="stbanner">🎙️ Tu es le maître du jeu</div>` : ''}
    <nav class="tabs">${tabs.map(([id, l]) => `<button class="${ui.tab === id ? 'on' : ''}" data-act="tab" data-v="${id}">${l}</button>`).join('')}</nav>
    <div class="scroll body">${ui.tab === 'journal' ? renderJournal(notes) : ui.tab === 'roles' ? renderScript(v) : ui.tab === 'grim' ? renderGrim(v) : renderPlay(v)}</div>
  </main>`;
}

function roleChip(v) {
  const r = role(v.me.role);
  if (!r) return '';
  const al = v.me.align;
  if (!ui.showRole) return `<button class="rolechip hidden" data-act="toggleRole">👁️ Touche pour voir ton rôle</button>`;
  return `<button class="rolechip t-${r.team} a-${al}" data-act="toggleRole"><span class="ri">${esc(r.icon)}</span><span class="grow"><b>${esc(r.name)}</b><small>${esc(TEAM_LABEL[r.team] || '')} · camp ${esc(ALIGN_LABEL[al] || al)}${v.me.alive ? '' : ' · 💀 mort'}</small></span><span class="muted">masquer</span></button>
    ${v.me.tags.length ? `<div class="mytags">${v.me.tags.map((t) => `<span class="pill">${esc(t)}</span>`).join('')}</div>` : ''}
    <p class="roletext">${esc(r.text)}</p>`;
}

function phaseNotes(v) {
  const ph = v.cursor?.phase;
  return (v.me?.notes || []).filter((n) => n.title !== 'Ton personnage' && n.title !== 'Ton rôle' && (n.ph === ph && (ph === 'night' ? n.n === v.night : n.d === v.day)));
}

function renderPlay(v) {
  const end = v.phase === 'end';
  const ph = v.cursor?.phase;
  const ctl = v.me && (v.me.isST || (v.me.isHost && !v.stId));
  let out = '';
  if (end) out += `<section class="winner w-${esc(v.winner?.team)}"><div class="wi">${v.winner?.team === 'evil' ? '😈' : v.winner?.team === 'good' ? '🌅' : v.winner?.team === 'lovers' ? '💞' : '🏆'}</div><h2>${esc(v.winner?.text)}</h2>
    ${v.me?.isHost ? '<button class="btn primary" data-act="again">Rejouer avec les mêmes joueurs</button>' : '<p class="muted">L\'hôte peut relancer une partie.</p>'}</section>`;
  for (const pr of v.prompts) out += renderPrompt(pr, v);
  if (!end && !v.prompts.length) {
    if (ph === 'night') out += `<section class="sleep"><div class="zz">💤</div><p>${v.me?.isST ? 'La nuit se déroule. Les informations à valider apparaîtront ici.' : 'Ferme les yeux… Ton téléphone vibrera si tu dois agir.'}</p></section>`;
  }
  for (const n of phaseNotes(v).slice(-4).reverse()) out += `<section class="note new"><b>${esc(n.title)}</b><p>${esc(n.text)}</p></section>`;
  if (!end && ph === 'day' && v.dayState) out += renderDay(v, ctl);
  if (ctl && !end && v.pendingOld.filter((p) => p.type !== 'players' || true).length) {
    const old = v.pendingOld.filter((p) => Date.now() - p.t > 15000);
    if (old.length) out += `<section class="card warnbox"><p>⏳ ${old.length} réponse(s) en attente depuis un moment${v.me.isST ? ` : ${old.map((p) => esc(p.who)).join(', ')}` : ''}.</p><button class="btn small" data-act="forceAll">Répondre au hasard à leur place</button></section>`;
  }
  out += renderTown(v);
  out += `<section class="feed"><h3>Chronique</h3>${v.pub.slice().reverse().slice(0, 40).map((e) => `<p class="ev k-${e.kind}">${esc(e.text)}</p>`).join('')}</section>`;
  return out;
}

function renderDay(v, ctl) {
  const ds = v.dayState;
  let out = '<section class="card day">';
  if (v.options.dayMinutes > 0 && ds.started) {
    const left = Math.max(0, v.options.dayMinutes * 60 - Math.floor((Date.now() - ds.started) / 1000));
    out += `<div class="timer" data-until="${ds.started + v.options.dayMinutes * 60000}">⏱️ ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}</div>`;
  }
  if (v.mode === 'botc') {
    const pn = (id) => esc(v.players.find((p) => p.id === id)?.name || '?');
    out += `<p>Seuil d'exécution : <b>${ds.threshold}</b> voix. ${ds.block ? `Sur le billot : <b>🪓 ${pn(ds.block)}</b> (${ds.top} voix).` : 'Personne sur le billot.'}</p>`;
    if (ds.voting) out += `<p class="pulse">🗳️ Vote en cours : ${pn(ds.voting.by)} a nommé ${pn(ds.voting.target)} — ${ds.voting.done}/${ds.voting.total} ont voté.</p>`;
  } else {
    if (ds.voting) out += `<p class="pulse">🗳️ ${esc(ds.voting.title)} : ${ds.voting.done}/${ds.voting.total} ont voté.</p>`;
    else if (ds.stage === 'talk') out += `<p>Débattez ! ${ctl ? 'Lance le vote quand le village est prêt.' : 'Le vote sera lancé par ' + (v.stId ? 'le MJ' : 'l\'hôte') + '.'}</p>`;
  }
  for (const a of v.actions) {
    if (a.id === 'nominate') out += `<button class="btn" data-act="nominate">☝️ ${esc(a.label)}</button>`;
    else out += `<button class="btn ${a.ctl ? 'primary' : ''}" data-act="do" data-v="${esc(a.id)}" data-k="${a.k ?? ''}">${esc(a.label)}</button>`;
  }
  return out + '</section>';
}

function renderTown(v) {
  const ps = v.players.filter((p) => !p.st);
  const n = ps.length, size = n > 14 ? 50 : n > 10 ? 56 : 64;
  return `<section class="town" style="--tok:${size}px">${ps.map((p, i) => {
    const a = (-90 + (360 * i) / n) * (Math.PI / 180);
    const r = p.shown && role(p.shown);
    return `<button class="tok ${p.alive ? '' : 'dead'} ${p.connected ? '' : 'off'} ${p.id === v.me?.id ? 'me' : ''}" style="left:${50 + 41 * Math.cos(a)}%;top:${50 + 41 * Math.sin(a)}%" data-act="who" data-v="${p.id}">
      <span class="face">${r ? esc(r.icon) : esc(p.name[0] || '?')}</span><span class="nm">${esc(p.name)}</span>${p.tags.length ? `<span class="tg">${esc(p.tags.map((t) => t.split(' ')[0]).join(''))}</span>` : ''}</button>`;
  }).join('')}<div class="mid">${v.phase === 'end' ? '🏁' : v.cursor?.phase === 'night' ? '🌙' : '☀️'}<small>${ps.filter((p) => p.alive).length} vivants</small></div></section>`;
}

function renderPrompt(pr, v) {
  const sp = pr.spec;
  const sel = ui.sel[pr.id] || [];
  const pname = (id) => v.players.find((p) => p.id === id)?.name || '?';
  let body = '';
  switch (sp.type) {
    case 'players': {
      const min = sp.min ?? sp.n;
      body = `<div class="pgrid">${sp.options.map((id) => { const p = v.players.find((x) => x.id === id); return `<button class="pbtn ${sel.includes(id) ? 'on' : ''} ${p && !p.alive ? 'dead' : ''}" data-act="sel" data-p="${pr.id}" data-v="${id}" data-n="${sp.n}">${esc(pname(id))}</button>`; }).join('')}</div>
        <div class="row"><span class="muted">${sel.length}/${sp.n}${min < sp.n ? ` (min ${min})` : ''}</span><div class="grow"></div>
        ${min === 0 ? `<button class="btn ghost" data-act="answer" data-p="${pr.id}" data-v="none">Personne</button>` : ''}
        <button class="btn primary" data-act="answer" data-p="${pr.id}" ${sel.length >= Math.max(min, 1) && sel.length <= sp.n ? '' : 'disabled'}>Valider</button></div>`;
      break;
    }
    case 'choice': body = `<div class="col">${sp.options.map((o) => `<button class="btn" data-act="answerv" data-p="${pr.id}" data-v="${esc(o.v)}">${esc(o.l)}</button>`).join('')}</div>`; break;
    case 'role': body = `<div class="rgrid">${sp.options.map((id) => { const r = role(id); return `<div class="rtile ${sel[0] === id ? 'on' : ''} t-${r?.team}"><button class="rt-main" data-act="sel1" data-p="${pr.id}" data-v="${id}"><span class="ri">${esc(r?.icon)}</span><span class="rn">${esc(r?.name || id)}</span></button><button class="rt-i" data-act="roleinfo" data-v="${id}">i</button></div>`; }).join('')}</div>
      <button class="btn primary" data-act="answerv" data-p="${pr.id}" data-v="${esc(sel[0] || '')}" ${sel[0] ? '' : 'disabled'}>Valider</button>`; break;
    case 'yesno': body = `<div class="row2"><button class="btn primary" data-act="answerb" data-p="${pr.id}" data-v="1">Oui</button><button class="btn" data-act="answerb" data-p="${pr.id}" data-v="0">Non</button></div>`; break;
    case 'vote': body = `<div class="row2 vote"><button class="btn yes" data-act="answerb" data-p="${pr.id}" data-v="1">✋ OUI</button><button class="btn no" data-act="answerb" data-p="${pr.id}" data-v="0">✊ NON</button></div>`; break;
    case 'approve': body = `<textarea id="ap-${pr.id}" class="inp" rows="3">${esc(sp.text)}</textarea><button class="btn primary" data-act="approve" data-p="${pr.id}">Envoyer l'information</button>`; break;
    default: body = `<button class="btn primary" data-act="answerb" data-p="${pr.id}" data-v="1">OK</button>`;
  }
  const fresh = !ui.drawn.has(pr.id); ui.drawn.add(pr.id);
  return `<section class="prompt ${fresh ? 'fresh' : ''} ${sp.dummy ? 'dummy' : ''} ty-${sp.type}"><h3>${esc(sp.title || 'À toi')}</h3>${sp.text && sp.type !== 'approve' ? `<p>${esc(sp.text)}</p>` : ''}${body}</section>`;
}

function renderJournal(notes) {
  if (!notes.length) return '<p class="muted center-t">Tes informations secrètes s\'afficheront ici.</p>';
  return notes.slice().reverse().map((n) => `<section class="note"><div class="when">${n.ph === 'night' ? `🌙 Nuit ${n.n}` : n.ph === 'day' ? `☀️ Jour ${n.d}` : '🎴 Début'}</div><b>${esc(n.title)}</b><p>${esc(n.text)}</p></section>`).join('');
}

function renderScript(v) {
  let ids;
  if (v.mode === 'botc') {
    const eds = v.options.editions || ['tb'];
    ids = allRoles('botc').filter((r) => eds.includes(r.ed) || (r.custom && v.custom.some((d) => d.id === r.id))).map((r) => r.id);
    if (!v.options.autoRoles) ids = ids.filter((id) => v.roles.includes(id)).concat(v.roles.filter((id) => !ids.includes(id)));
  } else {
    const eds = v.options.lgEditions || ['base'];
    ids = v.options.autoRoles ? allRoles('lg').filter((r) => eds.includes(r.ed) || (r.custom && v.custom.some((d) => d.id === r.id))).map((r) => r.id) : [...new Set(v.roles)];
  }
  const groups = {};
  for (const id of ids) { const r = role(id); if (r) (groups[r.team] = groups[r.team] || []).push(r); }
  return `<p class="hint">${v.mode === 'botc' ? (v.options.autoRoles ? 'Personnages possibles dans ce script.' : 'Personnages choisis par l\'hôte.') : v.options.autoRoles ? 'Rôles possibles (composition tirée au hasard).' : 'Composition de la partie.'}</p>` +
    Object.entries(groups).map(([t, rs]) => `<h3>${esc(TEAM_LABEL[t] || t)}</h3>${rs.map((r) => `<div class="rline t-${r.team}"><span class="ri">${esc(r.icon)}</span><div><b>${esc(r.name)}</b>${!v.options.autoRoles && v.mode === 'lg' ? ` <small>×${v.roles.filter((x) => x === r.id).length}</small>` : ''}<p>${esc(r.text)}</p></div></div>`).join('')}`).join('');
}

function renderGrim(v) {
  const g = v.grim;
  if (!g) return '<p class="muted">Réservé au maître du jeu.</p>';
  const name = (id) => esc(v.players.find((p) => p.id === id)?.name || '?');
  const st = (v.me?.isST || lab) && v.phase !== 'end';
  const allIds = allRoles(v.mode).map((r) => r.id);
  return `${g.events?.length ? `<p class="hint">Événements tirés : ${g.events.map((e) => `${esc(e.name)} ${e.night ? `(nuit ${e.night})` : `(${e.every} % chaque nuit)`}`).join(', ')}</p>` : ''}${v.mode === 'botc' && g.bluffs?.length ? `<p class="hint">Bluffs du Démon : ${g.bluffs.map((b) => esc(roleName(b))).join(', ')}</p>` : ''}
    ${g.players.map((p) => {
    const r = role(p.role), f = p.f || {};
    const flags = [f.poison || f.permPoison || f.mjPoison ? '🧪' : '', f.drunk || f.permDrunk ? '🍺' : '', f.safe || f.safeN || f.shield ? '🛡️' : '', f.blockUntil ? '🚫' : '', f.lives ? '❤️'.repeat(f.lives) : '', f.charmed ? '🎵' : '', f.tags ? Object.keys(f.tags).map((t) => `🏷️${t}`).join(' ') : '', f.wolf && !r?.wolf ? '🐺' : '', f.used ? '✔️' : ''].join('');
    return `<div class="grow-line ${p.alive ? '' : 'dead'} a-${p.align}"><span class="ri">${esc(r?.icon)}</span><div class="grow"><b>${name(p.id)}</b> — ${esc(r?.name || p.role)}${p.seen && p.seen !== p.role ? ` <small>(croit : ${esc(roleName(p.seen))})</small>` : ''} <small>${esc(ALIGN_LABEL[p.align] || p.align)}</small> ${flags}</div>
      ${st ? `<button class="icon small" data-act="grim" data-v="${p.id}">⚙️</button>` : ''}</div>
      ${st && ui.grimOpen === p.id ? `<div class="grimtools">
        <button class="chip" data-act="st" data-t="${p.alive ? 'kill' : 'revive'}" data-v="${p.id}">${p.alive ? '💀 Tuer' : '✨ Ressusciter'}</button>
        <button class="chip" data-act="st" data-t="poison" data-v="${p.id}">🧪 Empoisonner (bascule)</button>
        <button class="chip" data-act="st" data-t="align" data-v="${p.id}">⚖️ Changer de camp</button>
        <button class="chip" data-act="st" data-t="ghost" data-v="${p.id}">👻 Vote fantôme</button>
        <select id="grole-${p.id}" class="inp">${allIds.map((id) => `<option value="${id}" ${id === p.role ? 'selected' : ''}>${esc(roleName(id))}</option>`).join('')}</select>
        <button class="chip" data-act="st" data-t="role" data-v="${p.id}">Changer de rôle</button>
        <div class="row"><input id="gmsg-${p.id}" class="inp" placeholder="Message privé…"><button class="btn small" data-act="st" data-t="msg" data-v="${p.id}">Envoyer</button></div>
      </div>` : ''}`;
  }).join('')}
    ${st ? `<section class="card"><div class="row"><input id="gpub" class="inp" placeholder="Annonce publique…"><button class="btn small" data-act="st" data-t="pub">Annoncer</button></div>
      <div class="row2"><button class="btn small" data-act="st" data-t="win" data-w="good">Victoire du Bien</button><button class="btn small" data-act="st" data-t="win" data-w="evil">Victoire du Mal</button></div></section>` : ''}
    <details class="log"><summary>Journal complet du conteur</summary>${g.log.slice().reverse().map((l) => `<p>${esc(l)}</p>`).join('')}</details>`;
}

// ----- atelier : rôles et événements sur mesure -----
const getP = (o, path) => path.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
function setP(o, path, v) { const ks = path.split('.'); const last = ks.pop(); const t = ks.reduce((x, k) => x[k], o); t[last] = v; }

const F = (label, inner, cls = '') => `<label class="fld ${cls}"><span>${label}</span>${inner}</label>`;
function IN(path, { num = false, ph = '', max = 60, min = 0, top = 99 } = {}) {
  const v = getP(ui.edit, path);
  return num ? `<input id="e-${path}" class="inp" type="number" inputmode="numeric" min="${min}" max="${top}" data-p="${path}" data-t="num" value="${esc(v ?? '')}">`
    : `<input id="e-${path}" class="inp" maxlength="${max}" data-p="${path}" data-t="str" placeholder="${esc(ph)}" value="${esc(v ?? '')}">`;
}
function SEL(path, opts, t = 'str') {
  const v = String(getP(ui.edit, path) ?? '');
  return `<select id="e-${path}" class="inp" data-p="${path}" data-t="${t}">${Object.entries(opts).map(([k, l]) => `<option value="${esc(k)}" ${v === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
}
const CHK = (path, label) => `<label class="optl"><span>${esc(label)}</span><input type="checkbox" data-p="${path}" data-t="bool" ${getP(ui.edit, path) ? 'checked' : ''}></label>`;
function roleOpts(game, extra = {}) {
  const list = [...allRoles(game).filter((r) => !r.custom), ...myCustom().filter((r) => r.game === game)];
  return { ...extra, ...Object.fromEntries(list.map((r) => [r.id, `${r.icon} ${r.name}`])) };
}

function condEd(path, game, prefix) {
  const c = getP(ui.edit, path);
  let val = '';
  if (c.k === 'hasRole') val = SEL(path + '.v', roleOpts(game, { '': '— rôle —' }));
  else if (c.k === 'hasTag') val = IN(path + '.v', { ph: 'étiquette', max: 30 });
  else if (c.k === 'chance') val = IN(path + '.v', { num: true, top: 100 });
  return `<div class="cond"><span class="muted">${prefix}</span>${SEL(path + '.k', RU.CONDS)}${c.k !== 'always' ? `<label class="neg"><input type="checkbox" data-p="${path}.neg" data-t="bool" ${c.neg ? 'checked' : ''}> inverser</label>` : ''}${val}</div>`;
}

function targetEd(path, game, actorless) {
  const t = getP(ui.edit, path);
  const modes = actorless ? Object.fromEntries(Object.entries(RU.TARGETS).filter(([k]) => ['none', 'random', 'all', 'tagged', 'camp', 'role', 'victim'].includes(k))) : RU.TARGETS;
  let more = '';
  if (t.mode === 'choose' || t.mode === 'random') more += `<div class="row">${F('Combien', IN(path + '.n', { num: true, min: 1, top: 6 }))}${t.mode === 'choose' ? F('Minimum', SEL(path + '.min', { '': 'autant', 0: '0 (facultatif)', 1: '1', 2: '2' }, 'numOrNull')) : ''}</div>`;
  if (t.mode === 'choose') more += CHK(path + '.self', 'Peut se choisir lui-même') + CHK(path + '.notLast', 'Jamais deux fois de suite la même cible') + F('Morts', SEL(path + '.dead', { no: 'Vivants seulement', yes: 'Vivants et morts', only: 'Morts seulement' }));
  if (t.mode === 'random') more += CHK(path + '.self', 'Peut tomber sur lui-même');
  if (t.mode === 'tagged') more += F('Étiquette', IN(path + '.v', { ph: 'ex. maudit', max: 30 }));
  if (t.mode === 'camp') more += F('Camp', SEL(path + '.v', RU.CAMPS));
  if (t.mode === 'role') more += F('Rôle', SEL(path + '.v', roleOpts(game, { '': '— rôle —' })));
  return `${F('Cible', SEL(path + '.mode', modes))}${more}${t.mode !== 'none' ? condEd(path + '.filter', game, 'Seulement si la cible') : ''}`;
}

function effectEd(path, i, game) {
  const e = getP(ui.edit, path);
  const meta = RU.EFFECTS[e.type];
  let val = '';
  if (meta.v === 'text') val = F('Texte ({acteur}, {cible}, {role})', IN(path + '.v', { max: 300, ph: 'ex. {cible} sent une présence…' }));
  else if (meta.v === 'num') val = F('Nombre', IN(path + '.v', { num: true, top: 9 }));
  else if (meta.v === 'tag') val = `<div class="row">${F('Étiquette', IN(path + '.v', { ph: 'ex. maudit', max: 30 }))}${e.type === 'tag' ? F('Visible par', SEL(path + '.vis', { secret: 'Personne', self: 'Le joueur marqué', public: 'Tout le monde' })) : ''}</div>`;
  else if (meta.v === 'camp') val = F('Nouveau camp', SEL(path + '.v', RU.CAMPS));
  else if (meta.v === 'role') val = F('Nouveau rôle', SEL(path + '.v', roleOpts(game, { '@chosen': '↪ le rôle choisi par l\'acteur' })));
  else if (meta.v === 'winWho') val = F('Qui gagne', SEL(path + '.v', { solo: 'L\'acteur, seul', camp: 'Le camp de l\'acteur', good: 'Le Bien / le village', evil: 'Le Mal / les loups' }));
  else if (meta.v === 'withRoles') val = F('Détail', SEL(path + '.v', { '': 'Les noms seulement', withRoles: 'Les noms et les rôles' }));
  const list = path.slice(0, path.lastIndexOf('.'));
  return `<div class="eff"><div class="row"><b class="grow">Effet ${i + 1}</b>
      <button class="icon small" data-act="edMove" data-p="${list}" data-i="${i}" title="Monter">↑</button><button class="icon small" data-act="edDel" data-p="${list}" data-i="${i}" title="Supprimer">✕</button></div>
    ${SEL(path + '.type', Object.fromEntries(Object.entries(RU.EFFECTS).map(([k, x]) => [k, x.l])))}
    ${meta.k === 't' ? F('S\'applique à', SEL(path + '.on', { target: 'La cible', actor: 'L\'acteur (ex. il meurt s\'il se trompe)' })) : ''}
    ${val}${meta.k !== 'g' ? condEd(path + '.if', game, 'Si la cible') : ''}</div>`;
}

function abilityEd(i, game) {
  const p = `abilities.${i}`, ab = ui.edit.abilities[i];
  const lg = game === 'lg';
  const orderHint = lg ? 'Cupidon 2 · Salvateur 10 · Voyante 12 · Loups 20 · Sorcière 30 · Flûtiste 35' : 'Empoisonneur 8 · Moine 13 · Démon 24 · Empathique 56 · Espion 68';
  let when = '';
  if (ab.trigger === 'night') when = `<div class="row">${F('Quelles nuits', SEL(p + '.sched', RU.SCHEDULES))}${['from', 'only'].includes(ab.sched) ? F('N', IN(p + '.n', { num: true, min: 1 })) : ''}</div>${F(`Ordre de réveil <small>${orderHint}</small>`, IN(p + '.order', { num: true }))}`;
  if (ab.trigger === 'day') when = F('Texte du bouton', IN(p + '.label', { ph: 'ex. Lancer la malédiction', max: 40 })) + CHK(p + '.perDay', 'Une seule fois par jour');
  if (ab.trigger === 'death' || ab.trigger === 'otherDeath') when = F('Cause de la mort', SEL(p + '.cause', RU.CAUSES));
  return `<section class="card abil"><div class="row"><h3 class="grow">Capacité ${i + 1}</h3><button class="icon small" data-act="edDel" data-p="abilities" data-i="${i}" title="Supprimer">✕</button></div>
    ${F('Déclencheur', SEL(p + '.trigger', RU.TRIGGERS))}${when}
    <details class="more"><summary>Conditions et limites</summary>
      ${ab.trigger !== 'death' ? F('Le joueur doit être', SEL(p + '.state', RU.STATES)) : ''}
      <div class="row">${F('Utilisations', SEL(p + '.uses', { 0: 'Illimitées', 1: '1 fois', 2: '2 fois', 3: '3 fois', 5: '5 fois' }, 'num'))}${F('Repos (nuits)', SEL(p + '.cooldown', { 0: 'Aucun', 1: '1 nuit sur 2', 2: '1 nuit sur 3' }, 'num'))}</div>
      <div class="row">${F('Chance de se déclencher (%)', IN(p + '.chance', { num: true, top: 100 }))}${F('À partir de la nuit', IN(p + '.minNight', { num: true }))}</div>
      ${CHK(p + '.optional', 'Le joueur peut choisir de ne pas l\'utiliser')}${CHK(p + '.needDeath', 'Seulement si quelqu\'un est mort aujourd\'hui')}
    </details>
    ${targetEd(p + '.target', game, false)}
    ${F('Choisir aussi un rôle', SEL(p + '.askRole', { '': 'Non', any: 'Oui, n\'importe lequel', good: 'Oui, un rôle gentil', evil: 'Oui, un rôle méchant', absent: 'Oui, un rôle absent du jeu' }))}
    <h4>Effets (dans l'ordre)</h4>
    ${ab.effects.map((e, j) => effectEd(`${p}.effects.${j}`, j, game)).join('')}
    <button class="btn small ghost" data-act="edAdd" data-p="${p}.effects" data-kind="effect">+ Effet</button>
  </section>`;
}

function renderRoleEditor(list) {
  const d = ui.edit, lg = d.game === 'lg';
  const exists = list.some((x) => x.id === d.id);
  let err = null; try { RU.normalizeRole({ ...d, name: d.name || 'x' }); } catch (e) { err = e.message; }
  const tpls = RU.ROLE_TEMPLATES.filter((t) => t.game === d.game);
  return `<main class="scroll">
    <header class="bar"><button class="icon" data-act="edCancel">←</button><span class="ptitle">${exists ? 'Modifier' : 'Nouveau'} rôle · ${lg ? 'Loup-Garou' : 'BotC'}</span></header>
    ${!exists && tpls.length ? `<div class="chips"><span class="muted">Partir d'un modèle :</span>${tpls.map((t) => `<button class="chip" data-act="tpl" data-v="${esc(t.name)}">${esc(t.icon)} ${esc(t.name)}</button>`).join('')}</div>` : ''}
    <section class="card">
      <div class="row">${F('Icône', `<input id="e-icon" class="inp icon-inp" data-p="icon" data-t="str" maxlength="4" value="${esc(d.icon)}">`, 'nogrow')}${F('Nom', IN('name', { ph: 'ex. Garde-chasse', max: 40 }))}</div>
      <div class="emojis">${['✨', '🦉', '🗝️', '🕯️', '🧙', '🐍', '🦇', '🪓', '🧿', '🌹', '⚗️', '🎻', '🐈‍⬛', '🧛', '🪦', '🧭', '🔥', '🌙', '👁️', '🃏'].map((e) => `<button data-act="emoji" data-v="${e}">${e}</button>`).join('')}</div>
      ${F('Camp', SEL('team', TEAMS[d.game]))}
      ${F('Description pour le joueur <small>(vide = résumé automatique)</small>', `<textarea id="e-text" class="inp" data-p="text" data-t="str" rows="2" maxlength="600">${esc(d.text)}</textarea>`)}
      <div class="desc"><b>Résumé :</b> <span id="ed-desc">${esc(RU.describeRole(d))}</span></div>
    </section>
    <section class="card"><h3>Particularités</h3>
      ${CHK('passives.nightImmune', 'Ne peut pas mourir la nuit')}${CHK('passives.voteImmune', 'Survit une fois à l\'élimination par le vote (et se dévoile)')}
      <div class="row">${F('Vies en plus', SEL('passives.lives', { 0: '0', 1: '1', 2: '2', 3: '3' }, 'num'))}${F('Poids de sa voix', SEL('passives.voteWeight', { 0: '0 (ne compte pas)', 1: '1', 2: '2', 3: '3' }, 'num'))}</div>
      ${CHK('passives.noVote', 'Ne peut jamais voter')}
      ${lg ? CHK('passives.joinWolves', 'Se réveille avec les loups (compte comme loup)') + CHK('passives.multi', 'Peut être pris plusieurs fois') + CHK('passives.hideOnDeath', 'Son rôle reste caché à sa mort') : ''}
      ${F('Aux yeux des enquêteurs', SEL('passives.appears', { '': 'Son vrai camp', good: lg ? 'Pas un loup' : 'Bon', evil: lg ? 'Un loup' : 'Mauvais' }))}
    </section>
    ${d.abilities.map((_, i) => abilityEd(i, d.game)).join('')}
    <button class="btn ghost" data-act="edAdd" data-p="abilities" data-kind="ability">+ Ajouter une capacité</button>
    <section class="card"><h3>Victoire</h3>
      ${F('Condition', SEL('win.mode', RU.WINS))}
      ${['allTagged', 'taggedDead'].includes(d.win.mode) ? F('Étiquette', IN('win.v', { ph: 'ex. ensorcelé', max: 30 })) : d.win.mode === 'surviveNight' ? F('Nuit', IN('win.v', { num: true })) : ''}
    </section>
    ${err && d.name ? `<p class="warn">${esc(err)}</p>` : ''}
    <div class="dock"><div class="row2"><button class="btn primary" data-act="edSave" ${d.name.trim() ? '' : 'disabled'}>Enregistrer</button><button class="btn" data-act="edTest" ${d.name.trim() ? '' : 'disabled'}>🧪 Tester</button></div>
      ${exists ? '<button class="btn danger small" data-act="edDelete">Supprimer ce rôle</button>' : ''}</div>
  </main>`;
}

function renderEventEditor(list) {
  const d = ui.edit;
  const exists = list.some((x) => x.id === d.id);
  const game = d.game === 'botc' ? 'botc' : 'lg';
  return `<main class="scroll">
    <header class="bar"><button class="icon" data-act="edCancel">←</button><span class="ptitle">${exists ? 'Modifier' : 'Nouvel'} événement</span></header>
    ${!exists ? `<div class="chips"><span class="muted">Partir d'un modèle :</span>${RU.EVENT_TEMPLATES.map((t) => `<button class="chip" data-act="tpl" data-v="${esc(t.name)}">${esc(t.icon)} ${esc(t.name)}</button>`).join('')}</div>` : ''}
    <section class="card">
      <div class="row">${F('Icône', `<input id="e-icon" class="inp icon-inp" data-p="icon" data-t="str" maxlength="4" value="${esc(d.icon)}">`, 'nogrow')}${F('Nom', IN('name', { ph: 'ex. Éclipse', max: 40 }))}</div>
      <div class="emojis">${['🌩️', '🌕', '🌑', '🦠', '🔥', '❄️', '🕊️', '⚖️', '📢', '🎪', '🌪️', '💫'].map((e) => `<button data-act="emoji" data-v="${e}">${e}</button>`).join('')}</div>
      ${F('Jeu', SEL('game', { both: 'Les deux', lg: 'Loups-Garous', botc: 'Clocktower' }))}
      ${F('Texte annoncé', `<textarea id="e-text" class="inp" data-p="text" data-t="str" rows="2" maxlength="400" placeholder="ex. La lune disparaît : aucun pouvoir ne fonctionne cette nuit.">${esc(d.text)}</textarea>`)}
      ${CHK('announce', 'Annoncer l\'événement à tous quand il se produit')}
      <div class="desc"><b>Résumé :</b> <span id="ed-desc">${esc(RU.describeEvent(d))}</span></div>
    </section>
    <section class="card"><h3>Apparition</h3>
      ${F(`Chance d'être dans une partie : <b>${d.chance} %</b>`, `<input type="range" min="0" max="100" step="5" data-p="chance" data-t="num" value="${d.chance}">`)}
      ${F('Moment', SEL('when', { dawn: '🌅 Au matin (après les morts de la nuit)', dusk: '🌙 Au crépuscule (avant les actions de nuit)' }))}
      ${F('Quand', SEL('timing', RU.EV_TIMINGS))}
      ${d.timing === 'fixed' ? F('Nuit', IN('n', { num: true, min: 1 })) : d.timing === 'range' ? `<div class="row">${F('De la nuit', IN('a', { num: true, min: 1 }))}${F('à la nuit', IN('b', { num: true, min: 1 }))}</div>` : F('Probabilité chaque nuit (%)', IN('every', { num: true, top: 100 }))}
    </section>
    <section class="card"><h3>Effets</h3>
      ${targetEd('target', game, true)}
      ${d.effects.map((e, j) => effectEd(`effects.${j}`, j, game)).join('')}
      <button class="btn small ghost" data-act="edAdd" data-p="effects" data-kind="effect">+ Effet</button>
    </section>
    <div class="dock"><div class="row2"><button class="btn primary" data-act="edSave" ${d.name.trim() ? '' : 'disabled'}>Enregistrer</button><button class="btn" data-act="edTest" ${d.name.trim() ? '' : 'disabled'}>🧪 Tester</button></div>
      ${exists ? '<button class="btn danger small" data-act="edDelete">Supprimer cet événement</button>' : ''}</div>
  </main>`;
}

function renderEditor() {
  const roles = myCustom(), events = myEvents();
  if (ui.edit) return ui.editKind === 'event' ? renderEventEditor(events) : renderRoleEditor(roles);
  const tab = ui.libTab;
  const items = tab === 'event' ? events : roles;
  return `<main class="scroll">
    <header class="bar"><button class="icon" data-act="go" data-v="home">←</button><span class="ptitle">Atelier</span></header>
    <div class="seg"><button class="${tab === 'role' ? 'on' : ''}" data-act="libTab" data-v="role">🎭 Rôles (${roles.length})</button><button class="${tab === 'event' ? 'on' : ''}" data-act="libTab" data-v="event">🌩️ Événements (${events.length})</button></div>
    <section class="card">
      ${tab === 'role' ? '<div class="row2"><button class="btn primary" data-act="edNew" data-v="lg">+ Rôle Loup-Garou</button><button class="btn primary" data-act="edNew" data-v="botc">+ Personnage BotC</button></div>' : '<button class="btn primary" data-act="edNew" data-v="event">+ Nouvel événement</button>'}
      <div class="row"><input id="impcode" class="inp" placeholder="Coller un code VEIL1:… reçu d'un ami"><button class="btn small" data-act="import">Importer</button></div>
    </section>
    ${items.length ? items.map((r) => `<div class="rline t-${r.team || 'event'}"><span class="ri">${esc(r.icon)}</span><div class="grow"><b>${esc(r.name)}</b> <small>${tab === 'event' ? `${r.chance} % · ${r.game === 'both' ? 'les deux jeux' : r.game === 'lg' ? 'Loups-Garous' : 'Clocktower'}` : `${r.game === 'lg' ? 'Loup-Garou' : 'BotC'} · ${esc(TEAMS[r.game][r.team])}`}</small>
        <p>${esc(tab === 'event' ? RU.describeEvent(r) : r.text || RU.describeRole(r))}</p></div>
      <div class="col"><button class="btn small" data-act="edOpen" data-v="${r.id}">Modifier</button><button class="btn small ghost" data-act="edCopy" data-v="${r.id}">Dupliquer</button><button class="btn small ghost" data-act="edShare" data-v="${r.id}">Partager</button></div></div>`).join('')
    : `<p class="muted center-t">${tab === 'event' ? 'Aucun événement. Un événement a une chance d\'apparaître dans la partie et frappe une nuit donnée : épidémie, trêve, pleine lune…' : 'Aucun rôle. Un rôle combine des particularités et des capacités : déclencheur, cibles, effets, conditions.'}<br>Active-les ensuite dans le salon de ta partie.</p>`}
  </main>`;
}

function libSave(kind, d) {
  const k = kind === 'event' ? 'vl-events' : 'vl-custom';
  const list = (kind === 'event' ? myEvents() : myCustom()).filter((x) => x.id !== d.id);
  list.push(d); LS.set(k, list);
  if (host && host.E.s.phase === 'lobby') {
    const s = host.E.s, arr = kind === 'event' ? s.events : s.custom;
    const i = arr.findIndex((x) => x.id === d.id);
    if (i >= 0) { arr[i] = d; installCustom(s.custom); scheduleSync(); }
  }
}

// ----- laboratoire -----
function labCfg() {
  if (!ui.labCfg) ui.labCfg = { mode: 'lg', n: 7, seats: [], editions: ['tb', 'bmr', 'snv'], lgEditions: ['base', 'nl', 'perso'], useCustom: true, events: [], force100: true, count: 100 };
  return ui.labCfg;
}

function renderLabSetup() {
  const c = labCfg();
  const opts = roleOpts(c.mode, { '': '🎲 Au hasard' });
  const evs = myEvents().filter((e) => e.game === 'both' || e.game === c.mode);
  const M = MODES[c.mode], key = c.mode === 'lg' ? 'lgEditions' : 'editions';
  const r = ui.labBatch;
  return `<main class="scroll">
    <header class="bar"><button class="icon" data-act="go" data-v="home">←</button><span class="ptitle">🧪 Laboratoire</span></header>
    <p class="hint">Des parties artificielles sur cet appareil : tu choisis les rôles siège par siège, tu joues n'importe quel joueur, les autres sont des bots. Rien n'est envoyé à personne.</p>
    <section class="card">
      <div class="seg">${Object.values(MODES).map((m) => `<button class="${c.mode === m.id ? 'on' : ''}" data-act="labSet" data-k="mode" data-v="${m.id}">${m.id === 'lg' ? '🐺' : '🩸'} ${esc(m.name)}</button>`).join('')}</div>
      <div class="chips">${M.editions.map((e) => `<button class="chip ${c[key].includes(e.id) ? 'on' : ''}" data-act="labSet" data-k="ed" data-v="${e.id}">${esc(e.name)}</button>`).join('')}</div>
      <label class="optl"><span>Nombre de joueurs</span><select data-lab="n" class="inp narrow">${Array.from({ length: 18 }, (_, i) => i + 3).map((n) => `<option ${n === c.n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <label class="optl"><span>Mes rôles sur mesure dans le tirage au hasard</span><input type="checkbox" data-lab="useCustom" ${c.useCustom ? 'checked' : ''}></label>
    </section>
    <section class="card"><h3>Sièges</h3><p class="hint">Laisse « au hasard » pour un tirage normal. Si tu imposes certains rôles, les sièges libres reçoivent des rôles simples.</p>
      ${Array.from({ length: c.n }, (_, i) => `<div class="seat"><span class="av">${i + 1}</span><select data-lab="seat" data-i="${i}" class="inp">${Object.entries(opts).map(([k, l]) => `<option value="${esc(k)}" ${(c.seats[i] || '') === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`).join('')}
      <button class="btn small ghost" data-act="labSet" data-k="clearSeats">Tout remettre au hasard</button>
    </section>
    ${evs.length ? `<section class="card"><h3>Événements</h3><div class="chips">${evs.map((e) => `<button class="chip ${c.events.includes(e.id) ? 'on' : ''}" data-act="labSet" data-k="event" data-v="${e.id}">${esc(e.icon)} ${esc(e.name)} <small>${e.chance} %</small></button>`).join('')}</div>
      <label class="optl"><span>Forcer leur apparition (100 %)</span><input type="checkbox" data-lab="force100" ${c.force100 ? 'checked' : ''}></label></section>` : ''}
    <div class="row2"><button class="btn primary big" data-act="labStart">▶️ Jouer la partie</button>
      <button class="btn big" data-act="labBatch">📊 Simuler <select data-lab="count" class="inline">${[20, 100, 300].map((n) => `<option ${n === c.count ? 'selected' : ''}>${n}</option>`).join('')}</select></button></div>
    ${r ? renderBatch(r) : ''}
  </main>`;
}

function renderBatch(r) {
  const ok = r.games - r.errors.length;
  const TEAM = { good: 'Bien / Village', evil: 'Mal / Loups', solo: 'Solitaire', lovers: 'Amoureux', none: 'Personne', interminable: 'Interminable (>60 nuits)' };
  return `<section class="card"><h3>Résultats — ${r.games}${r.running ? ` / ${r.total}` : ''} parties</h3>
    ${Object.entries(r.wins).sort((a, b) => b[1] - a[1]).map(([t, n]) => `<div class="bar-l"><span>${esc(TEAM[t] || t)}</span><div class="bar-t"><i style="width:${(100 * n) / Math.max(1, ok)}%"></i></div><b>${Math.round((100 * n) / Math.max(1, ok))} %</b></div>`).join('')}
    <p class="hint">Durée moyenne : ${(r.avgNights || r.nights / Math.max(1, ok)).toFixed(1)} nuit(s). Les bots jouent au hasard : c'est un test de solidité, pas d'équilibre fin.</p>
    ${r.errors.length ? `<p class="warn">${r.errors.length} partie(s) en erreur :</p>${r.errors.slice(0, 4).map((e) => `<pre class="err">${esc(String(e.error).slice(0, 400))}</pre>`).join('')}` : '<p class="okc">Aucune erreur.</p>'}
  </section>`;
}

function labConfig() {
  const c = labCfg();
  const custom = c.useCustom || c.seats.some((x) => x && x.startsWith('c_')) ? myCustom().filter((r) => r.game === c.mode) : [];
  const events = myEvents().filter((e) => c.events.includes(e.id)).map((e) => (c.force100 ? { ...e, chance: 100 } : e));
  let roles = null;
  const seats = c.seats.slice(0, c.n);
  if (seats.some(Boolean)) {
    installCustom(custom);
    const pool = allRoles(c.mode).filter((r) => !r.custom && (c.mode === 'lg' ? r.id === 'villageois' : r.team === 'townsfolk')).map((r) => r.id);
    roles = Array.from({ length: c.n }, (_, i) => seats[i] || (c.mode === 'lg' ? 'villageois' : pool.filter((id) => !seats.includes(id))[i % pool.length] || 'washerwoman'));
    if (c.mode === 'lg' && !roles.some((id) => getRole(id)?.wolf)) roles[roles.lastIndexOf('villageois') >= 0 ? roles.lastIndexOf('villageois') : c.n - 1] = 'loup_garou';
    if (c.mode === 'botc' && !roles.some((id) => getRole(id)?.team === 'demon')) roles[roles.findIndex((x, i) => !seats[i]) >= 0 ? roles.findIndex((x, i) => !seats[i]) : c.n - 1] = 'imp';
  }
  return { mode: c.mode, n: c.n, custom, events, roles, editions: c.editions, lgEditions: c.lgEditions, names: Array.from({ length: c.n }, (_, i) => `Joueur ${i + 1}`) };
}

function labStart() {
  labStop();
  const cfg = labConfig();
  let E;
  try { E = buildGame(cfg); } catch (e) { return toast('Impossible : ' + e.message, 5000); }
  const err = E.canStart();
  if (err) return toast(err, 4000);
  lab = { E, viewAs: 'p0', bots: true, play: true, dayAuto: false, delay: 700, omni: true, cfg };
  E.hooks.changed = labSync;
  ui.tab = 'game'; ui.showRole = true; ui.seenNotes = 0;
  E.start().catch((x) => { console.error(x); toast('Erreur du moteur : ' + x.message, 8000); });
  lab.timer = setInterval(labTick, 250);
  labSync();
}

function labStop() { if (lab && lab.timer) clearInterval(lab.timer); lab = null; ui.view = null; }

let labT = null;
function labSync() { if (!labT) labT = setTimeout(() => { labT = null; if (!lab) return; const E = lab.E; const v = E.view(lab.viewAs); v.grim = E.grimoire(); if (lab.omni) for (const p of v.players) p.shown = E.p(p.id)?.role; v.me.isHost = true; v.actions = E.mode.actionsFor(E, E.p(lab.viewAs), true); setView(v); }, 30); }

function labTick() {
  if (!lab) return;
  const E = lab.E, s = E.s;
  if (s.phase !== 'game') return;
  const now = Date.now();
  if (lab.bots) for (const pr of Object.values(s.prompts)) if ((pr.pid !== lab.viewAs || !lab.play) && now - pr.t > lab.delay) E.answer(pr.pid, pr.id, E.randomAnswer(pr), true);
  if (lab.dayAuto && (!lab.lastDay || now - lab.lastDay > 1500)) { lab.lastDay = now; try { dayDriver(E, 0.5); } catch (e) { console.error(e); } }
}

function labSend(kind, p) {
  const E = lab.E, me_ = E.p(lab.viewAs);
  if (kind === 'answer') { const pr = E.s.prompts[p.id]; if (pr) E.answer(pr.pid, p.id, p.v, true); return; }
  if (p.type === 'st') return E.stTool(p);
  if (p.type === 'abort') { labStop(); render(); return; }
  if (p.type === 'forceAll') { for (const pr of Object.values(E.s.prompts)) E.answer(pr.pid, pr.id, E.randomAnswer(pr), true); return; }
  if (p.type === 'endDay' || p.type === 'startVote') return E.mode.action(E, me_, p, true);
  return E.action(lab.viewAs, p);
}

function labBar(v) {
  const E = lab.E;
  return `<div class="labbar">
    <select data-lab="viewAs" class="inp">${E.seated().map((p) => `<option value="${p.id}" ${p.id === lab.viewAs ? 'selected' : ''}>👤 ${esc(p.name)} — ${esc(roleName(p.role))}${p.alive ? '' : ' †'}</option>`).join('')}</select>
    <div class="chips">
      <button class="chip ${lab.play ? 'on' : ''}" data-act="labToggle" data-v="play" title="Désactivé : les bots jouent aussi ton siège">🎮 Je joue</button>
      <button class="chip ${lab.bots ? 'on' : ''}" data-act="labToggle" data-v="bots">🤖 Bots</button>
      <button class="chip ${lab.dayAuto ? 'on' : ''}" data-act="labToggle" data-v="dayAuto">☀️ Jours auto</button>
      <button class="chip ${lab.omni ? 'on' : ''}" data-act="labToggle" data-v="omni">👁️ Tout voir</button>
      <button class="chip" data-act="labAdvance">⏩ Avancer</button>
      <button class="chip" data-act="forceAll">🎲 Tout répondre</button>
      <button class="chip" data-act="labStart">🔁 Rejouer</button>
      <button class="chip" data-act="labQuit">✖ Quitter</button>
    </div></div>`;
}

function updateBanner() {
  if (ui.verWarn) return `<div class="upd warn">⚠️ L'hôte utilise la version ${esc(ui.verWarn)}, toi la ${VERSION}. Rechargez tous les deux l'appli. <button data-act="reload">Recharger</button></div>`;
  if (ui.update) return `<div class="upd">🆕 Version ${esc(ui.update)} disponible. <button data-act="reload">Mettre à jour</button></div>`;
  return '';
}

async function checkUpdate() {
  try {
    const txt = await (await fetch('js/version.js?t=' + Date.now(), { cache: 'no-store' })).text();
    const m = txt.match(/VERSION = '([^']+)'/);
    if (m && m[1] !== VERSION && ui.update !== m[1]) { ui.update = m[1]; render(); }
  } catch { }
}

// ----- almanach -----
function renderAlmanac() {
  const a = ui.alm;
  const q = a.q.trim().toLowerCase();
  const rs = allRoles(a.game).filter((r) => !q || (r.name + ' ' + r.text).toLowerCase().includes(q));
  const byEd = {};
  for (const r of rs) (byEd[r.ed] = byEd[r.ed] || []).push(r);
  return `<main class="scroll">
    <header class="bar"><button class="icon" data-act="go" data-v="home">←</button><span class="ptitle">Almanach</span></header>
    <div class="seg"><button class="${a.game === 'lg' ? 'on' : ''}" data-act="alm" data-v="lg">🐺 Loups-Garous</button><button class="${a.game === 'botc' ? 'on' : ''}" data-act="alm" data-v="botc">🩸 Clocktower</button></div>
    <input id="almq" class="inp" placeholder="Rechercher…" value="${esc(a.q)}" data-in="almq">
    ${Object.entries(byEd).map(([ed, list]) => `<h3>${esc(ED_LABEL[ed] || ed)}</h3>${list.map((r) => `<div class="rline t-${r.team}"><span class="ri">${esc(r.icon)}</span><div><b>${esc(r.name)}</b> <small>${esc(TEAM_LABEL[r.team] || r.team)}</small><p>${esc(r.text)}</p></div></div>`).join('')}`).join('')}
  </main>`;
}

// ----- fenêtres -----
function renderModal() {
  const m = ui.modal;
  if (!m) return '';
  const v = ui.view;
  let inner = '';
  if (m.type === 'role') {
    const r = role(m.id);
    inner = r ? `<div class="bigicon">${esc(r.icon)}</div><h2>${esc(r.name)}</h2><p class="muted">${esc(TEAM_LABEL[r.team] || r.team)} · ${esc(ED_LABEL[r.ed] || '')}</p><p>${esc(r.text)}</p>` : '';
  } else if (m.type === 'nominate') {
    const a = v.actions.find((x) => x.id === 'nominate');
    inner = `<h2>Qui nommes-tu ?</h2><div class="pgrid">${(a?.pick || []).map((id) => `<button class="pbtn" data-act="nom" data-v="${id}">${esc(v.players.find((p) => p.id === id)?.name)}</button>`).join('')}</div>`;
  } else if (m.type === 'menu') {
    inner = `<h2>Menu</h2><div class="col">
      <button class="btn" data-act="share" data-v="${esc(`${location.origin}${location.pathname}?code=${v?.code}`)}">🔗 Lien d'invitation</button>
      ${v?.me?.isHost && v.phase === 'game' ? '<button class="btn danger" data-act="abort">Arrêter la partie</button>' : ''}
      <button class="btn ghost" data-act="leave">Quitter</button></div>`;
  } else if (m.type === 'who') {
    const p = v.players.find((x) => x.id === m.id);
    const r = p?.shown && role(p.shown);
    inner = `<h2>${esc(p?.name)}</h2><p>${p?.alive ? 'En vie' : '💀 Mort'}${p?.connected ? '' : ' · déconnecté'}</p>${r ? `<p>${esc(r.icon)} ${esc(r.name)}</p>` : ''}${p?.tags.length ? `<p>${p.tags.map((t) => `<span class="pill">${esc(t)}</span>`).join(' ')}</p>` : ''}`;
  } else if (m.type === 'event') {
    const ev = (v?.events || []).find((x) => x.id === m.id);
    inner = ev ? `<div class="bigicon">${esc(ev.icon)}</div><h2>${esc(ev.name)}</h2><p>${esc(ev.text)}</p><p class="hint">${esc(RU.describeEvent(ev))}</p>` : '';
  } else if (m.type === 'share') {
    inner = `<h2>Partager</h2><p class="hint">Envoie ce code à tes amis : ils le collent dans l'Atelier (bouton Importer).</p><textarea id="sharecode" class="inp" rows="4" readonly>${esc(m.code)}</textarea><button class="btn primary" data-act="copy" data-v="${esc(m.code)}">Copier</button>`;
  }
  return `<div class="modal" data-act="closemodal"><div class="sheet" data-stop="1">${inner}<button class="btn ghost" data-act="closemodal">Fermer</button></div></div>`;
}

// ---------- événements ----------
function castVal(t, el) {
  if (t === 'bool') return el.checked;
  if (t === 'num') return +el.value || 0;
  if (t === 'numOrNull') return el.value === '' ? null : +el.value;
  return el.value;
}
function refreshDesc() {
  const box = document.getElementById('ed-desc');
  if (box && ui.edit) try { box.textContent = ui.editKind === 'event' ? RU.describeEvent(ui.edit) : RU.describeRole(ui.edit); } catch { }
}

$app.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.in === 'name') { me.name = t.value.trim().slice(0, 20); LS.set('vl-name', me.name); }
  else if (t.dataset.in === 'code') { t.value = cleanCode(t.value); ui.joinCode = t.value; }
  else if (t.dataset.in === 'almq') { ui.alm.q = t.value; render(); }
  else if (t.dataset.p && ui.edit && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && t.type !== 'checkbox'))) {
    setP(ui.edit, t.dataset.p, castVal(t.dataset.t, t));
    if (t.type === 'range') { const lbl = t.closest('.fld')?.querySelector('b'); if (lbl) lbl.textContent = t.value + ' %'; }
    refreshDesc();
  }
});
$app.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.in === 'dayMinutes' && host) { host.E.s.options.dayMinutes = +t.value; scheduleSync(); }
  if (t.dataset.p && ui.edit && (t.tagName === 'SELECT' || t.type === 'checkbox')) { setP(ui.edit, t.dataset.p, castVal(t.dataset.t, t)); render(); }
  if (t.dataset.lab) {
    const c = labCfg(), k = t.dataset.lab;
    if (k === 'viewAs' && lab) { lab.viewAs = t.value; ui.sel = {}; ui.seenNotes = 0; labSync(); return; }
    if (k === 'seat') c.seats[+t.dataset.i] = t.value;
    else if (k === 'n') c.n = +t.value;
    else if (k === 'count') c.count = +t.value;
    else c[k] = t.type === 'checkbox' ? t.checked : t.value;
    render();
  }
});
$app.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'code') act('join');
});

$app.addEventListener('click', (e) => {
  if (e.target.tagName === 'SELECT' && e.target.closest('[data-act]')?.dataset.act === 'labBatch') return;
  const el = e.target.closest('[data-act]');
  if (!el) return;
  if (el.dataset.act === 'closemodal' && e.target.closest('[data-stop]') && el.classList.contains('modal')) return;
  if (el.disabled) return;
  act(el.dataset.act, el);
});

function act(a, el = { dataset: {} }) {
  const d = el.dataset || {};
  switch (a) {
    case 'create': if (!me.name) return toast('Choisis d\'abord un pseudo.'); LS.del('vl-host'); hostGame(null); break;
    case 'resume': hostGame(LS.get('vl-host')); break;
    case 'join': joinGame(ui.joinCode); break;
    case 'rejoin': joinGame(LS.get('vl-last')); break;
    case 'go': if (d.v !== 'lab') labStop(); ui.screen = d.v; ui.edit = null; render(); break;
    case 'install': ui.installEvt?.prompt(); ui.installEvt = null; render(); break;
    case 'reload':
      if (host && host.E.s.phase === 'game' && !confirm('Recharger maintenant ? La partie sera mise en pause puis reprise automatiquement.')) return;
      (navigator.serviceWorker?.getRegistration() || Promise.resolve()).then((r) => r && r.update()).catch(() => { }).finally(() => location.reload());
      break;
    case 'leave': ui.modal = null; if (lab) { labStop(); ui.screen = 'lab'; render(); return; } if (host && host.E.s.phase === 'game' && !confirm('Quitter ? Tu es l\'hôte : la partie sera mise en pause (tu pourras la reprendre depuis l\'accueil).')) return; leave(); break;
    case 'share': {
      const url = d.v;
      if (navigator.share) navigator.share({ title: 'Veillée', text: `Rejoins ma partie ! Code : ${ui.view?.code}`, url }).catch(() => { });
      else copy(url);
      break;
    }
    case 'copy': copy(d.v); break;
    case 'lobby': lobbyEdit(d.k, d.v); break;
    case 'start': {
      const E = host.E, err = E.canStart();
      if (err) return toast(err);
      E.start().catch((x) => { console.error(x); toast('Erreur du moteur : ' + x.message, 6000); });
      break;
    }
    case 'again': {
      if (lab) { labStart(); break; }
      const s = host.E.s;
      Object.assign(s, { phase: 'lobby', winner: null, prompts: {}, pub: [], log: [], dayState: null, cursor: null, nightQ: null, day: 0, night: 0, g: {}, nd: {} });
      s.players = s.players.filter((p) => p.connected);
      s.players.forEach((p, i) => { p.seat = i; p.role = null; p.seen = null; p.alive = true; p.notes = []; p.f = {}; });
      host.E = new Engine(s, { changed: scheduleSync });
      scheduleSync();
      break;
    }
    case 'abort': ui.modal = null; if (confirm('Arrêter la partie pour tout le monde ?')) send('act', { type: 'abort' }); break;
    case 'tab': ui.tab = d.v; render(); break;
    case 'toggleRole': ui.showRole = !ui.showRole; render(); break;
    case 'menu': ui.modal = { type: 'menu' }; render(); break;
    case 'who': ui.modal = { type: 'who', id: d.v }; render(); break;
    case 'roleinfo': ui.modal = { type: 'role', id: d.v }; render(); break;
    case 'evinfo': ui.modal = { type: 'event', id: d.v }; render(); break;
    case 'closemodal': ui.modal = null; render(); break;
    case 'sel': {
      const cur = ui.sel[d.p] || [], n = +d.n;
      ui.sel[d.p] = cur.includes(d.v) ? cur.filter((x) => x !== d.v) : n === 1 ? [d.v] : cur.length < n ? [...cur, d.v] : cur;
      render(); break;
    }
    case 'sel1': ui.sel[d.p] = [d.v]; render(); break;
    case 'answer': send('answer', { id: d.p, v: d.v === 'none' ? [] : ui.sel[d.p] || [] }); delete ui.sel[d.p]; break;
    case 'answerv': if (d.v) send('answer', { id: d.p, v: d.v }); break;
    case 'answerb': send('answer', { id: d.p, v: d.v === '1' }); break;
    case 'approve': send('answer', { id: d.p, v: document.getElementById('ap-' + d.p)?.value || '' }); break;
    case 'nominate': ui.modal = { type: 'nominate' }; render(); break;
    case 'nom': ui.modal = null; send('act', { type: 'nominate', target: d.v }); render(); break;
    case 'do': send('act', d.k != null && d.k !== '' ? { type: d.v, k: +d.k } : { type: d.v }); break;
    case 'forceAll': send('act', { type: 'forceAll' }); break;
    case 'grim': ui.grimOpen = ui.grimOpen === d.v ? null : d.v; render(); break;
    case 'st': {
      const x = { type: 'st', tool: d.t, target: d.v };
      if (d.t === 'role') x.role = document.getElementById('grole-' + d.v)?.value;
      if (d.t === 'msg') { x.text = document.getElementById('gmsg-' + d.v)?.value; if (!x.text) return; }
      if (d.t === 'pub') { x.text = document.getElementById('gpub')?.value; if (!x.text) return; }
      if (d.t === 'win') { if (!confirm('Terminer la partie ?')) return; x.team = d.w; }
      if (d.t === 'kill' && !lab && !confirm('Tuer ce joueur ?')) return;
      send('act', x); break;
    }
    case 'alm': ui.alm.game = d.v; render(); break;

    // --- atelier ---
    case 'libTab': ui.libTab = d.v; render(); break;
    case 'edNew': ui.editKind = d.v === 'event' ? 'event' : 'role'; ui.edit = d.v === 'event' ? RU.blankEvent('both') : RU.blankRole(d.v); render(); break;
    case 'edOpen': case 'edCopy': {
      const src = (ui.libTab === 'event' ? myEvents() : myCustom()).find((r) => r.id === d.v);
      if (!src) return;
      ui.editKind = ui.libTab;
      ui.edit = JSON.parse(JSON.stringify(src));
      if (a === 'edCopy') { ui.edit.id = (ui.libTab === 'event' ? 'e_' : 'c_') + Math.random().toString(36).slice(2, 8); ui.edit.name += ' (copie)'; }
      render(); break;
    }
    case 'edCancel': ui.edit = null; render(); break;
    case 'emoji': ui.edit.icon = d.v; render(); break;
    case 'tpl': {
      const kind = ui.editKind;
      const t = (kind === 'event' ? RU.EVENT_TEMPLATES : RU.ROLE_TEMPLATES).find((x) => x.name === d.v);
      if (!t) return;
      const base = kind === 'event' ? RU.blankEvent(t.game) : RU.blankRole(t.game);
      ui.edit = JSON.parse(JSON.stringify({ ...base, ...t, id: ui.edit.id }));
      if (kind === 'event') { ui.edit.target = { ...base.target, ...t.target }; }
      render(); break;
    }
    case 'edAdd': {
      const arr = getP(ui.edit, d.p);
      if (arr.length >= (d.kind === 'ability' ? 8 : 12)) return toast('C\'est le maximum.');
      arr.push(d.kind === 'ability' ? RU.blankAbility('night') : RU.blankEffect());
      render(); break;
    }
    case 'edDel': { const arr = getP(ui.edit, d.p); arr.splice(+d.i, 1); render(); break; }
    case 'edMove': { const arr = getP(ui.edit, d.p), i = +d.i; if (i > 0) [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; render(); break; }
    case 'edSave': case 'edTest': {
      let norm;
      try { norm = ui.editKind === 'event' ? RU.normalizeEvent(ui.edit) : RU.normalizeRole(ui.edit); } catch (x) { return toast('Incomplet : ' + x.message); }
      libSave(ui.editKind, norm);
      if (a === 'edSave') { ui.edit = null; toast('Enregistré.'); break; }
      const c = labCfg();
      if (ui.editKind === 'event') { c.events = [...new Set([...c.events, norm.id])]; c.force100 = true; if (norm.game !== 'both') c.mode = norm.game; }
      else { c.mode = norm.game; c.seats = [norm.id]; }
      ui.edit = null; ui.screen = 'lab'; ui.labBatch = null;
      toast(ui.editKind === 'event' ? 'Événement ajouté au labo, forcé à 100 %.' : 'Ton rôle est au siège 1 : lance la partie.');
      break;
    }
    case 'edDelete': {
      if (!confirm('Supprimer définitivement ?')) return;
      const k = ui.editKind === 'event' ? 'vl-events' : 'vl-custom';
      LS.set(k, (ui.editKind === 'event' ? myEvents() : myCustom()).filter((x) => x.id !== ui.edit.id));
      ui.edit = null; render(); break;
    }
    case 'edShare': {
      const src = (ui.libTab === 'event' ? myEvents() : myCustom()).find((r) => r.id === d.v);
      if (src) { ui.modal = { type: 'share', code: exportCode(src) }; render(); }
      break;
    }
    case 'import': {
      try {
        const r = importCode(document.getElementById('impcode').value);
        const kind = r.kind === 'event' ? 'event' : 'role';
        libSave(kind, r);
        ui.libTab = kind;
        toast(`« ${r.name} » ajouté à ton atelier.`);
      } catch (x) { toast('Code invalide.'); }
      break;
    }

    // --- laboratoire ---
    case 'labSet': {
      const c = labCfg();
      if (d.k === 'mode') { if (c.mode !== d.v) { c.mode = d.v; c.seats = []; c.events = []; } }
      else if (d.k === 'ed') { const key = c.mode === 'lg' ? 'lgEditions' : 'editions'; c[key] = c[key].includes(d.v) ? c[key].filter((x) => x !== d.v) : [...c[key], d.v]; if (!c[key].length) c[key] = [d.v]; }
      else if (d.k === 'event') c.events = c.events.includes(d.v) ? c.events.filter((x) => x !== d.v) : [...c.events, d.v];
      else if (d.k === 'clearSeats') c.seats = [];
      ui.labBatch = null; render(); break;
    }
    case 'labStart': labStart(); break;
    case 'labQuit': labStop(); ui.screen = 'lab'; document.body.dataset.phase = 'home'; render(); break;
    case 'labToggle': lab[d.v] = !lab[d.v]; labSync(); break;
    case 'labAdvance': {
      const E = lab.E, ds = E.s.dayState;
      if (E.s.cursor?.phase !== 'day' || !ds) { act('forceAll'); return; }
      if (E.s.mode === 'botc') { if (!ds.voting) E.mode.action(E, E.p(lab.viewAs), { type: 'endDay' }, true); }
      else if (ds.stage === 'talk') E.mode.action(E, E.p(lab.viewAs), { type: 'startVote' }, true);
      else act('forceAll');
      break;
    }
    case 'labBatch': {
      if (ui.labBatch?.running) return;
      const c = labCfg(), cfg = labConfig();
      ui.labBatch = { running: true, total: c.count, games: 0, wins: {}, errors: [], nights: 0 };
      render();
      batch(cfg, c.count, (i, res) => { ui.labBatch = { ...res, running: i < c.count, total: c.count }; if (i % 5 === 0 || i === c.count) render(); })
        .then((res) => { ui.labBatch = { ...res, running: false, total: c.count }; render(); });
      break;
    }
  }
}

function copy(text) {
  (navigator.clipboard?.writeText(text) || Promise.reject()).then(() => toast('Copié !')).catch(() => prompt('Copie ce texte :', text));
}

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); ui.installEvt = e; if (ui.screen === 'home') render(); });
setInterval(() => { const t = document.querySelector('.timer'); if (t) { const left = Math.max(0, Math.floor((+t.dataset.until - Date.now()) / 1000)); t.textContent = `⏱️ ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`; t.classList.toggle('over', left === 0); } }, 1000);
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => { });

document.body.dataset.phase = 'home';
render();
if (ui.joinCode && me.name) joinGame(ui.joinCode);
checkUpdate();
setInterval(checkUpdate, 5 * 60 * 1000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkUpdate(); });
