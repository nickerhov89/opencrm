import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {createBackup,restoreBackup,verifyBackup} from '../scripts/backup.mjs';

test('резервная копия сохраняет открытую SQLite и вложения и восстанавливается отдельно',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'opencrm-backup-test-'));
  const database=join(dir,'source','opencrm.db'),uploads=join(dir,'source','uploads');
  await mkdir(join(uploads,'nested'),{recursive:true});
  await writeFile(join(uploads,'nested','brief.txt'),'Synthetic attachment');
  const source=new Database(database);
  try{
    source.pragma('journal_mode = WAL');
    source.exec('CREATE TABLE contacts (id INTEGER PRIMARY KEY,name TEXT NOT NULL)');
    source.prepare('INSERT INTO contacts (name) VALUES (?)').run('Test client');
    const backup=await createBackup({database,uploads,destination:join(dir,'backups')});
    assert.equal((await verifyBackup(backup)).files,2);
    const target={database:join(dir,'restored','opencrm.db'),uploads:join(dir,'restored','uploads')};
    await restoreBackup(backup,target);
    const restored=new Database(target.database,{readonly:true});
    try{assert.equal(restored.prepare('SELECT name FROM contacts').get().name,'Test client')}
    finally{restored.close()}
    assert.equal(await readFile(join(target.uploads,'nested','brief.txt'),'utf8'),'Synthetic attachment');
    await assert.rejects(()=>restoreBackup(backup,target),/уже существует/);
    await writeFile(join(backup,'uploads','nested','brief.txt'),'Corrupted');
    await assert.rejects(()=>verifyBackup(backup),/Повреждён файл/);
  }finally{source.close();rmSync(dir,{recursive:true,force:true})}
});
