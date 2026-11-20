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
import {chmod,copyFile,lstat,mkdir,mkdtemp,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const DUMP='database.dump';
const README='RESTORE.txt';
// Every copy carries its own restore instructions, so it is usable without this repository at hand.
const restoreNotes=createdAt=>`Резервная копия OpenCRM от ${createdAt} (UTC).

Состав:
  database.dump  — полный дамп базы PostgreSQL (pg_dump, формат custom): все таблицы и данные,
                   последовательности, функции и триггеры. Владелец и права не сохраняются,
                   поэтому дамп восстанавливается в любую пустую базу под любым пользователем.
  uploads/       — вложения (файлы сделок, контактов и компаний).
  manifest.json  — размеры и SHA-256 всех файлов.

Восстановление на сервере с OpenCRM (Docker Compose, каталог /opt/opencrm). Текущие данные не удаляются,
а откладываются в сторону:
  1. Остановите CRM и службу копий:
       docker compose -p opencrm stop opencrm backup
  2. Отложите текущую базу и создайте пустую:
       docker compose -p opencrm exec db psql -U opencrm -d postgres -c "ALTER DATABASE opencrm RENAME TO opencrm_old_$(date +%Y%m%d%H%M)"
       docker compose -p opencrm exec db createdb -U opencrm opencrm
  3. Отложите текущие вложения:
       docker compose -p opencrm run --rm --no-deps backup sh -c 'mv /app/data/uploads /app/data/uploads-old-$(date +%Y%m%d%H%M)'
  4. Восстановите копию прямо из S3 (скачает, проверит контрольные суммы, база должна быть пустой):
       docker compose -p opencrm run --rm backup node scripts/backup.mjs restore-s3 ИМЯ_КОПИИ
     Без ИМЯ_КОПИИ берётся самая свежая. Список копий: ... node scripts/backup.mjs remote-list
  5. Запустите всё обратно: docker compose -p opencrm up -d

Без OpenCRM, только инструменты PostgreSQL 17+:
  createdb имя_базы
  pg_restore --no-owner --no-privileges --exit-on-error --single-transaction --dbname имя_базы database.dump
  Вложения скопируйте в каталог UPLOAD_DIR приложения.
`;
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
  if(!names.includes(DUMP)||new Set(names).size!==names.length||names.some(name=>typeof name!=='string'||name!==DUMP&&name!==README&&(!name.startsWith('uploads/')||name.includes('\\')||name.split('/').some(part=>!part||part==='.'||part==='..'))))throw new Error('Некорректный список файлов резервной копии');
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
    const createdAt=new Date().toISOString();
    await writeFile(join(folder,README),restoreNotes(createdAt),{mode:0o600});
    const manifest={version:2,createdAt,files:[]};
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

async function localBackups(destination){
  const parent=resolve(destination);
  if(!await pathExists(parent))return [];
  return (await readdir(parent,{withFileTypes:true})).filter(entry=>entry.isDirectory()&&entry.name.startsWith('opencrm-')).map(entry=>entry.name).sort();
}

async function prune(destination,keep){
  const backups=await localBackups(destination);
  for(const name of backups.slice(0,Math.max(0,backups.length-keep)))await rm(join(resolve(destination),name),{recursive:true,force:true});
}

// Downloads a backup from S3 (the newest one without a name) into a local folder and verifies it.
export async function downloadBackup(name,destination){
  const {env,target}=await remote();
  if(!name){
    const all=(await listRemote()).map(item=>item.replace(/\/$/,'')).filter(item=>item.startsWith('opencrm-')).sort();
    name=all.at(-1);
    if(!name)throw new Error('В хранилище нет резервных копий');
  }
  if(!/^opencrm-[\w-]+$/.test(name))throw new Error(`Некорректное имя копии: ${name}`);
  const folder=join(resolve(destination),name);
  if(await pathExists(folder))throw new Error(`Каталог уже существует: ${folder}`);
  await run('rclone',['copy',target+name,folder,'--retries','5'],{extraEnv:env});
  await verifyBackup(folder);
  return folder;
}

// Restores straight from S3 into the (empty) database at DATABASE_URL and an empty UPLOAD_DIR.
export async function restoreFromRemote(name,options={}){
  const temp=await mkdtemp(join(tmpdir(),'opencrm-restore-'));
  try{
    const folder=await downloadBackup(name,temp);
    console.log(new Date().toISOString(),'Копия скачана и проверена:',basename(folder));
    return {backup:basename(folder),...await restoreBackup(folder,options)};
  }finally{await rm(temp,{recursive:true,force:true})}
}

const log=(...items)=>console.log(new Date().toISOString(),...items);
const logError=(...items)=>console.error(new Date().toISOString(),...items);

// One full cycle. With BACKUP_KEEP=0 nothing stays on this host: every local copy is removed as soon as
// S3 confirms it, and a copy that failed to upload is kept and retried on the next run.
// Returns false if anything failed.
export async function backupCycle(destination=join(root,'backups')){
  const raw=process.env.BACKUP_KEEP,keep=raw===undefined||raw===''?14:Math.max(0,Number(raw)||0);
  if(keep===0&&!remoteConfigured()){logError('BACKUP_KEEP=0 без настроенного S3: копии негде хранить');return false}
  let folder=null,ok=true;
  try{folder=await createBackup({destination});log('Копия создана:',basename(folder))}
  catch(error){ok=false;logError('Резервная копия не создана:',error.message)}
  if(remoteConfigured()){
    const pending=keep===0?await localBackups(destination):folder?[basename(folder)]:[];
    for(const name of pending){
      try{
        const where=await uploadBackup(join(resolve(destination),name));
        log('Копия выгружена и сверена:',where);
        if(keep===0){await rm(join(resolve(destination),name),{recursive:true,force:true});log('Локальная копия удалена:',name)}
      }catch(error){ok=false;logError('Копия не выгружена в S3, повторим при следующем запуске:',name,error.message)}
    }
    try{await pruneRemote()}catch(error){ok=false;logError('Не удалось удалить старые копии в S3:',error.message)}
  }
  if(keep>0)await prune(destination,keep);
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
  const at=process.env.BACKUP_AT,hours=Math.max(1,Number(process.env.BACKUP_INTERVAL_HOURS)||24),keep=process.env.BACKUP_KEEP===undefined||process.env.BACKUP_KEEP===''?14:Math.max(0,Number(process.env.BACKUP_KEEP)||0);
  const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  console.log(`Резервные копии ${at?`каждый день в ${at} (${zone})`:`каждые ${hours} ч`} ${keep?`в ${resolve(destination)}, на сервере храним ${keep}`:'только в S3, на сервере не храним'}${remoteConfigured()?`, выгрузка в S3: ${process.env.BACKUP_S3_BUCKET}/${process.env.BACKUP_S3_PREFIX||'opencrm'}`:''}`);
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
    else if(action==='download'){console.log(await downloadBackup(path,process.argv[4]||join(root,'backups')))}
    else if(action==='restore-s3'){console.log(await restoreFromRemote(path))}
    else if(action==='remote-list')console.log((await listRemote()).join('\n')||'В хранилище копий нет');
    else throw new Error('Использование: backup.mjs create [каталог] | verify <копия> | restore <копия> | schedule [каталог] | now [каталог] | upload <копия> | remote-list | download [имя] [каталог] | restore-s3 [имя]');
  }catch(error){console.error(error.message);process.exitCode=1}
}
