// Backups of the PostgreSQL database (pg_dump, custom format) together with uploaded files.
//   node scripts/backup.mjs create [folder]     one backup into folder (default ./backups)
//   node scripts/backup.mjs verify <backup>     checksums + pg_restore --list
//   node scripts/backup.mjs restore <backup>    into an EMPTY database at DATABASE_URL and an absent UPLOAD_DIR
//   node scripts/backup.mjs schedule [folder]   keeps running: a backup every BACKUP_INTERVAL_HOURS (24),
//                                               the newest BACKUP_KEEP (14) are kept
// pg_dump and pg_restore must be installed (the Docker image has them); PG_BIN may point at their folder.
import {spawn} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {createReadStream,existsSync} from 'node:fs';
import {chmod,copyFile,lstat,mkdir,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const DUMP='database.dump';
const defaults=()=>({databaseUrl:process.env.DATABASE_URL,uploads:resolve(process.env.UPLOAD_DIR||join(root,'data/uploads'))});
const pathExists=async path=>{try{await lstat(path);return true}catch(error){if(error.code==='ENOENT')return false;throw error}};
const tool=name=>process.env.PG_BIN?join(process.env.PG_BIN,name):name;

function run(name,args,{databaseUrl}={}){
  return new Promise((resolvePromise,reject)=>{
    // The connection string goes through the environment so the password never shows up in `ps`.
    const env={...process.env};
    if(databaseUrl){const url=new URL(databaseUrl);env.PGHOST=url.hostname;env.PGPORT=url.port||'5432';env.PGUSER=decodeURIComponent(url.username);env.PGPASSWORD=decodeURIComponent(url.password);env.PGDATABASE=decodeURIComponent(url.pathname.slice(1));}
    const child=spawn(tool(name),args,{env,stdio:['ignore','pipe','pipe']});
    let output='',errors='';
    child.stdout.on('data',chunk=>{output+=chunk});
    child.stderr.on('data',chunk=>{errors+=chunk});
    child.on('error',error=>reject(error.code==='ENOENT'?new Error(`Не найден ${name}. Установите клиент PostgreSQL или укажите PG_BIN`):error));
    child.on('close',code=>code===0?resolvePromise(output):reject(new Error(`${name}: ${errors.trim()||`код ${code}`}`)));
  });
}

async function regularFiles(base,prefix=''){
  const result=[];
  for(const entry of await readdir(join(base,prefix),{withFileTypes:true})){
    const name=prefix?`${prefix}/${entry.name}`:entry.name;
    if(entry.isDirectory())result.push(...await regularFiles(base,name));
    else if(entry.isFile())result.push(name);
    else throw new Error(`Неподдерживаемый файл в данных: ${name}`);
  }
  return result.sort();
}

async function copyDirectory(source,target){
  await mkdir(target,{recursive:true,mode:0o700});
  if(!existsSync(source))return;
  for(const name of await regularFiles(source)){
    const destination=join(target,name);
    await mkdir(dirname(destination),{recursive:true,mode:0o700});
    await copyFile(join(source,name),destination);
    await chmod(destination,0o600);
  }
}

async function checksum(path){
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(path))hash.update(chunk);
  return hash.digest('hex');
}

export async function verifyBackup(folder){
  const base=resolve(folder),manifest=JSON.parse(await readFile(join(base,'manifest.json'),'utf8'));
  if(manifest.version!==2||!Array.isArray(manifest.files))throw new Error('Неподдерживаемый формат резервной копии');
  const names=manifest.files.map(item=>item.path);
  if(!names.includes(DUMP)||new Set(names).size!==names.length||names.some(name=>typeof name!=='string'||name!==DUMP&&(!name.startsWith('uploads/')||name.includes('\\')||name.split('/').some(part=>!part||part==='.'||part==='..'))))throw new Error('Некорректный список файлов резервной копии');
  const found=(await regularFiles(base)).filter(name=>name!=='manifest.json');
  if(JSON.stringify(found)!==JSON.stringify([...names].sort()))throw new Error('Состав резервной копии изменён');
  for(const item of manifest.files){
    const file=join(base,item.path),size=(await stat(file)).size;
    if(size!==item.bytes||await checksum(file)!==item.sha256)throw new Error(`Повреждён файл: ${item.path}`);
  }
  const contents=await run('pg_restore',['--list',join(base,DUMP)]);
  if(!/TABLE DATA public users/.test(contents))throw new Error('В дампе нет данных CRM');
  return {createdAt:manifest.createdAt,files:manifest.files.length};
}

