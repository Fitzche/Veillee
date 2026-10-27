// Registre unique des rôles (intégrés + sur mesure).
import { compileCustom } from './custom.js';

const REG = new Map();
let customIds = [];

export function register(list) { for (const r of list) REG.set(r.id, r); }
export const getRole = (id) => REG.get(id);
export const roleName = (id) => REG.get(id)?.name || id || '?';
export const allRoles = (game) => [...REG.values()].filter((r) => !game || r.game === game || (r.custom && r.game === 'both'));

/** Remplace les rôles sur mesure de la partie en cours par ceux de l'hôte. */
export function installCustom(defs = []) {
  for (const id of customIds) REG.delete(id);
  customIds = [];
  for (const d of defs) {
    try {
      for (const r of compileCustom(d)) { REG.set(r.id, r); customIds.push(r.id); }
    } catch (e) { console.warn('rôle sur mesure invalide', d, e); }
  }
}

/** Fiche publique d'un rôle (ce qu'on envoie aux écrans). */
export function roleCard(id) {
  const r = REG.get(id);
  if (!r) return { id, name: id, icon: '❔', text: '', team: '?' };
  return { id: r.id, name: r.name, icon: r.icon, text: r.text, team: r.team, game: r.game, ed: r.ed, custom: !!r.custom };
}
