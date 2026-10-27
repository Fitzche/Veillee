// Réseau pair-à-pair (WebRTC via PeerJS) : l'hôte est l'arbitre, chaque téléphone s'y connecte.
// Aucun serveur à nous : PeerJS ne sert qu'à mettre les appareils en relation.
const PREFIX = 'veillee-v1-';
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

export const makeCode = () => Array.from({ length: 5 }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join('');
export const cleanCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5);

function peerOpts() { return { debug: 1, config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478' }, { urls: 'turn:eu-0.turn.peerjs.com:3478', username: 'peerjs', credential: 'peerjsp' }, { urls: 'turn:us-0.turn.peerjs.com:3478', username: 'peerjs', credential: 'peerjsp' }] } }; }

export class HostNet {
  constructor(code, { onMsg, onClose, onStatus }) {
    this.code = code; this.onMsg = onMsg; this.onClose = onClose; this.onStatus = onStatus;
    this.conns = new Set();
    this.tries = 0;
    this.open();
  }
  open() {
    if (typeof Peer === 'undefined') { this.onStatus('error', 'Bibliothèque réseau introuvable (hors ligne ?)'); return; }
    this.peer = new Peer(PREFIX + this.code, peerOpts());
    this.peer.on('open', () => { this.tries = 0; this.onStatus('open'); });
    this.peer.on('connection', (conn) => {
      conn.on('open', () => this.conns.add(conn));
      conn.on('data', (d) => this.onMsg(conn, d));
      const gone = () => { if (this.conns.delete(conn)) this.onClose(conn); };
      conn.on('close', gone); conn.on('error', gone);
    });
    this.peer.on('disconnected', () => { this.onStatus('reconnecting'); setTimeout(() => { try { this.peer.reconnect(); } catch { } }, 1500); });
    this.peer.on('error', (e) => {
      if (e.type === 'unavailable-id') {
        // Code encore réservé (rechargement de page) : on réessaie un moment.
        if (++this.tries < 8) { this.onStatus('reconnecting', 'Récupération du code…'); this.peer.destroy(); setTimeout(() => this.open(), 2500); }
        else this.onStatus('error', 'Ce code est déjà utilisé.');
      } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(e.type)) {
        this.onStatus('reconnecting', 'Réseau instable…');
      } else console.warn('peer', e.type, e);
    });
  }
  send(conn, msg) { try { if (conn.open) conn.send(msg); } catch (e) { console.warn(e); } }
  close() { try { this.peer.destroy(); } catch { } }
}

export class ClientNet {
  constructor(code, { onMsg, onStatus, hello }) {
    this.code = code; this.onMsg = onMsg; this.onStatus = onStatus; this.hello = hello;
    this.closed = false; this.fails = 0; this.everConnected = false;
    this.start();
  }
  start() {
    if (typeof Peer === 'undefined') { this.onStatus('error', 'Bibliothèque réseau introuvable (hors ligne ?)'); return; }
    this.onStatus('connecting');
    this.peer = new Peer(peerOpts());
    this.peer.on('open', () => this.connect());
    this.peer.on('error', (e) => {
      if (e.type === 'peer-unavailable') {
        this.fails++;
        if (!this.everConnected && this.fails >= 3) { this.onStatus('error', 'Partie introuvable. Vérifie le code.'); this.close(); return; }
        this.onStatus('reconnecting', 'L\'hôte est injoignable, nouvel essai…');
        setTimeout(() => this.connect(), 2500);
      } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(e.type)) {
        this.onStatus('reconnecting', 'Réseau instable…');
        setTimeout(() => this.restart(), 3000);
      } else console.warn('peer', e.type, e);
    });
    this.peer.on('disconnected', () => { if (!this.closed) setTimeout(() => { try { this.peer.reconnect(); } catch { } }, 1500); });
  }
  restart() { if (this.closed) return; try { this.peer.destroy(); } catch { } this.start(); }
  connect() {
    if (this.closed) return;
    if (this.conn) try { this.conn.close(); } catch { }
    const conn = this.peer.connect(PREFIX + this.code, { reliable: true, serialization: 'json' });
    this.conn = conn;
    conn.on('open', () => { this.fails = 0; this.everConnected = true; this.onStatus('open'); conn.send(this.hello()); });
    conn.on('data', (d) => this.onMsg(d));
    conn.on('close', () => {
      if (this.closed || conn !== this.conn) return;
      this.onStatus('reconnecting', 'Connexion perdue, reconnexion…');
      setTimeout(() => this.connect(), 2000);
    });
  }
  send(msg) { try { if (this.conn && this.conn.open) { this.conn.send(msg); return true; } } catch (e) { console.warn(e); } return false; }
  close() { this.closed = true; try { this.peer.destroy(); } catch { } }
}
