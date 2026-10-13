import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function createDb(path = process.env.DATABASE_PATH || './data/opencrm.db') {
  const file = path === ':memory:' ? path : resolve(path);
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin','member')), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS user_groups (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS deal_list_columns (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, columns_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS deal_saved_filters (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, filter_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id,name));
    CREATE TABLE IF NOT EXISTS entity_list_columns (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('contact','company','all')), columns_json TEXT NOT NULL, PRIMARY KEY(user_id,kind));
    CREATE TABLE IF NOT EXISTS pipelines (id INTEGER PRIMARY KEY, name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS deal_card_layouts (pipeline_id INTEGER PRIMARY KEY REFERENCES pipelines(id) ON DELETE CASCADE, fields_json TEXT NOT NULL, show_avatar INTEGER NOT NULL DEFAULT 1 CHECK(show_avatar IN (0,1)));
    CREATE TABLE IF NOT EXISTS stages (id INTEGER PRIMARY KEY, pipeline_id INTEGER NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE, name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#dce7fb', sort_order INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'active' CHECK(kind IN ('active','won','lost')));
    CREATE TABLE IF NOT EXISTS stage_automations (stage_id INTEGER PRIMARY KEY REFERENCES stages(id) ON DELETE CASCADE, task_title TEXT NOT NULL, due_days INTEGER NOT NULL DEFAULT 0 CHECK(due_days BETWEEN 0 AND 365));
    CREATE TABLE IF NOT EXISTS companies (id INTEGER PRIMARY KEY, name TEXT NOT NULL, owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL, website TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, deleted_at TEXT);
    CREATE TABLE IF NOT EXISTS contacts (id INTEGER PRIMARY KEY, name TEXT NOT NULL, company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL, owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL, phone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', position TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, deleted_at TEXT);
    CREATE TABLE IF NOT EXISTS deals (id INTEGER PRIMARY KEY, name TEXT NOT NULL, stage_id INTEGER NOT NULL REFERENCES stages(id), company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL, contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL, owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL, amount INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', loss_reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, deleted_at TEXT);
    CREATE TABLE IF NOT EXISTS deal_contacts (deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE, contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(deal_id,contact_id));
    CREATE TABLE IF NOT EXISTS inbox_leads (id INTEGER PRIMARY KEY, pipeline_id INTEGER NOT NULL REFERENCES pipelines(id), title TEXT NOT NULL, contact_name TEXT NOT NULL DEFAULT '', company_name TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', website TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', message TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')), deal_id INTEGER REFERENCES deals(id) ON DELETE SET NULL, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, resolved_at TEXT);
    CREATE TABLE IF NOT EXISTS lead_forms (id INTEGER PRIMARY KEY, pipeline_id INTEGER NOT NULL REFERENCES pipelines(id), title TEXT NOT NULL, token TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL, task_type TEXT NOT NULL DEFAULT 'Связаться', due_at TEXT, completed_at TEXT, completion_result TEXT NOT NULL DEFAULT '', deal_id INTEGER REFERENCES deals(id) ON DELETE CASCADE, contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE, company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE, owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS deal_communications (id INTEGER PRIMARY KEY, deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, kind TEXT NOT NULL CHECK(kind IN ('call','email','message')), direction TEXT NOT NULL CHECK(direction IN ('incoming','outgoing')), subject TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS entity_notes (id INTEGER PRIMARY KEY, entity_type TEXT NOT NULL CHECK(entity_type IN ('contact','company')), entity_id INTEGER NOT NULL, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS entity_activity (id INTEGER PRIMARY KEY, entity_type TEXT NOT NULL CHECK(entity_type IN ('contact','company')), entity_id INTEGER NOT NULL, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, event TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY, deal_id INTEGER REFERENCES deals(id) ON DELETE CASCADE, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, event TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS custom_fields (id INTEGER PRIMARY KEY, entity_type TEXT NOT NULL CHECK(entity_type IN ('deal','contact','company')), name TEXT NOT NULL, field_type TEXT NOT NULL CHECK(field_type IN ('text','number','date','url','select')), options_json TEXT NOT NULL DEFAULT '[]', sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS custom_field_values (field_id INTEGER NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE, entity_id INTEGER NOT NULL, value TEXT NOT NULL DEFAULT '', PRIMARY KEY(field_id,entity_id));
    CREATE TABLE IF NOT EXISTS attachments (id INTEGER PRIMARY KEY, entity_type TEXT NOT NULL CHECK(entity_type IN ('deal','contact','company')), entity_id INTEGER NOT NULL, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, filename TEXT NOT NULL, mime_type TEXT NOT NULL, byte_size INTEGER NOT NULL, stored_name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(stage_id);
    CREATE INDEX IF NOT EXISTS idx_deals_contact_live ON deals(contact_id,deleted_at);
    CREATE INDEX IF NOT EXISTS idx_deals_company_live ON deals(company_id,deleted_at);
    CREATE INDEX IF NOT EXISTS idx_deal_contacts_contact ON deal_contacts(contact_id,deal_id);
    CREATE INDEX IF NOT EXISTS idx_inbox_pipeline_status ON inbox_leads(pipeline_id,status,id);
    CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_at, completed_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_deal ON tasks(deal_id, completed_at);
    CREATE INDEX IF NOT EXISTS idx_activity_deal ON activity(deal_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_deal_communications ON deal_communications(deal_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_entity_notes ON entity_notes(entity_type, entity_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_entity_activity ON entity_activity(entity_type, entity_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_custom_fields_type ON custom_fields(entity_type, sort_order);
    CREATE INDEX IF NOT EXISTS idx_attachments_entity ON attachments(entity_type, entity_id, created_at);
  `);
  if(!db.prepare('PRAGMA table_info(deal_card_layouts)').all().some(column=>column.name==='show_avatar'))db.exec('ALTER TABLE deal_card_layouts ADD COLUMN show_avatar INTEGER NOT NULL DEFAULT 1 CHECK(show_avatar IN (0,1))');
  if (!db.prepare('PRAGMA table_info(custom_fields)').all().some(column => column.name === 'options_json')) {
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(`CREATE TABLE custom_fields_new (id INTEGER PRIMARY KEY, entity_type TEXT NOT NULL CHECK(entity_type IN ('deal','contact','company')), name TEXT NOT NULL, field_type TEXT NOT NULL CHECK(field_type IN ('text','number','date','url','select')), options_json TEXT NOT NULL DEFAULT '[]', sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
        db.exec(`INSERT INTO custom_fields_new (id,entity_type,name,field_type,sort_order,created_at) SELECT id,entity_type,name,field_type,sort_order,created_at FROM custom_fields`);
        db.exec('DROP TABLE custom_fields');
        db.exec('ALTER TABLE custom_fields_new RENAME TO custom_fields');
        db.exec('CREATE INDEX idx_custom_fields_type ON custom_fields(entity_type,sort_order)');
      })();
    } finally { db.pragma('foreign_keys = ON'); }
  }
  if (!db.prepare('PRAGMA table_info(tasks)').all().some(column => column.name === 'task_type')) {
    db.exec("ALTER TABLE tasks ADD COLUMN task_type TEXT NOT NULL DEFAULT 'Связаться'");
  }
  if (!db.prepare('PRAGMA table_info(tasks)').all().some(column => column.name === 'completion_result')) {
    db.exec("ALTER TABLE tasks ADD COLUMN completion_result TEXT NOT NULL DEFAULT ''");
  }
  if (!db.prepare('PRAGMA table_info(tasks)').all().some(column => column.name === 'company_id')) {
    db.exec('ALTER TABLE tasks ADD COLUMN company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE');
  }
  if (!db.prepare('PRAGMA table_info(tasks)').all().some(column => column.name === 'deleted_at')) {
    db.exec('ALTER TABLE tasks ADD COLUMN deleted_at TEXT');
  }
  if (!db.prepare('PRAGMA table_info(tasks)').all().some(column => column.name === 'duration_minutes')) {
    db.exec('ALTER TABLE tasks ADD COLUMN duration_minutes INTEGER NOT NULL DEFAULT 0');
  }
  if (!db.prepare('PRAGMA table_info(tasks)').all().some(column => column.name === 'all_day')) {
    db.exec('ALTER TABLE tasks ADD COLUMN all_day INTEGER NOT NULL DEFAULT 0');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_company ON tasks(company_id, completed_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_contact_live ON tasks(contact_id,completed_at,deleted_at)');
  if (!db.prepare('PRAGMA table_info(deals)').all().some(column => column.name === 'deleted_at')) {
    db.exec('ALTER TABLE deals ADD COLUMN deleted_at TEXT');
  }
  if (!db.prepare('PRAGMA table_info(deals)').all().some(column => column.name === 'loss_reason')) {
    db.exec("ALTER TABLE deals ADD COLUMN loss_reason TEXT NOT NULL DEFAULT ''");
  }
  if (!db.prepare('PRAGMA table_info(notes)').all().some(column => column.name === 'pinned')) {
    db.exec('ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1))');
  }
  db.exec('INSERT OR IGNORE INTO deal_contacts (deal_id,contact_id) SELECT d.id,d.contact_id FROM deals d JOIN contacts c ON c.id=d.contact_id WHERE d.contact_id IS NOT NULL');
  for (const table of ['contacts','companies']) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === 'deleted_at')) db.exec(`ALTER TABLE ${table} ADD COLUMN deleted_at TEXT`);
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === 'tags')) db.exec(`ALTER TABLE ${table} ADD COLUMN tags TEXT NOT NULL DEFAULT ''`);
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === 'owner_id')) db.exec(`ALTER TABLE ${table} ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL`);
  }
  if (!db.prepare('PRAGMA table_info(companies)').all().some(column => column.name === 'address')) {
    db.exec("ALTER TABLE companies ADD COLUMN address TEXT NOT NULL DEFAULT ''");
  }
  const userColumns=db.prepare('PRAGMA table_info(users)').all().map(column=>column.name);
  if(!userColumns.includes('deal_access'))db.exec("ALTER TABLE users ADD COLUMN deal_access TEXT NOT NULL DEFAULT 'all' CHECK(deal_access IN ('all','own'))");
  if(!userColumns.includes('task_access'))db.exec("ALTER TABLE users ADD COLUMN task_access TEXT NOT NULL DEFAULT 'all' CHECK(task_access IN ('all','own'))");
  if(!userColumns.includes('contact_access'))db.exec("ALTER TABLE users ADD COLUMN contact_access TEXT NOT NULL DEFAULT 'all' CHECK(contact_access IN ('all','own'))");
  if(!userColumns.includes('company_access'))db.exec("ALTER TABLE users ADD COLUMN company_access TEXT NOT NULL DEFAULT 'all' CHECK(company_access IN ('all','own'))");
  if(!userColumns.includes('group_id'))db.exec('ALTER TABLE users ADD COLUMN group_id INTEGER REFERENCES user_groups(id) ON DELETE SET NULL');
  if(!userColumns.includes('permissions_json'))db.exec("ALTER TABLE users ADD COLUMN permissions_json TEXT NOT NULL DEFAULT '{}'");
  if (!db.prepare('SELECT id FROM pipelines LIMIT 1').get()) {
    const pipeline = db.prepare('INSERT INTO pipelines (name) VALUES (?)').run('Воронка — новые лиды');
    const stage = db.prepare('INSERT INTO stages (pipeline_id,name,color,sort_order,kind) VALUES (?,?,?,?,?)');
    [
      ['Новый лид','#f6ef9c','active'], ['Взят в работу','#f5e768','active'],
      ['Лид квалифицирован','#ecd679','active'], ['Встреча назначена','#bcd3f6','active'],
      ['Встреча проведена + КП отправлено','#a8d8e4','active'], ['Переговоры','#b9d5ef','active'],
      ['Отправлен счёт','#cdbfe9','active'], ['Согласование договора','#b7d9b1','active'],
      ['Успешно реализовано','#a9ddb1','won'], ['Закрыто и не реализовано','#e8b7b7','lost']
    ].forEach(([name,color,kind],index) => stage.run(pipeline.lastInsertRowid,name,color,index,kind));
  }
  return db;
}
