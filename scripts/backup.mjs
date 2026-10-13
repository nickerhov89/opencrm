import Database from 'better-sqlite3';
import {createHash,randomBytes} from 'node:crypto';
import {constants,createReadStream,existsSync} from 'node:fs';
import {chmod,copyFile,lstat,mkdir,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const defaultPaths=()=>({database:resolve(process.env.DATABASE_PATH||join(root,'data/opencrm.db')),uploads:resolve(process.env.UPLOAD_DIR||join(root,'data/uploads'))});
const pathExists=async path=>{try{await lstat(path);return true}catch(error){if(error.code==='ENOENT')return false;throw error}};

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
  if(manifest.version!==1||!Array.isArray(manifest.files))throw new Error('Неподдерживаемый формат резервной копии');
  const names=manifest.files.map(item=>item.path);
  if(!names.includes('opencrm.db')||new Set(names).size!==names.length||names.some(name=>typeof name!=='string'||name!=='opencrm.db'&&(!name.startsWith('uploads/')||name.includes('\\')||name.split('/').some(part=>!part||part==='.'||part==='..'))))throw new Error('Некорректный список файлов резервной копии');
  const found=(await regularFiles(base)).filter(name=>name!=='manifest.json');
  if(JSON.stringify(found)!==JSON.stringify([...names].sort()))throw new Error('Состав резервной копии изменён');
  for(const item of manifest.files){
    const file=join(base,item.path),size=(await stat(file)).size;
    if(size!==item.bytes||await checksum(file)!==item.sha256)throw new Error(`Повреждён файл: ${item.path}`);
  }
  const db=new Database(join(base,'opencrm.db'),{readonly:true,fileMustExist:true});
  try{if(db.pragma('integrity_check')[0]?.integrity_check!=='ok')throw new Error('SQLite: проверка целостности не пройдена')}
  finally{db.close()}
  return {createdAt:manifest.createdAt,files:manifest.files.length};
}

export async function createBackup({database,uploads,destination=join(root,'backups')}={}){
  database=resolve(database||defaultPaths().database);
  uploads=resolve(uploads||defaultPaths().uploads);
  if(!existsSync(database))throw new Error(`База не найдена: ${database}`);
  const parent=resolve(destination);
  await mkdir(parent,{recursive:true,mode:0o700});
  const folder=join(parent,`opencrm-${new Date().toISOString().replace(/[:.]/g,'-')}-${randomBytes(3).toString('hex')}`);
  await mkdir(folder,{mode:0o700});
  try{
    const source=new Database(database,{readonly:true,fileMustExist:true});
    try{await source.backup(join(folder,'opencrm.db'))}finally{source.close()}
    const snapshot=new Database(join(folder,'opencrm.db'));
    try{snapshot.pragma('journal_mode = DELETE')}finally{snapshot.close()}
    await copyDirectory(uploads,join(folder,'uploads'));
    const files=(await regularFiles(folder)).map(path=>path);
    const manifest={version:1,createdAt:new Date().toISOString(),files:[]};
    for(const path of files)manifest.files.push({path,bytes:(await stat(join(folder,path))).size,sha256:await checksum(join(folder,path))});
    await writeFile(join(folder,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
    await verifyBackup(folder);
    return folder;
  }catch(error){await rm(folder,{recursive:true,force:true});throw error}
}

export async function restoreBackup(folder,{database,uploads}={}){
  const base=resolve(folder);
  await verifyBackup(base);
  database=resolve(database||defaultPaths().database);
  uploads=resolve(uploads||defaultPaths().uploads);
  if(await pathExists(database)||await pathExists(uploads))throw new Error('Путь восстановления уже существует. Остановите CRM и сначала переместите текущие данные в безопасное место.');
  await mkdir(dirname(database),{recursive:true,mode:0o700});
  await mkdir(dirname(uploads),{recursive:true,mode:0o700});
  let createdUploads=false,createdDatabase=false;
  try{
    await mkdir(uploads,{mode:0o700});
    createdUploads=true;
    await copyDirectory(join(base,'uploads'),uploads);
    await copyFile(join(base,'opencrm.db'),database,constants.COPYFILE_EXCL);
    createdDatabase=true;
    await chmod(database,0o600);
    const db=new Database(database,{readonly:true,fileMustExist:true});
    try{if(db.pragma('integrity_check')[0]?.integrity_check!=='ok')throw new Error('Восстановленная база повреждена')}
    finally{db.close()}
  }catch(error){if(createdDatabase)await rm(database,{force:true});if(createdUploads)await rm(uploads,{recursive:true,force:true});throw error}
  return {database,uploads};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [action,path]=process.argv.slice(2);
  try{
    if(action==='create')console.log(await createBackup({destination:path}));
    else if(action==='verify'){if(!path)throw new Error('Укажите каталог копии');console.log(await verifyBackup(path))}
    else if(action==='restore'){if(!path)throw new Error('Укажите каталог копии');console.log(await restoreBackup(path))}
    else throw new Error('Использование: backup.mjs create [каталог] | verify <копия> | restore <копия>');
  }catch(error){console.error(error.message);process.exitCode=1}
}
