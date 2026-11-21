// Dark theme without a second set of styles. At build time every CSS rule that sets a color gets a
// twin under :root[data-theme=dark] with the color moved to the dark palette, right after the
// original rule, so the light theme stays exactly as written and new styles are themed
// automatically. The palette follows amoCRM's dark theme: blue-black surfaces, light text.
//
// Colors are mapped in OKLCH by their role (background, text, border, shadow): light neutral
// backgrounds become dark surfaces in the same order (cards stay lighter than the page), dark text
// becomes light, pastel tints become dark tints of the same hue, links and accents get lighter.

const selectorPrefix = ':root[data-theme=dark]';

// ---------- color math (sRGB <-> OKLCH) ----------
const toLinear = c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const toGamma = c => c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;

export function rgbToOklch([r, g, b]) {
  const [lr, lg, lb] = [r, g, b].map(v => toLinear(v / 255));
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), (Math.atan2(B, A) * 180 / Math.PI + 360) % 360];
}

function oklchToLinear([L, C, h]) {
  const A = C * Math.cos(h * Math.PI / 180), B = C * Math.sin(h * Math.PI / 180);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}

// Lowers chroma until the color fits in sRGB.
export function oklchToRgb([L, C, h]) {
  L = Math.min(1, Math.max(0, L));
  let lo = 0, hi = C, rgb = oklchToLinear([L, C, h]);
  if (rgb.some(v => v < -1e-4 || v > 1 + 1e-4)) {
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2, test = oklchToLinear([L, mid, h]);
      if (test.some(v => v < -1e-4 || v > 1 + 1e-4)) hi = mid; else { lo = mid; rgb = test; }
    }
    rgb = oklchToLinear([L, lo, h]);
  }
  return rgb.map(v => Math.round(Math.min(1, Math.max(0, toGamma(Math.min(1, Math.max(0, v))))) * 255));
}

// ---------- parsing and printing ----------
const named = {white: [255, 255, 255, 1], black: [0, 0, 0, 1]};
const colorPattern = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|\b(?:white|black)\b/gi;

export function parseColor(text) {
  const value = text.toLowerCase();
  if (named[value]) return named[value];
  if (value.startsWith('#')) {
    const hex = value.slice(1);
    if (![3, 4, 6, 8].includes(hex.length)) return null;
    const full = hex.length <= 4 ? [...hex].map(c => c + c).join('') : hex;
    const n = [0, 2, 4, 6].map(i => parseInt(full.slice(i, i + 2) || 'ff', 16));
    return [n[0], n[1], n[2], n[3] / 255];
  }
  const parts = value.replace(/rgba?\(|\)/g, '').split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const channel = p => p.endsWith('%') ? parseFloat(p) * 2.55 : parseFloat(p);
  const alpha = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
  const rgb = parts.slice(0, 3).map(channel);
  return rgb.some(Number.isNaN) || Number.isNaN(alpha) ? null : [...rgb, alpha];
}

const hex2 = n => Math.round(n).toString(16).padStart(2, '0');
export const printColor = ([r, g, b, a = 1]) => `#${hex2(r)}${hex2(g)}${hex2(b)}${a < 1 ? hex2(a * 255) : ''}`;

// ---------- the dark palette ----------
// Anchors measured in amoCRM's dark theme (OKLCH lightness / chroma):
// menu #07131d 0.18/0.027, page #0f2231 0.244/0.038, cards #153043 0.298/0.048, borders #284860 0.39,
// text #f2f2f2 0.96, secondary text #7f8ba4 0.64, links #1691ff 0.65/0.19.
const hue = 243;
const lerp = (a, b, t) => a + (b - a) * Math.min(1, Math.max(0, t));
// Piecewise-linear map through [x, y] points, x ascending.
const curve = (points, x) => {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) if (x <= points[i][0]) return lerp(points[i - 1][1], points[i][1], (x - points[i - 1][0]) / (points[i][0] - points[i - 1][0]));
  return points.at(-1)[1];
};
// Backgrounds keep their order: white cards → 0.298, the grey page (0.97) → 0.244, the dark menu → 0.18.
const surface = L => curve([[0.2, 0.16], [0.5, 0.19], [0.8, 0.215], [0.93, 0.23], [0.97, 0.244], [0.99, 0.28], [1, 0.298]], L);
const surfaceChroma = L => lerp(0.027, 0.048, (L - 0.18) / 0.12);
// Text: dark text becomes light, mid greys become the secondary grey, light text on dark stays light.
const ink = L => curve([[0.2, 0.97], [0.45, 0.93], [0.6, 0.8], [0.72, 0.64], [0.8, 0.72], [0.9, 0.9], [1, 1]], L);
// Borders: hairlines stay close to the surface, stronger borders a bit lighter; dark borders stay dark.
const line = L => curve([[0.35, 0.15], [0.5, 0.42], [0.7, 0.42], [0.84, 0.37], [0.97, 0.33], [1, 0.32]], L);
// Low-chroma colors count as greys; dark blue-greys such as the menu (#273b4b) too.
// Near-white tints (selection, error backgrounds) keep their hue.
const greyish = (L, C) => C < 0.008 || (L <= 0.9 && C < 0.03) || (L < 0.55 && C < 0.06);

