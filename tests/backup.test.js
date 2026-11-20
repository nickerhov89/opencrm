import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {createBackup,restoreBackup,verifyBackup} from '../scripts/backup.mjs';

// Needs a real PostgreSQL server and pg_dump/pg_restore/psql, e.g. inside the compose stack:
//   TEST_DATABASE_URL=postgresql://opencrm:...@db:5432/postgres node --test tests/backup.test.js
// The test creates and drops its own two databases there.
const adminUrl=process.env.TEST_DATABASE_URL;

test('резервная копия Postgres и вложений проверяется и восстанавливается в пустую базу',{skip:!adminUrl&&'TEST_DATABASE_URL не задан'},async()=>{
  const suffix=Date.now().toString(36),sourceName=`opencrm_backup_src_${suffix}`,targetName=`opencrm_backup_dst_${suffix}`;
  const urlFor=name=>{const url=new URL(adminUrl);url.pathname='/'+name;return url.toString()};
  const admin=new pg.Client({connectionString:adminUrl});await admin.connect();
  const dir=mkdtempSync(join(tmpdir(),'opencrm-backup-test-'));
  try{
    await admin.query(`CREATE DATABASE ${sourceName}`);await admin.query(`CREATE DATABASE ${targetName}`);
    const {createDb}=await import('../server/db.js');
    const source=await createDb({url:urlFor(sourceName)});
    await source.prepare("INSERT INTO users (name,email,password_hash) VALUES (?,?,'x:y')").run('Test client','client@example.test');
    await source.close();
    const uploads=join(dir,'uploads');
    await mkdir(join(uploads,'nested'),{recursive:true});
    await writeFile(join(uploads,'nested','brief.txt'),'Synthetic attachment');
    const backup=await createBackup({databaseUrl:urlFor(sourceName),uploads,destination:join(dir,'backups')});
    assert.equal((await verifyBackup(backup)).files,3,'дамп, вложение и инструкция по восстановлению');
    const target={databaseUrl:urlFor(targetName),uploads:join(dir,'restored-uploads')};
    await restoreBackup(backup,target);
    const restored=new pg.Client({connectionString:target.databaseUrl});await restored.connect();
    try{assert.equal((await restored.query('SELECT name FROM users')).rows[0].name,'Test client')}finally{await restored.end()}
    assert.equal(await readFile(join(target.uploads,'nested','brief.txt'),'utf8'),'Synthetic attachment');
    await assert.rejects(()=>restoreBackup(backup,target),/не пустая/);
    await writeFile(join(backup,'uploads','nested','brief.txt'),'Corrupted');
    await assert.rejects(()=>verifyBackup(backup),/Повреждён файл/);
  }finally{
    await admin.query(`DROP DATABASE IF EXISTS ${sourceName} WITH (FORCE)`).catch(()=>{});
    await admin.query(`DROP DATABASE IF EXISTS ${targetName} WITH (FORCE)`).catch(()=>{});
    await admin.end();rmSync(dir,{recursive:true,force:true});
  }
});