export async function createBackup({databaseUrl,uploads,destination=join(root,'backups')}={}){
  databaseUrl=databaseUrl||defaults().databaseUrl;
  uploads=resolve(uploads||defaults().uploads);
  if(!databaseUrl)throw new Error('Не задан DATABASE_URL');
  const parent=resolve(destination);
  await mkdir(parent,{recursive:true,mode:0o700});
  const folder=join(parent,`opencrm-${new Date().toISOString().replace(/[:.]/g,'-')}-${randomBytes(3).toString('hex')}`);
  await mkdir(folder,{mode:0o700});
  try{
    await run('pg_dump',['--format=custom','--no-owner','--no-privileges','--file',join(folder,DUMP)],{databaseUrl});
    await chmod(join(folder,DUMP),0o600);
    await copyDirectory(uploads,join(folder,'uploads'));
    const manifest={version:2,createdAt:new Date().toISOString(),files:[]};
    for(const path of await regularFiles(folder))manifest.files.push({path,bytes:(await stat(join(folder,path))).size,sha256:await checksum(join(folder,path))});
    await writeFile(join(folder,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
    await verifyBackup(folder);
    return folder;
  }catch(error){await rm(folder,{recursive:true,force:true});throw error}
}

export async function restoreBackup(folder,{databaseUrl,uploads}={}){
  const base=resolve(folder);
  await verifyBackup(base);
  databaseUrl=databaseUrl||defaults().databaseUrl;
  uploads=resolve(uploads||defaults().uploads);
  if(!databaseUrl)throw new Error('Не задан DATABASE_URL');
  const tables=await run('psql',['--no-psqlrc','--tuples-only','--command',"SELECT count(*) FROM information_schema.tables WHERE table_schema='public'"],{databaseUrl});
  if(Number(tables.trim())>0)throw new Error('База для восстановления не пустая. Остановите CRM и восстановите копию в новую пустую базу.');
  if(await pathExists(uploads)&&(await readdir(uploads)).length)throw new Error('Каталог вложений не пустой. Сначала переместите текущие файлы в безопасное место.');
  await run('pg_restore',['--no-owner','--no-privileges','--exit-on-error','--single-transaction','--dbname',decodeURIComponent(new URL(databaseUrl).pathname.slice(1)),join(base,DUMP)],{databaseUrl});
  await copyDirectory(join(base,'uploads'),uploads);
  return {uploads};
}

async function prune(destination,keep){
  const parent=resolve(destination);
  const backups=(await readdir(parent,{withFileTypes:true})).filter(entry=>entry.isDirectory()&&entry.name.startsWith('opencrm-')).map(entry=>entry.name).sort();
  for(const name of backups.slice(0,Math.max(0,backups.length-keep)))await rm(join(parent,name),{recursive:true,force:true});
}

async function schedule(destination=join(root,'backups')){
  const hours=Math.max(1,Number(process.env.BACKUP_INTERVAL_HOURS)||24),keep=Math.max(1,Number(process.env.BACKUP_KEEP)||14);
  console.log(`Резервные копии каждые ${hours} ч в ${resolve(destination)}, храним ${keep}`);
  // The app creates the schema on its first start; give it time before the first copy.
  await new Promise(done=>setTimeout(done,5*60*1000));
  for(;;){
    try{console.log(new Date().toISOString(),'Копия создана:',await createBackup({destination}));await prune(destination,keep)}
    catch(error){console.error(new Date().toISOString(),'Резервная копия не создана:',error.message)}
    await new Promise(done=>setTimeout(done,hours*3600*1000));
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [action,path]=process.argv.slice(2);
  try{
    if(action==='create')console.log(await createBackup({destination:path}));
    else if(action==='verify'){if(!path)throw new Error('Укажите каталог копии');console.log(await verifyBackup(path))}
    else if(action==='restore'){if(!path)throw new Error('Укажите каталог копии');console.log(await restoreBackup(path))}
    else if(action==='schedule')await schedule(path);
    else throw new Error('Использование: backup.mjs create [каталог] | verify <копия> | restore <копия> | schedule [каталог]');
  }catch(error){console.error(error.message);process.exitCode=1}
}
