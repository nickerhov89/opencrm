// Backups of OpenCRM: one file per copy, opencrm-<time>.tar.gz, containing a full PostgreSQL dump
// (pg_dump, custom format), the uploaded files, a checksum list and RESTORE.txt with restore steps.
//   node scripts/backup.mjs create [folder]       one backup file into folder (default ./backups)
//   node scripts/backup.mjs verify <file>         checksums + pg_restore --list
//   node scripts/backup.mjs restore <file>        into an EMPTY database at DATABASE_URL and an empty UPLOAD_DIR
//   node scripts/backup.mjs schedule [folder]     keeps running: every day at BACKUP_AT (HH:MM, time zone TZ),
//                                                 or every BACKUP_INTERVAL_HOURS (24) without BACKUP_AT
//   node scripts/backup.mjs now [folder]          one full cycle right away: copy, S3 upload, retention
//   node scripts/backup.mjs upload <file>         copies a backup file to S3-compatible storage
//   node scripts/backup.mjs remote-list           lists backup files in that storage
//   node scripts/backup.mjs download [name] [dir] downloads a file from S3 (the newest without a name)
//   node scripts/backup.mjs restore-s3 [name]     downloads and restores in one step
// S3: BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_PREFIX (default "opencrm"), BACKUP_S3_ACCESS_KEY_ID,
// BACKUP_S3_SECRET_ACCESS_KEY, BACKUP_S3_REGION (optional); copies older than BACKUP_S3_KEEP_DAYS (30) are
// deleted there. BACKUP_S3_ENCRYPTION_PASSWORD encrypts files before upload: keep it outside the server.
// BACKUP_KEEP local copies are kept (14); 0 keeps none: a file is deleted once S3 confirms it.
// pg_dump, pg_restore, psql, tar and rclone must be installed (the Docker image has them).
import {spawn} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {createReadStream,existsSync} from 'node:fs';
import {chmod,copyFile,lstat,mkdir,mkdtemp,readFile,readdir,rename,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const DUMP='database.dump',README='RESTORE.txt',MANIFEST='manifest.json',EXT='.tar.gz';
const NAME=/^opencrm-[\w-]+\.tar\.gz$/;

// Every copy carries its own restore instructions, so it is usable without this repository at hand.
const restoreNotes=(name,createdAt)=>`Резервная копия OpenCRM ${name}, создана ${createdAt} (UTC).

Внутри архива:
  database.dump  — полный дамп базы PostgreSQL (pg_dump, формат custom): все таблицы и данные,
                   последовательности, функции и триггеры. Владелец и права не сохраняются,
                   поэтому дамп восстанавливается в любую пустую базу под любым пользователем.
  uploads/       — вложения (файлы сделок, контактов и компаний).
  manifest.json  — размеры и SHA-256 всех файлов для проверки.

Восстановление на сервере с OpenCRM (Docker Compose, каталог /opt/opencrm). Текущие данные не удаляются,
а откладываются в сторону:
  1. Остановите CRM и службу копий:
       docker compose -p opencrm stop opencrm backup
  2. Отложите текущую базу и создайте пустую:
       docker compose -p opencrm exec db psql -U opencrm -d postgres -c "ALTER DATABASE opencrm RENAME TO opencrm_old_$(date +%Y%m%d%H%M)"
       docker compose -p opencrm exec db createdb -U opencrm opencrm
  3. Отложите текущие вложения:
       docker compose -p opencrm run --rm --no-deps backup sh -c 'mv /app/data/uploads /app/data/uploads-old-$(date +%Y%m%d%H%M)'
  4. Восстановите копию прямо из S3 (скачает, проверит контрольные суммы; база должна быть пустой):
       docker compose -p opencrm run --rm backup node scripts/backup.mjs restore-s3 ${name}
     Без имени файла берётся самая свежая копия. Список копий: ... node scripts/backup.mjs remote-list
  5. Запустите всё обратно: docker compose -p opencrm up -d

Вручную, только инструменты PostgreSQL 17+ и tar:
  tar -xzf ${name}
  createdb имя_базы
  pg_restore --no-owner --no-privileges --exit-on-error --single-transaction --dbname имя_базы ${name.replace(EXT,'')}/database.dump
  Содержимое ${name.replace(EXT,'')}/uploads/ скопируйте в каталог вложений приложения (UPLOAD_DIR).
`;
const defaults=()=>({databaseUrl:process.env.DATABASE_URL,uploads:resolve(process.env.UPLOAD_DIR||join(root,'data/uploads'))});
const pathExists=async path=>{try{await lstat(path);return true}catch(error){if(error.code==='ENOENT')return false;throw error}};
const tool=name=>process.env.PG_BIN&&['pg_dump','pg_restore','psql'].includes(name)?join(process.env.PG_BIN,name):name;
const log=(...items)=>console.log(new Date().toISOString(),...items);
const logError=(...items)=>console.error(new Date().toISOString(),...items);

function run(name,args,{databaseUrl,extraEnv={},input,cwd}={}){
  return new Promise((resolvePromise,reject)=>{
    // Connection strings and keys go through the environment so they never show up in `ps`.
    const env={...process.env,...extraEnv};
    if(databaseUrl){const url=new URL(databaseUrl);env.PGHOST=url.hostname;env.PGPORT=url.port||'5432';env.PGUSER=decodeURIComponent(url.username);env.PGPASSWORD=decodeURIComponent(url.password);env.PGDATABASE=decodeURIComponent(url.pathname.slice(1));}
    const child=spawn(tool(name),args,{env,cwd,stdio:[input===undefined?'ignore':'pipe','pipe','pipe']});
    if(input!==undefined)child.stdin.end(input);
    let output='',errors='';
    child.stdout.on('data',chunk=>{output+=chunk});
    child.stderr.on('data',chunk=>{errors+=chunk});
    child.on('error',error=>reject(error.code==='ENOENT'?new Error(`Не найдена программа ${name}`):error));
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

// Checks an unpacked copy: exactly the files listed in the manifest, matching sizes and SHA-256,
// and a dump pg_restore can read.
async function verifyFolder(folder){
  const base=resolve(folder),manifest=JSON.parse(await readFile(join(base,MANIFEST),'utf8'));
  if(manifest.version!==3||!Array.isArray(manifest.files))throw new Error('Неподдерживаемый формат резервной копии');
  const names=manifest.files.map(item=>item.path);
  if(!names.includes(DUMP)||new Set(names).size!==names.length||names.some(name=>typeof name!=='string'||name!==DUMP&&name!==README&&(!name.startsWith('uploads/')||name.includes('\\')||name.split('/').some(part=>!part||part==='.'||part==='..'))))throw new Error('Некорректный список файлов резервной копии');
  const found=(await regularFiles(base)).filter(name=>name!==MANIFEST);
  if(JSON.stringify(found)!==JSON.stringify([...names].sort()))throw new Error('Состав резервной копии изменён');
  for(const item of manifest.files){
    const file=join(base,item.path),size=(await stat(file)).size;
    if(size!==item.bytes||await checksum(file)!==item.sha256)throw new Error(`Повреждён файл: ${item.path}`);
  }
  const contents=await run('pg_restore',['--list',join(base,DUMP)]);
  if(!/TABLE DATA public users/.test(contents))throw new Error('В дампе нет данных CRM');
  return {createdAt:manifest.createdAt,files:manifest.files.length};
}

// Unpacks a backup file into a new temporary folder and returns the copy's folder inside it.
async function unpack(file){
  const path=resolve(file);
  if(!NAME.test(basename(path)))throw new Error(`Ожидается файл копии opencrm-…${EXT}, получено: ${basename(path)}`);
  const temp=await mkdtemp(join(tmpdir(),'opencrm-unpack-'));
  try{
    // The archive must hold only regular files under one folder named like the file.
    const inner=basename(path).slice(0,-EXT.length);
    const listing=(await run('tar',['-tzvf',path])).split('\n').filter(Boolean);
    if(listing.some(line=>!/^[d-]/.test(line)))throw new Error('В архиве есть ссылки или специальные файлы');
    const entries=(await run('tar',['-tzf',path])).split('\n').filter(Boolean);
    if(entries.some(entry=>entry.replace(/^\.\//,'').split('/')[0]!==inner||entry.split('/').includes('..')))throw new Error('Неожиданная структура архива');
    await run('tar',['-xzf',path,'--no-same-owner','--no-same-permissions','-C',temp]);
    return {temp,folder:join(temp,inner)};
  }catch(error){await rm(temp,{recursive:true,force:true});throw error}
}

export async function verifyBackup(file){
  const {temp,folder}=await unpack(file);
  try{return await verifyFolder(folder)}finally{await rm(temp,{recursive:true,force:true})}
}

export async function createBackup({databaseUrl,uploads,destination=join(root,'backups')}={}){
  databaseUrl=databaseUrl||defaults().databaseUrl;
  uploads=resolve(uploads||defaults().uploads);
  if(!databaseUrl)throw new Error('Не задан DATABASE_URL');
  const parent=resolve(destination);
  await mkdir(parent,{recursive:true,mode:0o700});
  const name=`opencrm-${new Date().toISOString().replace(/[:.]/g,'-')}-${randomBytes(3).toString('hex')}`;
  const work=await mkdtemp(join(parent,'.work-')),folder=join(work,name),file=join(parent,name+EXT);
  try{
    await mkdir(folder,{mode:0o700});
    await run('pg_dump',['--format=custom','--no-owner','--no-privileges','--file',join(folder,DUMP)],{databaseUrl});
    await copyDirectory(uploads,join(folder,'uploads'));
    const createdAt=new Date().toISOString();
    await writeFile(join(folder,README),restoreNotes(name+EXT,createdAt),{mode:0o600});
    const manifest={version:3,createdAt,files:[]};
    for(const path of await regularFiles(folder))manifest.files.push({path,bytes:(await stat(join(folder,path))).size,sha256:await checksum(join(folder,path))});
    await writeFile(join(folder,MANIFEST),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
    await verifyFolder(folder);
    // Written under a temporary name and renamed, so a half-written archive never looks like a backup.
    await run('tar',['-czf',join(work,name+EXT),'-C',work,name]);
    await chmod(join(work,name+EXT),0o600);
    await verifyBackup(join(work,name+EXT));
    await rename(join(work,name+EXT),file);
    return file;
  }finally{await rm(work,{recursive:true,force:true})}
}

export async function restoreBackup(file,{databaseUrl,uploads}={}){
  databaseUrl=databaseUrl||defaults().databaseUrl;
  uploads=resolve(uploads||defaults().uploads);
  if(!databaseUrl)throw new Error('Не задан DATABASE_URL');
  const {temp,folder}=await unpack(file);
  try{
    await verifyFolder(folder);
    const tables=await run('psql',['--no-psqlrc','--tuples-only','--command',"SELECT count(*) FROM information_schema.tables WHERE table_schema='public'"],{databaseUrl});
    if(Number(tables.trim())>0)throw new Error('База для восстановления не пустая. Остановите CRM и восстановите копию в новую пустую базу.');
    if(await pathExists(uploads)&&(await readdir(uploads)).length)throw new Error('Каталог вложений не пустой. Сначала переместите текущие файлы в безопасное место.');
    await run('pg_restore',['--no-owner','--no-privileges','--exit-on-error','--single-transaction','--dbname',decodeURIComponent(new URL(databaseUrl).pathname.slice(1)),join(folder,DUMP)],{databaseUrl});
    await copyDirectory(join(folder,'uploads'),uploads);
    return {uploads};
  }finally{await rm(temp,{recursive:true,force:true})}
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

export async function uploadBackup(file){
  const path=resolve(file),name=basename(path);
  await verifyBackup(path);
  const {env,target}=await remote();
  // --immutable refuses to replace an existing remote file with different contents.
  await run('rclone',['copyto',path,target+name,'--immutable','--retries','5','--low-level-retries','10'],{extraEnv:env});
  // Compare what arrived with the local file (encrypted remotes need --download to compare contents).
  await run('rclone',['check',dirname(path),target,'--one-way','--include',name,...(process.env.BACKUP_S3_ENCRYPTION_PASSWORD?['--download']:[])],{extraEnv:env});
  return target+name;
}

export async function listRemote(){
  const {env,target}=await remote();
  return (await run('rclone',['lsf',target,'--files-only'],{extraEnv:env})).split('\n').filter(name=>NAME.test(name)).sort();
}

async function pruneRemote(){
  const days=Math.max(1,Number(process.env.BACKUP_S3_KEEP_DAYS)||30);
  const {env,target}=await remote();
  // Only backup files of this app are touched, never other files in the folder.
  await run('rclone',['delete',target,'--min-age',`${days}d`,'--include','opencrm-*.tar.gz'],{extraEnv:env});
}

// Downloads a backup file from S3 (the newest one without a name) and verifies it.
export async function downloadBackup(name,destination){
  const {env,target}=await remote();
  if(!name){name=(await listRemote()).at(-1);if(!name)throw new Error('В хранилище нет резервных копий')}
  if(!NAME.test(name))throw new Error(`Некорректное имя копии: ${name}`);
  const file=join(resolve(destination),name);
  if(await pathExists(file))throw new Error(`Файл уже существует: ${file}`);
  await mkdir(resolve(destination),{recursive:true,mode:0o700});
  await run('rclone',['copyto',target+name,file,'--retries','5'],{extraEnv:env});
  try{await verifyBackup(file)}catch(error){await rm(file,{force:true});throw error}
  return file;
}

// Restores straight from S3 into the (empty) database at DATABASE_URL and an empty UPLOAD_DIR.
export async function restoreFromRemote(name,options={}){
  const temp=await mkdtemp(join(tmpdir(),'opencrm-restore-'));
  try{
    const file=await downloadBackup(name,temp);
    log('Копия скачана и проверена:',basename(file));
    return {backup:basename(file),...await restoreBackup(file,options)};
  }finally{await rm(temp,{recursive:true,force:true})}
}

const keepLocal=()=>{const raw=process.env.BACKUP_KEEP;return raw===undefined||raw===''?14:Math.max(0,Number(raw)||0)};

async function localBackups(destination){
  const parent=resolve(destination);
  if(!await pathExists(parent))return [];
  return (await readdir(parent,{withFileTypes:true})).filter(entry=>entry.isFile()&&NAME.test(entry.name)).map(entry=>entry.name).sort();
}

async function prune(destination,keep){
  const backups=await localBackups(destination);
  for(const name of backups.slice(0,Math.max(0,backups.length-keep)))await rm(join(resolve(destination),name),{force:true});
}

// One full cycle. With BACKUP_KEEP=0 nothing stays on this host: a file is removed as soon as S3
// confirms it, and a file that failed to upload is kept and retried on the next run.
// Returns false if anything failed.
export async function backupCycle(destination=join(root,'backups')){
  const keep=keepLocal();
  if(keep===0&&!remoteConfigured()){logError('BACKUP_KEEP=0 без настроенного S3: копии негде хранить');return false}
  let file=null,ok=true;
  try{file=await createBackup({destination});log('Копия создана:',basename(file),`${Math.round((await stat(file)).size/1024)} КБ`)}
  catch(error){ok=false;logError('Резервная копия не создана:',error.message)}
  if(remoteConfigured()){
    const pending=keep===0?await localBackups(destination):file?[basename(file)]:[];
    for(const name of pending){
      try{
        const where=await uploadBackup(join(resolve(destination),name));
        log('Копия выгружена и сверена:',where);
        if(keep===0){await rm(join(resolve(destination),name),{force:true});log('Локальная копия удалена:',name)}
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
  const at=process.env.BACKUP_AT,hours=Math.max(1,Number(process.env.BACKUP_INTERVAL_HOURS)||24),keep=keepLocal();
  const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  console.log(`Резервные копии ${at?`каждый день в ${at} (${zone})`:`каждые ${hours} ч`}, ${keep?`на сервере храним ${keep} в ${resolve(destination)}`:'на сервере не храним'}${remoteConfigured()?`, хранилище S3: ${process.env.BACKUP_S3_BUCKET}/${process.env.BACKUP_S3_PREFIX||'opencrm'}, ${Math.max(1,Number(process.env.BACKUP_S3_KEEP_DAYS)||30)} дн.`:''}`);
  // Without a fixed time the first copy waits a few minutes: the app creates the schema on its first start.
  if(!at)await new Promise(done=>setTimeout(done,5*60*1000));
  for(;;){
    if(at){
      const wait=msUntil(at);
      log('Следующая копия:',new Date(Date.now()+wait).toLocaleString('ru-RU',{timeZone:zone}));
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
    else if(action==='verify'){if(!path)throw new Error('Укажите файл копии');console.log(await verifyBackup(path))}
    else if(action==='restore'){if(!path)throw new Error('Укажите файл копии');console.log(await restoreBackup(path))}
    else if(action==='schedule')await schedule(path);
    else if(action==='now'){if(!await backupCycle(path))process.exitCode=1}
    else if(action==='upload'){if(!path)throw new Error('Укажите файл копии');console.log(await uploadBackup(path))}
    else if(action==='download')console.log(await downloadBackup(path,process.argv[4]||join(root,'backups')));
    else if(action==='restore-s3')console.log(await restoreFromRemote(path));
    else if(action==='remote-list')console.log((await listRemote()).join('\n')||'В хранилище копий нет');
    else throw new Error('Использование: backup.mjs create [каталог] | verify <файл> | restore <файл> | schedule [каталог] | now [каталог] | upload <файл> | remote-list | download [имя] [каталог] | restore-s3 [имя]');
  }catch(error){console.error(error.message);process.exitCode=1}
}
