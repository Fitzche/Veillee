// Rôles sur mesure et événements : compilation et partage.
import { compileRole, normalizeRole, normalizeEvent, blankRole } from '../rules.js';

export const TEAMS = {
  lg: { village: 'Village', loup: 'Loups-Garous', solo: 'Solitaire' },
  botc: { townsfolk: 'Villageois', outsider: 'Étranger', minion: 'Sbire', demon: 'Démon' },
};

export const blankCustom = blankRole;
export function compileCustom(d) { return [compileRole(d)]; }

/** Partage : code texte compact (base64 du JSON). Sert pour les rôles comme pour les événements. */
export function exportCode(d) { return 'VEIL1:' + btoa(unescape(encodeURIComponent(JSON.stringify(d)))); }
export function importCode(code) {
  const m = String(code).trim().match(/^VEIL1:([A-Za-z0-9+/=]+)$/);
  if (!m) throw new Error('Code invalide');
  const d = JSON.parse(decodeURIComponent(escape(atob(m[1]))));
  return d.kind === 'event' ? normalizeEvent(d) : normalizeRole(d);
}
