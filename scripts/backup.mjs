// Backups of the PostgreSQL database (pg_dump, custom format) together with uploaded files.
//   node scripts/backup.mjs create [folder]     one backup into folder (default ./backups)
//   node scripts/backup.mjs verify <backup>     checksums + pg_restore --list
//   node scripts/backup.mjs restore <backup>    into an EMPTY database at DATABASE_URL and an absent UPLOAD_DIR
//   node scripts/backup.mjs schedule [folder]   keeps running: a backup every BACKUP_INTERVAL_HOURS (24),
//                                               the newest BACKUP_KEEP (14) are kept
//                                               or, with BACKUP_AT=HH:MM, every day at that time in TZ
//   node scripts/backup.mjs now [folder]        one full cycle right away: copy, retention, S3 upload
//   node scripts/backup.mjs upload <backup>     copies a backup to S3-compatible storage
//   node scripts/backup.mjs remote-list         lists backups in that storage
// With BACKUP_S3_BUCKET set, schedule also uploads every new backup with rclone to BACKUP_S3_ENDPOINT,
// bucket BACKUP_S3_BUCKET, folder BACKUP_S3_PREFIX (default "opencrm"), keys BACKUP_S3_ACCESS_KEY_ID and
// BACKUP_S3_SECRET_ACCESS_KEY (BACKUP_S3_REGION optional), and deletes remote copies older than
// BACKUP_S3_KEEP_DAYS (30). BACKUP_S3_ENCRYPTION_PASSWORD encrypts files before upload: keep it outside
// the server, without it the remote copies cannot be restored.
// pg_dump and pg_restore must be installed (the Docker image has them); PG_BIN may point at their folder.
import {spawn} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {createReadStream,existsSync} from 'node:fs';
import {chmod,copyFile,lstat,mkdir,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const DUMP='database.dump';
const defaults=()=>({databaseUrl:process.env.DATABASE_URL,uploads:resolve(process.env.UPLOAD_DIR||join(root,'data/uploads'))});
const pathExists=async path=>{try{await lstat(path);return true}catch(error){if(error.code==='ENOENT')return false;throw error}};
const tool=name=>process.env.PG_BIN?join(process.env.PG_BIN,name):name;

function run(name,args,{databaseUrl,extraEnv={},input}={}){
  return new Promise((resolvePromise,reject)=>{
    // Connection strings and keys go through the environment so they never show up in `ps`.
    const env={...process.env,...extraEnv};
    if(databaseUrl){const url=new URL(databaseUrl);env.PGHOST=url.hostname;env.PGPORT=url.port||'5432';env.PGUSER=decodeURIComponent(url.username);env.PGPASSWORD=decodeURIComponent(url.password);env.PGDATABASE=decodeURIComponent(url.pathname.slice(1));}
    const child=spawn(name==='rclone'?name:tool(name),args,{env,stdio:[input===undefined?'ignore':'pipe','pipe','pipe']});
    if(input!==undefined)child.stdin.end(input);
    let output='',errors='';
    child.stdout.on('data',chunk=>{output+=chunk});
    child.stderr.on('data',chunk=>{errors+=chunk});
    child.on('error',error=>reject(error.code==='ENOENT'?new Error(name==='rclone'?'Не найден rclone':`Не найден ${name}. Установите клиент PostgreSQL или укажите PG_BIN`):error));
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

// Off-site copies in S3-compatible storage via rclone. rclone is configured only through
// environment variables, so no credentials are written to disk.
export const remoteConfigured=()=>!!process.env.BACKUP_S3_BUCKET;

async function remote(){
  const missing=['BACKUP_S3_ENDPOINT','BACKUP_S3_BUCKET','BACKUP_S3_ACCESS_KEY_ID','BACKUP_S3_SECRET_ACCESS_KEY'].filter(key=>!process.env[key]);
  if(missing.length)throw new Error(`Для выгрузки в S3 не заданы: ${missing.join(', ')}`);
  const prefix=(process.env.BACKUP_S3_PREFIX||'opencrm').replace(/^\/+|\/+$/g,'');
  const env={
    RCLONE_CONFIG_OPENCRMS3_TYPE:'s3',
    RCLONE_CONFIG_OPENCRMS3_PROVIDER:'Other',
    RCLONE_CONFIG_OPENCRMS3_ENDPOINT:process.env.BACKUP_S3_ENDPOINT,
    RCLONE_CONFIG_OPENCRMS3_REGION:process.env.BACKUP_S3_REGION||'',
    RCLONE_CONFIG_OPENCRMS3_ACCESS_KEY_ID:process.env.BACKUP_S3_ACCESS_KEY_ID,
    RCLONE_CONFIG_OPENCRMS3_SECRET_ACCESS_KEY:process.env.BACKUP_S3_SECRET_ACCESS_KEY,
    RCLONE_CONFIG_OPENCRMS3_NO_CHECK_BUCKET:'true'
  };
  let target=`opencrms3:${process.env.BACKUP_S3_BUCKET}/${prefix}/`;
  if(process.env.BACKUP_S3_ENCRYPTION_PASSWORD){
    const obscured=(await run('rclone',['obscure','-'],{input:process.env.BACKUP_S3_ENCRYPTION_PASSWORD})).trim();
    Object.assign(env,{
      RCLONE_CONFIG_OPENCRMCRYPT_TYPE:'crypt',
      RCLONE_CONFIG_OPENCRMCRYPT_REMOTE:target,
      RCLONE_CONFIG_OPENCRMCRYPT_PASSWORD:obscured,
      RCLONE_CONFIG_OPENCRMCRYPT_FILENAME_ENCRYPTION:'off',
      RCLONE_CONFIG_OPENCRMCRYPT_DIRECTORY_NAME_ENCRYPTION:'false'
    });
    target='opencrmcrypt:';
  }
  return {env,target};
}

export async function uploadBackup(folder){
  const base=resolve(folder),name=basename(base);
  await verifyBackup(base);
  const {env,target}=await remote();
  // --immutable refuses to replace an existing remote file with different contents.
  await run('rclone',['copy',base,target+name,'--immutable','--retries','5','--low-level-retries','10'],{extraEnv:env});
  // Compare what arrived with the local copy (encrypted remotes need --download to compare contents).
  await run('rclone',['check',base,target+name,'--one-way',...(process.env.BACKUP_S3_ENCRYPTION_PASSWORD?['--download']:[])],{extraEnv:env});
  return target+name;
}

export async function listRemote(){
  const {env,target}=await remote();
  return (await run('rclone',['lsf',target,'--dirs-only'],{extraEnv:env})).split('\n').filter(Boolean);
}

async function pruneRemote(){
  const days=Math.max(1,Number(process.env.BACKUP_S3_KEEP_DAYS)||30);
  const {env,target}=await remote();
  await run('rclone',['delete',target,'--min-age',`${days}d`,'--rmdirs'],{extraEnv:env});
}

async function prune(destination,keep){
  const parent=resolve(destination);
  const backups=(await readdir(parent,{withFileTypes:true})).filter(entry=>entry.isDirectory()&&entry.name.startsWith('opencrm-')).map(entry=>entry.name).sort();
  for(const name of backups.slice(0,Math.max(0,backups.length-keep)))await rm(join(parent,name),{recursive:true,force:true});
}

// One full cycle: local copy, local retention, then the off-site copy. Returns false if anything failed.
export async function backupCycle(destination=join(root,'backups')){
  const keep=Math.max(1,Number(process.env.BACKUP_KEEP)||14);
  let folder=null,ok=true;
  try{folder=await createBackup({destination});console.log(new Date().toISOString(),'Копия создана:',folder);await prune(destination,keep)}
  catch(error){ok=false;console.error(new Date().toISOString(),'Резервная копия не создана:',error.message)}
  if(folder&&remoteConfigured()){
    try{console.log(new Date().toISOString(),'Копия выгружена:',await uploadBackup(folder));await pruneRemote()}
    catch(error){ok=false;console.error(new Date().toISOString(),'Копия не выгружена в S3:',error.message)}
  }
  return ok;
}

// Milliseconds until the next HH:MM in the process time zone (TZ, e.g. Europe/Moscow).
export function msUntil(time,now=new Date()){
  const match=/^([01]\d|2[0-3]):([0-5]\d)$/.exec(time||'');
  if(!match)throw new Error(`BACKUP_AT должен быть в формате ЧЧ:ММ, получено «${time}»`);
  const next=new Date(now);next.setHours(Number(match[1]),Number(match[2]),0,0);
  if(next<=now)next.setDate(next.getDate()+1);
  return next-now;
}

async function schedule(destination=join(root,'backups')){
  const at=process.env.BACKUP_AT,hours=Math.max(1,Number(process.env.BACKUP_INTERVAL_HOURS)||24),keep=Math.max(1,Number(process.env.BACKUP_KEEP)||14);
  const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  console.log(`Резервные копии ${at?`каждый день в ${at} (${zone})`:`каждые ${hours} ч`} в ${resolve(destination)}, храним ${keep}${remoteConfigured()?`, выгрузка в S3: ${process.env.BACKUP_S3_BUCKET}/${process.env.BACKUP_S3_PREFIX||'opencrm'}`:''}`);
  // Without a fixed time the first copy waits a few minutes: the app creates the schema on its first start.
  if(!at)await new Promise(done=>setTimeout(done,5*60*1000));
  for(;;){
    if(at){
      const wait=msUntil(at);
      console.log(new Date().toISOString(),'Следующая копия:',new Date(Date.now()+wait).toLocaleString('ru-RU',{timeZone:zone}));
      await new Promise(done=>setTimeout(done,wait));
    }
    await backupCycle(destination);
    if(!at)await new Promise(done=>setTimeout(done,hours*3600*1000));
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [action,path]=process.argv.slice(2);
  try{
    if(action==='create')console.log(await createBackup({destination:path}));
    else if(action==='verify'){if(!path)throw new Error('Укажите каталог копии');console.log(await verifyBackup(path))}
    else if(action==='restore'){if(!path)throw new Error('Укажите каталог копии');console.log(await restoreBackup(path))}
    else if(action==='schedule')await schedule(path);
    else if(action==='now'){if(!await backupCycle(path))process.exitCode=1}
    else if(action==='upload'){if(!path)throw new Error('Укажите каталог копии');console.log(await uploadBackup(path))}
    else if(action==='remote-list')console.log((await listRemote()).join('\n')||'В хранилище копий нет');
    else throw new Error('Использование: backup.mjs create [каталог] | verify <копия> | restore <копия> | schedule [каталог] | now [каталог] | upload <копия> | remote-list');
  }catch(error){console.error(error.message);process.exitCode=1}
}
