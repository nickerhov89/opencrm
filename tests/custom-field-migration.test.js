import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {createDb} from '../server/db.js';

test('старые дополнительные поля и значения сохраняются при добавлении типа «Список»',()=>{
  const folder=mkdtempSync(join(tmpdir(),'opencrm-fields-')),path=join(folder,'legacy.db');
  try{
    const old=new Database(path);
    old.exec("CREATE TABLE custom_fields (id INTEGER PRIMARY KEY,entity_type TEXT NOT NULL,name TEXT NOT NULL,field_type TEXT NOT NULL CHECK(field_type IN ('text','number','date','url')),sort_order INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);CREATE TABLE custom_field_values (field_id INTEGER NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,entity_id INTEGER NOT NULL,value TEXT NOT NULL DEFAULT '',PRIMARY KEY(field_id,entity_id));INSERT INTO custom_fields (id,entity_type,name,field_type) VALUES (7,'deal','Старое поле','text');INSERT INTO custom_field_values (field_id,entity_id,value) VALUES (7,42,'Старое значение')");
    old.close();
    const db=createDb(path);
    assert.equal(db.prepare('SELECT value FROM custom_field_values WHERE field_id=7 AND entity_id=42').get().value,'Старое значение');
    assert.equal(db.prepare('SELECT options_json FROM custom_fields WHERE id=7').get().options_json,'[]');
    db.prepare('INSERT INTO custom_fields (entity_type,name,field_type,options_json) VALUES (?,?,?,?)').run('deal','Контур','select','["RU","EN"]');
    assert.deepEqual(db.pragma('foreign_key_check'),[]);
    db.close();
  }finally{rmSync(folder,{recursive:true,force:true})}
});