export function darkColor(rgba, role) {
  const [r, g, b, a] = rgba;
  const [L, C, h] = rgbToOklch([r, g, b]);
  const grey = greyish(L, C);
  let out;
  if (role === 'shadow') {
    // Black shadows stay black and get a bit stronger; colored glows are treated as borders.
    if (L < 0.35) return [r, g, b, Math.min(1, a * 1.8)];
    return darkColor(rgba, 'border');
  }
  if (role === 'background') {
    if (grey) { const out = surface(L); return [...oklchToRgb([out, surfaceChroma(out), hue]), a]; }
    if (L >= 0.84) out = [lerp(0.3, 0.37, (L - 0.84) / 0.16), Math.min(0.075, C * 0.6 + 0.025), h];   // pastel tint → dark tint
    else out = [Math.min(L, 0.62), C, h];                                                                // buttons, badges
  } else if (role === 'text') {
    if (grey) { const out = ink(L); return [...oklchToRgb([out, out > 0.85 ? 0.004 : 0.04, out > 0.85 ? hue : 262]), a]; }
    if (L > 0.9) out = [L, C, h];
    else out = [Math.max(L, 0.7), Math.max(C, 0.12), h];                                                // links, red, green
  } else {
    if (grey) { const out = line(L); return [...oklchToRgb([out, 0.045, hue]), a]; }
    if (L >= 0.8) out = [lerp(0.4, 0.46, (L - 0.8) / 0.2), Math.min(0.08, C * 0.7 + 0.02), h];
    else out = [Math.max(L, 0.55), C, h];
  }
  return [...oklchToRgb(out), a];
}

// ---------- CSS ----------
const roles = [
  [/^(background|background-color|background-image)$/, 'background'],
  [/^(color|fill|stroke|caret-color|text-decoration-color|-webkit-text-fill-color|column-rule-color)$/, 'text'],
  [/^(border|border-(top|right|bottom|left|block|inline)(-color)?|border-color|outline|outline-color|column-rule)$/, 'border'],
  [/^(box-shadow|text-shadow)$/, 'shadow'],
];
export const roleOf = prop => roles.find(([pattern]) => pattern.test(prop.toLowerCase()))?.[1] || null;
const keepKeyword = /^(transparent|currentcolor|inherit|initial|unset|none)$/i;

export function darkValue(prop, value) {
  const role = roleOf(prop);
  if (!role) return null;
  // url(...) parts are kept as they are.
  let changed = false;
  const out = value.replace(/url\([^)]*\)|#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|\b(?:white|black)\b/gi, match => {
    if (/^url\(/i.test(match)) return match;
    const rgba = parseColor(match);
    if (!rgba) return match;
    changed = true;
    return printColor(darkColor(rgba, role));
  });
  if (changed) return out;
  // A rule that resets a color must keep doing so in the dark theme, or a less specific dark twin wins.
  return keepKeyword.test(value.trim()) ? value : null;
}

export const darkSelector = selector => {
  const trimmed = selector.trim();
  if (/^:root\b/.test(trimmed)) return trimmed.replace(/^:root/, selectorPrefix);
  if (/^html\b/.test(trimmed)) return trimmed.replace(/^html/, 'html[data-theme=dark]');
  return `${selectorPrefix} ${trimmed}`;
};

const insideKeyframes = node => { for (let p = node.parent; p; p = p.parent) if (p.type === 'atrule' && /keyframes$/i.test(p.name)) return true; return false; };

// PostCSS plugin (Vite runs it for every stylesheet). Files matched by `exclude` are left alone.
export function darkThemePlugin({exclude = /\.module\.css$|landing|public-form/i} = {}) {
  return {
    postcssPlugin: 'opencrm-dark-theme',
    Once(root) {
      const file = root.source?.input?.file || '';
      if (exclude.test(file)) return;
      root.walkRules(rule => {
        if (insideKeyframes(rule) || rule.selector.includes('[data-theme')) return;
        const decls = [];
        rule.each(node => {
          if (node.type !== 'decl') return;
          const value = darkValue(node.prop, node.value);
          // Cloned declarations keep their source position (Vite needs it for url() handling).
          if (value !== null) decls.push(node.clone({value}));
        });
        if (!decls.length) return;
        const twin = rule.clone();
        twin.removeAll();
        twin.selectors = rule.selectors.map(darkSelector);
        for (const decl of decls) twin.append(decl);
        rule.after(twin);
      });
    },
  };
}
darkThemePlugin.postcss = true;
