// Interface : accueil, salon, partie, éditeur de rôles, almanach.
import { Engine, newState, mkPlayer } from './engine.js';
import { MODES } from './modes.js';
import { getRole, roleName, allRoles, installCustom } from './roles/index.js';
import { blankCustom, compileCustom, ACTS, TEAMS, exportCode, importCode } from './roles/custom.js';
import { HostNet, ClientNet, makeCode, cleanCode } from './net.js';
import { uid } from './util.js';

// ---------- stockage local ----------
// ?profil=x isole un profil de test (plusieurs joueurs dans un même navigateur).
const PROFILE = (new URLSearchParams(location.search).get('profil') || '').replace(/W/g, '');
const key = (k) => (PROFILE ? `${k}@${PROFILE}` : k);
const LS = {
  get(k, d) { try { const v = localStorage.getItem(key(k)); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(key(k), JSON.stringify(v)); } catch { } },
  del(k) { try { localStorage.removeItem(key(k)); } catch { } },
};
const me = { token: LS.get('vl-token') || (() => { const t = uid() + uid(); LS.set('vl-token', t); return t; })(), name: LS.get('vl-name', '') };
const myCustom = () => LS.get('vl-custom', []);

const ui = {
  screen: 'home', tab: 'game', view: null, status: 'idle', statusMsg: '', sel: {}, modal: null,
  edit: null, alm: { game: 'lg', q: '' }, showRole: false, toast: null, seenNotes: 0, promptIds: new Set(),
  joinCode: new URLSearchParams(location.search).get('code') || '', installEvt: null, stMsg: {}, drawn: new Set(),
};
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
    const old = host.conns.get(p.id);
    if (old && old !== conn) try { old.close(); } catch { }
    conn._pid = p.id; host.conns.set(p.id, conn); p.connected = true;
    host.net.send(conn, { t: 'welcome', pid: p.id });
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
    hello: () => ({ t: 'hello', name: me.name, token: me.token }),
    onStatus: setStatus,
    onMsg: (m) => {
      if (m.t === 'view') setView(m.v);
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
  if (ui.screen !== 'room') ui.screen = 'room';
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
    default: html = renderHome();
  }
  $app.innerHTML = html + renderModal() + (ui.toast ? `<div class="toast">${esc(ui.toast)}</div>` : '');
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
      <button class="tile" data-act="go" data-v="editor"><span>🛠️</span>Mes rôles sur mesure<small>${myCustom().length} rôle(s)</small></button>
      <button class="tile" data-act="go" data-v="almanac"><span>📖</span>Almanach des rôles<small>${allRoles('lg').filter((r) => !r.custom).length + allRoles('botc').filter((r) => !r.custom).length} personnages</small></button>
    </nav>
    ${installHint()}
    <p class="foot">Tout se passe entre vos appareils : pas de compte, pas de serveur. Gardez l'écran de l'hôte allumé.</p>
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
      <ul class="plist">${v.players.map((p) => `<li class="${p.connected ? '' : 'off'}"><span class="av">${esc(p.name[0] || '?')}</span><span class="grow">${esc(p.name)}${p.id === v.hostId ? ' <em>hôte</em>' : ''}${p.id === v.me?.id ? ' <em>toi</em>' : ''}</span>
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
      <h3>Composition</h3>
      <div class="seg small">
        <button class="${v.options.autoRoles ? 'on' : ''}" ${isHost ? 'data-act="lobby" data-k="auto" data-v="1"' : 'disabled'}>🎲 Automatique</button>
        <button class="${!v.options.autoRoles ? 'on' : ''}" ${isHost ? 'data-act="lobby" data-k="auto" data-v="0"' : 'disabled'}>✋ Manuelle</button>
      </div>
      ${v.options.autoRoles ? `<p class="hint">${v.mode === 'botc' ? autoBotcHint(seated.length) : 'Loups, voyante et rôles spéciaux tirés au hasard dans les extensions choisies.'}</p>` : manualPicker(v, isHost, seated.length)}
      <h3>Options</h3>
      ${opt(v, isHost, 'stValidates', 'Le MJ valide chaque information avant envoi', !v.stId)}
      ${v.mode === 'lg' ? opt(v, isHost, 'revealOnDeath', 'Révéler le rôle des morts') + opt(v, isHost, 'captain', 'Élire un Capitaine (voix double)') : ''}
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
  if (!inGame.length && !mine.length) return isHost ? `<p class="hint">Astuce : crée tes propres rôles dans « Mes rôles sur mesure » depuis l'accueil.</p>` : '';
  const ids = new Set(inGame.map((d) => d.id));
  const list = isHost ? mine : inGame;
  return `<h3>Rôles sur mesure</h3><div class="chips">${list.map((d) => `<button class="chip ${ids.has(d.id) ? 'on' : ''}" ${isHost ? `data-act="lobby" data-k="custom" data-v="${d.id}"` : `data-act="roleinfo" data-v="${d.id}"`}>${esc(d.icon)} ${esc(d.name)}</button>`).join('')}</div>`;
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
  if (v.grim && meP?.isST) tabs.push(['grim', 'Grimoire']);
  if (end) tabs.push(['grim', 'Révélations']);
  return `<main class="game">
    <header class="bar">${statusDot()}<span class="ptitle">${title}</span><div class="grow"></div><span class="muted mono">${esc(v.code)}</span><button class="icon" data-act="menu" title="Menu">⋯</button></header>
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
    else out += `<button class="btn ${a.ctl ? 'primary' : ''}" data-act="do" data-v="${esc(a.id)}">${esc(a.label)}</button>`;
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
  const st = v.me?.isST && v.phase !== 'end';
  const allIds = allRoles(v.mode).map((r) => r.id);
  return `${v.mode === 'botc' && g.bluffs?.length ? `<p class="hint">Bluffs du Démon : ${g.bluffs.map((b) => esc(roleName(b))).join(', ')}</p>` : ''}
    ${g.players.map((p) => {
    const r = role(p.role), f = p.f || {};
    const flags = [f.poison || f.permPoison || f.mjPoison ? '🧪' : '', f.drunk || f.permDrunk ? '🍺' : '', f.safe || f.safeN ? '🛡️' : '', f.charmed ? '🎵' : '', f.wolf && !r?.wolf ? '🐺' : '', f.used ? '✔️' : ''].join('');
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

// ----- éditeur de rôles -----
function renderEditor() {
  const list = myCustom();
  const d = ui.edit;
  if (!d) {
    return `<main class="scroll">
      <header class="bar"><button class="icon" data-act="go" data-v="home">←</button><span class="ptitle">Mes rôles sur mesure</span></header>
      <section class="card"><button class="btn primary" data-act="newrole" data-v="lg">+ Rôle Loup-Garou</button><button class="btn primary" data-act="newrole" data-v="botc">+ Personnage BotC</button>
      <div class="row"><input id="impcode" class="inp" placeholder="Coller un code VEIL1:…"><button class="btn small" data-act="import">Importer</button></div></section>
      ${list.length ? list.map((r) => `<div class="rline t-${r.team}"><span class="ri">${esc(r.icon)}</span><div class="grow"><b>${esc(r.name)}</b> <small>${r.game === 'lg' ? 'Loup-Garou' : 'BotC'} · ${esc(TEAMS[r.game][r.team])}</small><p>${esc(r.text || ACTS[r.act])}</p></div>
        <div class="col"><button class="btn small" data-act="editrole" data-v="${r.id}">Modifier</button><button class="btn small ghost" data-act="exportrole" data-v="${r.id}">Partager</button></div></div>`).join('') : '<p class="muted center-t">Aucun rôle pour l\'instant. Crée-en un, puis active-le dans le salon de ta partie.</p>'}
    </main>`;
  }
  const f = (k, label, inner) => `<label class="fld"><span>${label}</span>${inner}</label>`;
  const inp = (k, ph = '', max = 40) => `<input id="ed-${k}" class="inp" data-ed="${k}" maxlength="${max}" placeholder="${esc(ph)}" value="${esc(d[k])}">`;
  const sel = (k, opts) => `<select id="ed-${k}" class="inp" data-ed="${k}">${Object.entries(opts).map(([v, l]) => `<option value="${v}" ${String(d[k]) === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const chk = (k, l) => `<label class="optl"><span>${esc(l)}</span><input type="checkbox" data-edc="${k}" ${d[k] ? 'checked' : ''}></label>`;
  const lg = d.game === 'lg';
  const orderHint = lg ? 'Ordre de réveil : Cupidon 2 · Salvateur 10 · Voyante 12 · Loups 20 · Sorcière 30' : 'Ordre de réveil : Empoisonneur 8 · Moine 13 · Démon 24 · Empathique 56';
  let err = null; try { compileCustom({ ...d, name: d.name || 'x' }); } catch (e) { err = e.message; }
  return `<main class="scroll">
    <header class="bar"><button class="icon" data-act="cancelrole">←</button><span class="ptitle">${list.some((x) => x.id === d.id) ? 'Modifier' : 'Nouveau'} rôle · ${lg ? 'Loup-Garou' : 'BotC'}</span></header>
    <section class="card">
      <div class="row">${f('icon', 'Icône', `<input id="ed-icon" class="inp icon-inp" data-ed="icon" maxlength="4" value="${esc(d.icon)}">`)}${f('name', 'Nom', inp('name', 'ex. Garde-chasse'))}</div>
      <div class="emojis">${['✨', '🦉', '🗝️', '🕯️', '🧙', '🐍', '🦇', '🪓', '🧿', '🌹', '⚗️', '🎻', '🐈‍⬛', '🧛', '🪦', '🧭'].map((e) => `<button data-act="emoji" data-v="${e}">${e}</button>`).join('')}</div>
      ${f('team', 'Camp', sel('team', TEAMS[d.game]))}
      ${f('text', 'Description (affichée au joueur)', `<textarea id="ed-text" class="inp" data-ed="text" rows="3" maxlength="400" placeholder="Explique le pouvoir en une ou deux phrases.">${esc(d.text)}</textarea>`)}
      <h3>Pouvoir de nuit</h3>
      ${f('act', 'Action', sel('act', lg ? Object.fromEntries(Object.entries(ACTS).filter(([k]) => k !== 'poison')) : ACTS))}
      ${f('when', 'Quand', sel('when', { none: 'Jamais', first: 'Première nuit seulement', each: 'Chaque nuit', others: 'Chaque nuit sauf la première' }))}
      ${f('order', `Ordre (1-80) <small>${orderHint}</small>`, `<input id="ed-order" class="inp" type="number" min="1" max="80" data-ed="order" value="${esc(d.order)}">`)}
      <div class="row">${f('targets', 'Cibles', sel('targets', { 1: '1 joueur', 2: '2 joueurs', 3: '3 joueurs' }))}${f('uses', 'Utilisations', sel('uses', { 0: 'Illimitées', 1: '1 fois', 2: '2 fois', 3: '3 fois' }))}</div>
      ${chk('self', 'Peut se cibler soi-même')}${chk('optional', 'Peut choisir de ne rien faire')}
      <h3>Particularités</h3>
      ${chk('nightImmune', lg ? 'Ne peut pas mourir la nuit' : '(LG uniquement) —')}
      ${lg ? chk('extraLife', 'Survit à sa première mort') + chk('deathShot', 'Tire sur un joueur en mourant (comme le Chasseur)') + chk('joinWolves', 'Se réveille avec les loups') + chk('multi', 'Peut être pris plusieurs fois') : ''}
      ${f('appears', 'Apparaît aux enquêteurs comme', sel('appears', { '': 'Son vrai camp', good: lg ? 'Pas un loup' : 'Bon', evil: lg ? 'Un loup' : 'Mauvais' }))}
      ${err && d.name ? `<p class="warn">${esc(err)}</p>` : ''}
      <div class="row2"><button class="btn primary" data-act="saverole" ${d.name.trim() ? '' : 'disabled'}>Enregistrer</button>${list.some((x) => x.id === d.id) ? '<button class="btn danger" data-act="delrole">Supprimer</button>' : ''}</div>
    </section></main>`;
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
  } else if (m.type === 'share') {
    inner = `<h2>Partager ce rôle</h2><p class="hint">Envoie ce code à tes amis : ils le collent dans « Mes rôles sur mesure ».</p><textarea id="sharecode" class="inp" rows="4" readonly>${esc(m.code)}</textarea><button class="btn primary" data-act="copy" data-v="${esc(m.code)}">Copier</button>`;
  }
  return `<div class="modal" data-act="closemodal"><div class="sheet" data-stop="1">${inner}<button class="btn ghost" data-act="closemodal">Fermer</button></div></div>`;
}

// ---------- événements ----------
$app.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.in === 'name') { me.name = t.value.trim().slice(0, 20); LS.set('vl-name', me.name); }
  else if (t.dataset.in === 'code') { t.value = cleanCode(t.value); ui.joinCode = t.value; }
  else if (t.dataset.in === 'almq') { ui.alm.q = t.value; render(); }
  else if (t.dataset.ed && ui.edit) {
    const k = t.dataset.ed;
    ui.edit[k] = ['order', 'targets', 'uses'].includes(k) ? +t.value : t.value;
    if (t.tagName === 'SELECT') render();
  }
});
$app.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.in === 'dayMinutes' && host) { host.E.s.options.dayMinutes = +t.value; scheduleSync(); }
  if (t.dataset.edc && ui.edit) { ui.edit[t.dataset.edc] = t.checked; render(); }
  if (t.dataset.ed && ui.edit && t.tagName === 'SELECT') { const k = t.dataset.ed; ui.edit[k] = ['targets', 'uses'].includes(k) ? +t.value : t.value; render(); }
});
$app.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'code') act('join');
});

