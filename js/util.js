export const uid = () => Math.random().toString(36).slice(2, 10);
export const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
export const pick = (a) => a[Math.floor(Math.random() * a.length)];
export const chance = (x) => Math.random() < x;
export const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
export const names = (ps) => ps.map((p) => p.name).join(', ');
