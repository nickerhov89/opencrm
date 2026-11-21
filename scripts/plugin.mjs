// Plugin tool for developers and server administrators.
// Usage:
//   pack <folder> [file.zip]     checks plugin.json and packs the folder into a ZIP ready to upload
//   install <file.zip|folder>    installs into the plugins directory (PLUGINS_DIR, default data/plugins)
//   list                         installed plugins and whether they are enabled
//   enable <id> | disable <id>   switches a plugin on or off
// install, enable and disable take effect after the app restarts (or right away when made
// in Settings → Plugins). In Docker: docker compose exec opencrm node scripts/plugin.mjs ...
import {readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {basename, join, relative, resolve, sep} from 'node:path';
import {packageFiles, pluginsDir, readInstalledManifest, writePackage} from '../server/plugins.js';
import {readZip, writeZip} from '../server/zip.js';

const [command, target, output] = process.argv.slice(2);
const usage = () => { console.error('Использование: node scripts/plugin.mjs pack <папка> [файл.zip] | install <файл.zip|папка> | list | enable <id> | disable <id>'); process.exit(1); };
const skip = name => name.startsWith('.') || name === 'node_modules';

function folderFiles(root) {
  const files = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      if (skip(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push({name: relative(root, path).split(sep).join('/'), data: readFileSync(path)});
    }
  };
  walk(root);
  return files;
}
const load = path => statSync(path).isDirectory() ? folderFiles(path) : readZip(readFileSync(path));

async function withDb(work) {
  const {createDb} = await import('../server/db.js');
  const db = await createDb();
  try { return await work(db); } finally { await db.close(); }
}

try {
  if (command === 'pack') {
    if (!target) usage();
    const pkg = packageFiles(folderFiles(resolve(target)));
    const file = resolve(output || `${pkg.manifest.id}-${pkg.manifest.version}.zip`);
    writeFileSync(file, writeZip(pkg.files));
    console.log(`${pkg.manifest.name} ${pkg.manifest.version}: ${pkg.files.length} файлов → ${file}`);
  } else if (command === 'install') {
    if (!target) usage();
    const pkg = packageFiles(load(resolve(target)));
    const dir = pluginsDir();
    writePackage(dir, pkg);
    console.log(`Установлен ${pkg.manifest.name} ${pkg.manifest.version} в ${join(dir, pkg.manifest.id)}. Включите его в Настройки → Плагины или командой enable ${pkg.manifest.id}.`);
  } else if (command === 'list') {
    const dir = pluginsDir();
    const enabled = await withDb(async db => new Map((await db.prepare('SELECT id,enabled FROM plugins').all()).map(row => [row.id, !!row.enabled])));
    let folders = [];
    try { folders = readdirSync(dir, {withFileTypes: true}).filter(entry => entry.isDirectory() && !skip(entry.name)).map(entry => entry.name); } catch {}
    if (!folders.length) console.log(`Плагинов нет (${dir})`);
    for (const id of folders) {
      try { const manifest = readInstalledManifest(dir, id); console.log(`${enabled.get(id) ? '●' : '○'} ${id} ${manifest.version} — ${manifest.name}`); }
      catch (error) { console.log(`× ${id} — ${error.message}`); }
    }
  } else if (command === 'enable' || command === 'disable') {
    if (!target) usage();
    readInstalledManifest(pluginsDir(), basename(target));
    await withDb(async db => {
      await db.prepare('INSERT INTO plugins (id,version) VALUES (?,?) ON CONFLICT (id) DO NOTHING').run(target, readInstalledManifest(pluginsDir(), target).version);
      await db.prepare(command === 'enable' ? 'UPDATE plugins SET enabled=1,event_cursor=(SELECT COALESCE(MAX(id),0) FROM webhook_events) WHERE id=? AND enabled=0' : "UPDATE plugins SET enabled=0,events_json='[]' WHERE id=?").run(target);
      await db.prepare("INSERT INTO audit_log (user_id,actor,action,target,details,ip) VALUES (NULL,'cli',?,?,?,'')").run(`plugin.${command}d`, `plugin:${target}`, 'Команда на сервере');
    });
    console.log(`${target}: ${command === 'enable' ? 'включён' : 'выключен'}. Перезапустите OpenCRM, чтобы изменение вступило в силу.`);
  } else usage();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
