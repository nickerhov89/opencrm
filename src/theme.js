// Interface theme: «auto» follows the system, «light» and «dark» are fixed. The choice is kept in
// localStorage (public/theme-init.js applies it before the first paint) and on the server, so it
// follows the employee to other devices. Dark styles are generated at build time
// (scripts/dark-theme.mjs) under :root[data-theme=dark].

export const themes = [
  {value: 'auto', label: 'Авто', hint: 'Как в системе'},
  {value: 'light', label: 'Светлая', hint: 'Светлая тема'},
  {value: 'dark', label: 'Тёмная', hint: 'Тёмная тема'},
];
const storageKey = 'opencrm.theme';
const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
const valid = value => themes.some(theme => theme.value === value);
const listeners = new Set();
let forcedLight = 0;

export function storedTheme() {
  try { const value = localStorage.getItem(storageKey); return valid(value) ? value : 'auto'; } catch { return 'auto'; }
}
let preference = storedTheme();

export const currentTheme = () => preference;
export const resolveTheme = (value = preference) => value === 'auto' ? (media?.matches ? 'dark' : 'light') : value;
export const subscribeTheme = listener => { listeners.add(listener); return () => listeners.delete(listener); };

function paint() {
  const theme = forcedLight ? 'light' : resolveTheme();
  const root = document.documentElement;
  if (root.dataset.theme !== theme) root.dataset.theme = theme;
}

// Circle from the clicked control when the browser supports view transitions; otherwise instant.
function withTransition(change, origin) {
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (!origin || reduce || !document.startViewTransition) { change(); return; }
  const {x, y} = origin;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const transition = document.startViewTransition(change);
  transition.ready.then(() => document.documentElement.animate(
    {clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`]},
    {duration: 480, easing: 'cubic-bezier(.4,0,.2,1)', pseudoElement: '::view-transition-new(root)'},
  )).catch(() => {});
}

// origin: {x, y} of the click for the animation; save: send the choice to the server.
export function setTheme(value, {origin, save} = {}) {
  if (!valid(value)) return;
  const before = resolveTheme();
  preference = value;
  try { localStorage.setItem(storageKey, value); } catch {}
  if (resolveTheme() !== before && !forcedLight) withTransition(paint, origin); else paint();
  listeners.forEach(listener => listener(value));
  if (save) void save(value);
}

// Pages for visitors (the landing page, public forms) stay light whatever the employee chose.
export function forceLightTheme() {
  forcedLight++;
  paint();
  return () => { forcedLight = Math.max(0, forcedLight - 1); paint(); };
}

media?.addEventListener?.('change', () => { if (preference === 'auto') withTransition(paint, null); });
if (typeof document !== 'undefined') paint();