$app.addEventListener('click', (e) => {
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
    case 'go': ui.screen = d.v; ui.edit = null; render(); break;
    case 'install': ui.installEvt?.prompt(); ui.installEvt = null; render(); break;
    case 'leave': ui.modal = null; if (host && host.E.s.phase === 'game' && !confirm('Quitter ? Tu es l\'hôte : la partie sera mise en pause (tu pourras la reprendre depuis l\'accueil).')) return; leave(); break;
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
    case 'do': send('act', { type: d.v }); break;
    case 'forceAll': send('act', { type: 'forceAll' }); break;
    case 'grim': ui.grimOpen = ui.grimOpen === d.v ? null : d.v; render(); break;
    case 'st': {
      const x = { type: 'st', tool: d.t, target: d.v };
      if (d.t === 'role') x.role = document.getElementById('grole-' + d.v)?.value;
      if (d.t === 'msg') { x.text = document.getElementById('gmsg-' + d.v)?.value; if (!x.text) return; }
      if (d.t === 'pub') { x.text = document.getElementById('gpub')?.value; if (!x.text) return; }
      if (d.t === 'win') { if (!confirm('Terminer la partie ?')) return; x.team = d.w; }
      if (d.t === 'kill' && !confirm('Tuer ce joueur ?')) return;
      send('act', x); break;
    }
    case 'alm': ui.alm.game = d.v; render(); break;
    case 'newrole': ui.edit = blankCustom(d.v); render(); break;
    case 'editrole': ui.edit = { ...myCustom().find((r) => r.id === d.v) }; render(); break;
    case 'cancelrole': ui.edit = null; render(); break;
    case 'emoji': ui.edit.icon = d.v; render(); break;
    case 'saverole': {
      const r = { ...ui.edit, name: ui.edit.name.trim() };
      try { compileCustom(r); } catch (x) { return toast('Rôle incomplet : ' + x.message); }
      const list = myCustom().filter((x) => x.id !== r.id); list.push(r); LS.set('vl-custom', list);
      if (host && host.E.s.phase === 'lobby') { const s = host.E.s; const i = s.custom.findIndex((x) => x.id === r.id); if (i >= 0) { s.custom[i] = r; installCustom(s.custom); scheduleSync(); } }
      ui.edit = null; toast('Rôle enregistré.'); break;
    }
    case 'delrole': if (confirm('Supprimer ce rôle ?')) { LS.set('vl-custom', myCustom().filter((x) => x.id !== ui.edit.id)); ui.edit = null; render(); } break;
    case 'exportrole': ui.modal = { type: 'share', code: exportCode(myCustom().find((r) => r.id === d.v)) }; render(); break;
    case 'import': {
      try {
        const r = importCode(document.getElementById('impcode').value);
        const list = myCustom().filter((x) => x.id !== r.id); list.push(r); LS.set('vl-custom', list);
        toast(`« ${r.name} » ajouté à tes rôles.`);
      } catch (x) { toast('Code invalide.'); }
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
