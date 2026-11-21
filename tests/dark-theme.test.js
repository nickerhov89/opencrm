import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import postcss from 'postcss';
import {darkColor, darkThemePlugin, darkValue, parseColor, printColor, rgbToOklch} from '../scripts/dark-theme.mjs';

const dark = (hex, role) => printColor(darkColor(parseColor(hex), role));
const lightness = hex => rgbToOklch(parseColor(hex)).at(0);
const run = async (css, from = 'src/style.css') => (await postcss([darkThemePlugin()]).process(css, {from})).css;

test('тёмная палитра повторяет amoCRM и сохраняет порядок фонов', () => {
  assert.equal(dark('#f5f5f6', 'background'), '#0f2231', 'фон страницы как в amoCRM');
  assert.ok(Math.abs(lightness(dark('#fff', 'background')) - lightness('#153043')) < 0.01, 'карточки как в amoCRM');
  assert.ok(lightness(dark('#fff', 'background')) > lightness(dark('#f5f5f6', 'background')), 'карточки светлее страницы');
  assert.ok(lightness(dark('#273b4b', 'background')) < lightness(dark('#f5f5f6', 'background')), 'меню темнее страницы');
  assert.ok(lightness(dark('#303a43', 'text')) > 0.9, 'тёмный текст становится светлым');
  assert.ok(lightness(dark('#9aa3aa', 'text')) < 0.7, 'серый текст остаётся второстепенным');
  assert.equal(dark('#ffffff', 'text'), '#ffffff', 'белый текст на кнопках не меняется');
  assert.ok(lightness(dark('#3978b1', 'text')) >= 0.69, 'ссылки становятся светлее');
  const tint = rgbToOklch(parseColor(dark('#fdf1f0', 'background')));
  assert.ok(tint[1] > 0.02 && tint[0] < 0.4, 'бледная красная подложка становится тёмно-красной');
  assert.equal(dark('#0000000a', 'shadow').slice(0, 7), '#000000', 'тени остаются чёрными');
  assert.deepEqual(parseColor('rgba(255, 0, 0, .5)'), [255, 0, 0, 0.5]);
  assert.equal(parseColor('#abc').join(), '170,187,204,1');
});

test('значения: цвета внутри составных свойств, url() не трогается, сброс цвета сохраняется', () => {
  assert.match(darkValue('border', '1px solid #c8cbce'), /^1px solid #[0-9a-f]{6}$/);
  assert.match(darkValue('box-shadow', '0 1px 2px #00000007, inset 0 0 0 1px #5b91e5'), /^0 1px 2px #000000[0-9a-f]{2}, inset 0 0 0 1px #[0-9a-f]{6}$/);
  assert.equal(darkValue('background', 'url(data:image/svg+xml;utf8,<svg fill="#fff"/>) no-repeat'), null);
  assert.equal(darkValue('background', 'transparent'), 'transparent');
  assert.equal(darkValue('color', 'inherit'), 'inherit');
  assert.equal(darkValue('width', '#fff'), null);
  assert.equal(darkValue('color', '#fff'), '#ffffff');
});

test('CSS: тёмный двойник встаёт сразу после правила, светлые стили не меняются', async () => {
  const css = '.a{color:#333;width:10px}.b,.c:hover{background:#fff!important}:root{background:#f5f5f6}@media(max-width:760px){.d{border:1px solid #eee}}@keyframes k{from{color:#000}}.e{background:none}';
  const out = await run(css);
  assert.ok(out.startsWith('.a{color:#333;width:10px}:root[data-theme=dark] .a{color:#'), out);
  assert.match(out, /:root\[data-theme=dark\] \.b,:root\[data-theme=dark\] \.c:hover\{background:#[0-9a-f]{6}!important\}/);
  assert.match(out, /:root\[data-theme=dark\]\{background:#0f2231\}/);
  assert.match(out, /@media\(max-width:760px\)\{\.d\{border:1px solid #eee\}:root\[data-theme=dark\] \.d\{border:1px solid #[0-9a-f]{6}\}\}/);
  assert.match(out, /@keyframes k\{from\{color:#000\}\}/, 'анимации не трогаются');
  assert.match(out, /:root\[data-theme=dark\] \.e\{background:none\}/);
  assert.ok(!/width:10px\}:root\[data-theme=dark\][^{]*\{[^}]*width/.test(out), 'в двойник попадают только цвета');
  assert.equal(out.replace(/:root\[data-theme=dark\][^{]*\{[^}]*\}/g, ''), css, 'без двойников — исходный CSS');
  assert.equal(await run('.x{color:#333}', 'src/LandingPage.module.css'), '.x{color:#333}', 'страница для посетителей не темнеет');
  assert.equal(await run(':root[data-theme=dark] .x{color:#123}'), ':root[data-theme=dark] .x{color:#123}', 'ручные тёмные правила не дублируются');
});

test('тема сотрудника сохраняется на сервере', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencrm-theme-'));
  process.env.PGLITE_DIR = join(dir, 'pg');
  process.env.UPLOAD_DIR = join(dir, 'uploads');
  process.env.NODE_ENV = 'test';
  const {app, db} = await import('../server/index.js');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  let cookie = '';
  const request = async (path, method = 'GET', body, status = 200) => {
    const response = await fetch(base + path, {method, headers: {'Content-Type': 'application/json', ...(cookie ? {Cookie: cookie} : {})}, body: body ? JSON.stringify(body) : undefined});
    assert.equal(response.status, status, `${method} ${path}`);
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return response.json();
  };
  try {
    assert.equal((await request('/setup', 'POST', {name: 'Admin', email: 'admin@example.test', password: 'passphrase-for-tests'})).theme, 'auto');
    await request('/me/theme', 'PUT', {theme: 'dark'});
    assert.equal((await request('/me')).theme, 'dark');
    await request('/me/theme', 'PUT', {theme: 'purple'}, 400);
    cookie = '';
    await request('/me/theme', 'PUT', {theme: 'light'}, 401);
    assert.equal((await request('/login', 'POST', {email: 'admin@example.test', password: 'passphrase-for-tests'})).theme, 'dark', 'тема приходит при входе');
  } finally {
    server.close();
    await db.close?.();
    rmSync(dir, {recursive: true, force: true});
  }
});
