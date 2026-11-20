import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';

// OpenCRM stores its data in PostgreSQL. In production DATABASE_URL points at a Postgres server
// (the compose file starts one next to the app). Without DATABASE_URL — tests, the demo and quick
// local runs — an embedded Postgres (PGlite) is used, in memory or in PGLITE_DIR.
//
// The interface stays close to a prepared-statement API: db.prepare(sql).get/all/run(...params),
// all of them async. Placeholders are written as "?" and translated to $1..$n.

const tablesWithId = new Set(['users','user_groups','deal_saved_filters','pipelines','stages','companies','contacts','deals','inbox_leads','lead_forms','api_keys','webhook_endpoints','webhook_events','webhook_deliveries','tasks','notes','deal_communications','entity_notes','entity_activity','activity','custom_fields','attachments','audit_log']);

// Rewrites the few SQLite-isms that are still convenient to write into Postgres syntax.
export function translate(sql) {
  let out = '', index = 0, quote = null;
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    if (quote) { out += char; if (char === quote) quote = null; continue; }
    if (char === "'" || char === '"') { quote = char; out += char; continue; }
    if (char === '?') { out += `$${++index}`; continue; }
    out += char;
  }
  let ignore = false;
  // "? IS NULL" gives Postgres no hint about the parameter type.
  out = out.replace(/(\$\d+)(?=\s+IS\s+(?:NOT\s+)?NULL\b)/gi, '$1::text')
    // SQLite "a IS ?" is a NULL-safe comparison.
    .replace(/\bIS\s+NOT\s+(\$\d+)/gi, 'IS DISTINCT FROM $1').replace(/\bIS\s+(\$\d+)/gi, 'IS NOT DISTINCT FROM $1').replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, () => { ignore = true; return 'INSERT INTO'; })
    .replace(/\bCURRENT_TIMESTAMP\b/g, 'now_text()')
    .replace(/\bNOT\s+LIKE\b/gi, 'NOT ILIKE')
    .replace(/(?<!NOT\s|I)\bLIKE\b/gi, 'ILIKE')
    .replace(/((?:\b[a-z_][\w]*\.)?\b[a-z_][\w]*)\s+COLLATE\s+NOCASE\b/gi, 'lower($1)')
    .replace(/\bjson_group_object\(/gi, 'json_object_agg(')
    .replace(/\bgroup_concat\(/gi, 'string_agg(')
    .replace(/\bjulianday\(/gi, 'sqlite_julianday(')
    .replace(/\bdatetime\(/gi, 'sqlite_datetime(')
    .replace(/(?<![\w.])date\(/gi, 'sqlite_date(');
  if (ignore) out = out.replace(/(\s+RETURNING\b[\s\S]*)?$/i, match => ` ON CONFLICT DO NOTHING${match}`);
  return out;
}

const flatten = params => {
  const list = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
  if (list.some(value => value instanceof Promise)) throw new Error('SQL parameter is a Promise: a call is missing await');
  return list;
};

class Statement {
  constructor(db, sql) {
    this.db = db;
    this.sql = translate(sql);
    const insert = /^\s*INSERT\s+INTO\s+([a-z_]+)/i.exec(this.sql);
    this.runSql = insert && tablesWithId.has(insert[1].toLowerCase()) && !/\bRETURNING\b/i.test(this.sql) ? `${this.sql} RETURNING id` : this.sql;
  }
  async get(...params) { return (await this.db.query(this.sql, flatten(params))).rows[0]; }
  async all(...params) { return (await this.db.query(this.sql, flatten(params))).rows; }
  async run(...params) {
    const result = await this.db.query(this.runSql, flatten(params));
    return { changes: result.rowCount ?? result.affectedRows ?? 0, lastInsertRowid: result.rows?.[0]?.id };
  }
}

const slowQueryMs = Number(process.env.OPENCRM_SLOW_SQL_MS) || 0;
const parseBigint = value => value === null ? null : Number(value);

class Database {
  constructor(driver) { this.driver = driver; this.scope = new AsyncLocalStorage(); this.depth = 0; }
  connection() { return this.scope.getStore()?.client || this.driver; }
  async query(sql, params = []) {
    const started = Date.now();
    try { return await this.connection().query(sql, params); }
    catch (error) { if (process.env.OPENCRM_DEBUG_SQL === '1') console.error('SQL error:', error.message, sql, params); throw error; }
    finally { const ms = Date.now() - started; if (slowQueryMs && ms >= slowQueryMs) console.warn(`Slow SQL ${ms} ms:`, sql.replace(/\s+/g, ' ').slice(0, 2000)); }
  }
  prepare(sql) { return new Statement(this, sql); }
  exec(sql) { return this.connection().exec(sql); }
  // db.transaction(fn) returns an async function; queries made inside fn (at any depth) use the
  // transaction's connection. Nested calls become savepoints.
  transaction(fn) {
    return async (...args) => {
      const current = this.scope.getStore();
      if (current) {
        const name = `sp_${++current.savepoints}`;
        await current.client.query(`SAVEPOINT ${name}`);
        try { const result = await fn(...args); await current.client.query(`RELEASE SAVEPOINT ${name}`); return result; }
        catch (error) { await current.client.query(`ROLLBACK TO SAVEPOINT ${name}`); throw error; }
      }
      return this.driver.transaction(client => this.scope.run({ client, savepoints: 0 }, () => fn(...args)));
    };
  }
  close() { return this.driver.close(); }
}

async function pgDriver(url) {
  const types = new pg.TypeOverrides();
  types.setTypeParser(20, parseBigint);
  types.setTypeParser(1700, parseBigint);
  types.setTypeParser(114, value => value);
  types.setTypeParser(3802, value => value);
  const pool = new pg.Pool({ connectionString: url, types, max: Number(process.env.DATABASE_POOL_SIZE) || 10, options: '-c TimeZone=UTC' });
  pool.on('error', error => console.error('Postgres pool:', error.message));
  const wrap = client => ({
    query: (sql, params) => client.query(sql, params),
    exec: sql => client.query(sql)
  });
  return {
    kind: 'postgres',
    ...wrap(pool),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(wrap(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally { client.release(); }
    },
    close: () => pool.end()
  };
}

async function pgliteDriver(dataDir) {
  const { PGlite } = await import('@electric-sql/pglite');
  const lite = await PGlite.create(dataDir || 'memory://', { parsers: { 20: parseBigint, 1700: parseBigint, 114: value => value, 3802: value => value } });
  await lite.exec("SET TIME ZONE 'UTC'");
  const wrap = target => ({
    query: async (sql, params) => { const result = await target.query(sql, params); return { rows: result.rows, rowCount: result.affectedRows ?? 0 }; },
    exec: sql => target.exec(sql)
  });
  return {
    kind: 'pglite',
    ...wrap(lite),
    transaction: fn => lite.transaction(tx => fn(wrap(tx))),
    close: () => lite.close()
  };
}

const schema = String.raw`
CREATE OR REPLACE FUNCTION now_text() RETURNS text LANGUAGE sql STABLE AS $$ SELECT to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS') $$;
CREATE OR REPLACE FUNCTION sqlite_ts(value text) RETURNS timestamp LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF value IS NULL OR btrim(value) = '' THEN RETURN NULL; END IF;
  IF lower(btrim(value)) = 'now' THEN RETURN timezone('UTC', now()); END IF;
  -- Stored values are UTC: either 'YYYY-MM-DD HH:MM:SS' or ISO strings with a Z suffix.
  RETURN CASE WHEN value ~ '(Z|[+-]\d\d(:?\d\d)?)$' THEN timezone('UTC', value::timestamptz) ELSE value::timestamp END;
EXCEPTION WHEN others THEN RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION sqlite_datetime(value text, modifier text DEFAULT NULL) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT to_char(sqlite_ts(value) + COALESCE(modifier::interval, interval '0'), 'YYYY-MM-DD HH24:MI:SS')
$$;
CREATE OR REPLACE FUNCTION sqlite_date(value text, modifier text DEFAULT NULL) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT to_char(sqlite_ts(value) + COALESCE(modifier::interval, interval '0'), 'YYYY-MM-DD')
$$;
CREATE OR REPLACE FUNCTION sqlite_julianday(value text) RETURNS double precision LANGUAGE sql STABLE AS $$
  SELECT extract(epoch FROM sqlite_ts(value))::double precision / 86400 + 2440587.5
$$;
DROP FUNCTION IF EXISTS contains_search(text, text);
CREATE FUNCTION contains_search(raw text, wanted text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT strpos(lower(COALESCE(raw, '')), lower(COALESCE(wanted, ''))) > 0
$$;
DROP FUNCTION IF EXISTS has_entity_tag(text, text);
CREATE FUNCTION has_entity_tag(raw text, wanted text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT EXISTS (SELECT 1 FROM unnest(string_to_array(COALESCE(raw, ''), ',')) tag WHERE lower(btrim(tag)) = lower(btrim(COALESCE(wanted, ''))))
$$;

CREATE TABLE IF NOT EXISTS user_groups (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT now_text());
CREATE TABLE IF NOT EXISTS users (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin','member')), created_at TEXT NOT NULL DEFAULT now_text(),
  deal_access TEXT NOT NULL DEFAULT 'all' CHECK(deal_access IN ('all','own')), task_access TEXT NOT NULL DEFAULT 'all' CHECK(task_access IN ('all','own')),
  contact_access TEXT NOT NULL DEFAULT 'all' CHECK(contact_access IN ('all','own')), company_access TEXT NOT NULL DEFAULT 'all' CHECK(company_access IN ('all','own')),
  group_id BIGINT REFERENCES user_groups(id) ON DELETE SET NULL, permissions_json TEXT NOT NULL DEFAULT '{}',
  disabled_at TEXT, totp_secret TEXT, totp_pending_secret TEXT, totp_last_counter BIGINT NOT NULL DEFAULT -1, password_changed_at TEXT
);
CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at BIGINT NOT NULL, created_at BIGINT NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS trusted_devices (token_hash TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_trusted_devices_user ON trusted_devices(user_id);
CREATE TABLE IF NOT EXISTS deal_list_columns (user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, columns_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS deal_saved_filters (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, filter_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT now_text(), UNIQUE(user_id,name));
CREATE TABLE IF NOT EXISTS entity_list_columns (user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('contact','company','all')), columns_json TEXT NOT NULL, PRIMARY KEY(user_id,kind));
CREATE TABLE IF NOT EXISTS pipelines (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, name TEXT NOT NULL, sort_order BIGINT NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS deal_card_layouts (pipeline_id BIGINT PRIMARY KEY REFERENCES pipelines(id) ON DELETE CASCADE, fields_json TEXT NOT NULL, show_avatar INTEGER NOT NULL DEFAULT 1 CHECK(show_avatar IN (0,1)));
CREATE TABLE IF NOT EXISTS stages (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, pipeline_id BIGINT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE, name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#dce7fb', sort_order BIGINT NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'active' CHECK(kind IN ('active','won','lost')));
CREATE TABLE IF NOT EXISTS stage_automations (stage_id BIGINT PRIMARY KEY REFERENCES stages(id) ON DELETE CASCADE, task_title TEXT NOT NULL, due_days INTEGER NOT NULL DEFAULT 0 CHECK(due_days BETWEEN 0 AND 365));
CREATE TABLE IF NOT EXISTS companies (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, name TEXT NOT NULL, owner_id BIGINT REFERENCES users(id) ON DELETE SET NULL, website TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT now_text(), deleted_at TEXT);
CREATE TABLE IF NOT EXISTS contacts (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, name TEXT NOT NULL, company_id BIGINT REFERENCES companies(id) ON DELETE SET NULL, owner_id BIGINT REFERENCES users(id) ON DELETE SET NULL, phone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', position TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT now_text(), deleted_at TEXT);
CREATE TABLE IF NOT EXISTS deals (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, name TEXT NOT NULL, stage_id BIGINT NOT NULL REFERENCES stages(id), company_id BIGINT REFERENCES companies(id) ON DELETE SET NULL, contact_id BIGINT REFERENCES contacts(id) ON DELETE SET NULL, owner_id BIGINT REFERENCES users(id) ON DELETE SET NULL, amount BIGINT NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', loss_reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT now_text(), updated_at TEXT NOT NULL DEFAULT now_text(), deleted_at TEXT);
CREATE TABLE IF NOT EXISTS deal_contacts (deal_id BIGINT NOT NULL REFERENCES deals(id) ON DELETE CASCADE, contact_id BIGINT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, created_at TEXT NOT NULL DEFAULT now_text(), PRIMARY KEY(deal_id,contact_id));
CREATE TABLE IF NOT EXISTS inbox_leads (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, pipeline_id BIGINT NOT NULL REFERENCES pipelines(id), title TEXT NOT NULL, contact_name TEXT NOT NULL DEFAULT '', company_name TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', website TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', message TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')), deal_id BIGINT REFERENCES deals(id) ON DELETE SET NULL, created_by BIGINT REFERENCES users(id) ON DELETE SET NULL, resolved_by BIGINT REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL DEFAULT now_text(), resolved_at TEXT);
CREATE TABLE IF NOT EXISTS lead_forms (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, pipeline_id BIGINT NOT NULL REFERENCES pipelines(id), title TEXT NOT NULL, token TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), created_at TEXT NOT NULL DEFAULT now_text());
CREATE TABLE IF NOT EXISTS api_keys (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, scopes_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT now_text(), last_used_at TEXT, revoked_at TEXT);
CREATE TABLE IF NOT EXISTS api_idempotency (api_key_id BIGINT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, lead_id BIGINT NOT NULL REFERENCES inbox_leads(id) ON DELETE CASCADE, created_at TEXT NOT NULL DEFAULT now_text(), PRIMARY KEY(api_key_id,idempotency_key));
CREATE TABLE IF NOT EXISTS webhook_endpoints (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, secret TEXT NOT NULL, events_json TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), created_at TEXT NOT NULL DEFAULT now_text());
CREATE TABLE IF NOT EXISTS webhook_events (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, event_type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT now_text());
CREATE TABLE IF NOT EXISTS webhook_deliveries (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, endpoint_id BIGINT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE, event_id BIGINT NOT NULL REFERENCES webhook_events(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','failed')), attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at BIGINT NOT NULL DEFAULT 0, locked_until BIGINT, response_status INTEGER, last_error TEXT NOT NULL DEFAULT '', delivered_at TEXT, UNIQUE(endpoint_id,event_id));
CREATE TABLE IF NOT EXISTS tasks (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, title TEXT NOT NULL, task_type TEXT NOT NULL DEFAULT 'Связаться', due_at TEXT, completed_at TEXT, completion_result TEXT NOT NULL DEFAULT '', deal_id BIGINT REFERENCES deals(id) ON DELETE CASCADE, contact_id BIGINT REFERENCES contacts(id) ON DELETE CASCADE, company_id BIGINT REFERENCES companies(id) ON DELETE CASCADE, owner_id BIGINT REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL DEFAULT now_text(), deleted_at TEXT, duration_minutes INTEGER NOT NULL DEFAULT 0, all_day INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS notes (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, deal_id BIGINT NOT NULL REFERENCES deals(id) ON DELETE CASCADE, user_id BIGINT REFERENCES users(id) ON DELETE SET NULL, body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT now_text(), pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)));
CREATE TABLE IF NOT EXISTS deal_communications (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, deal_id BIGINT NOT NULL REFERENCES deals(id) ON DELETE CASCADE, user_id BIGINT REFERENCES users(id) ON DELETE SET NULL, kind TEXT NOT NULL CHECK(kind IN ('call','email','message')), direction TEXT NOT NULL CHECK(direction IN ('incoming','outgoing')), subject TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT now_text());
CREATE TABLE IF NOT EXISTS entity_notes (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, entity_type TEXT NOT NULL CHECK(entity_type IN ('contact','company')), entity_id BIGINT NOT NULL, user_id BIGINT REFERENCES users(id) ON DELETE SET NULL, body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT now_text());
CREATE TABLE IF NOT EXISTS entity_activity (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, entity_type TEXT NOT NULL CHECK(entity_type IN ('contact','company')), entity_id BIGINT NOT NULL, user_id BIGINT REFERENCES users(id) ON DELETE SET NULL, event TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT now_text());
CREATE TABLE IF NOT EXISTS activity (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, deal_id BIGINT REFERENCES deals(id) ON DELETE CASCADE, user_id BIGINT REFERENCES users(id) ON DELETE SET NULL, event TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT now_text());
CREATE TABLE IF NOT EXISTS custom_fields (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, entity_type TEXT NOT NULL CHECK(entity_type IN ('deal','contact','company')), name TEXT NOT NULL, field_type TEXT NOT NULL CHECK(field_type IN ('text','number','date','url','select')), options_json TEXT NOT NULL DEFAULT '[]', sort_order BIGINT NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT now_text());
CREATE TABLE IF NOT EXISTS custom_field_values (field_id BIGINT NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE, entity_id BIGINT NOT NULL, value TEXT NOT NULL DEFAULT '', PRIMARY KEY(field_id,entity_id));
CREATE TABLE IF NOT EXISTS attachments (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, entity_type TEXT NOT NULL CHECK(entity_type IN ('deal','contact','company')), entity_id BIGINT NOT NULL, user_id BIGINT REFERENCES users(id) ON DELETE SET NULL, filename TEXT NOT NULL, mime_type TEXT NOT NULL, byte_size BIGINT NOT NULL, stored_name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT now_text());
CREATE TABLE IF NOT EXISTS audit_log (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, user_id BIGINT REFERENCES users(id) ON DELETE SET NULL, actor TEXT NOT NULL DEFAULT '', action TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', details TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT now_text());

CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(stage_id);
CREATE INDEX IF NOT EXISTS idx_deals_contact_live ON deals(contact_id,deleted_at);
CREATE INDEX IF NOT EXISTS idx_deals_company_live ON deals(company_id,deleted_at);
CREATE INDEX IF NOT EXISTS idx_deals_owner ON deals(owner_id);
CREATE INDEX IF NOT EXISTS idx_deal_contacts_contact ON deal_contacts(contact_id,deal_id);
CREATE INDEX IF NOT EXISTS idx_inbox_pipeline_status ON inbox_leads(pipeline_id,status,id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due ON webhook_deliveries(status,next_attempt_at,locked_until);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_at, completed_at);
CREATE INDEX IF NOT EXISTS idx_tasks_deal ON tasks(deal_id, completed_at);
CREATE INDEX IF NOT EXISTS idx_tasks_company ON tasks(company_id, completed_at);
CREATE INDEX IF NOT EXISTS idx_tasks_contact_live ON tasks(contact_id,completed_at,deleted_at);
CREATE INDEX IF NOT EXISTS idx_activity_deal ON activity(deal_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notes_deal ON notes(deal_id, created_at);
CREATE INDEX IF NOT EXISTS idx_deal_communications ON deal_communications(deal_id, created_at);
CREATE INDEX IF NOT EXISTS idx_entity_notes ON entity_notes(entity_type, entity_id, created_at);
CREATE INDEX IF NOT EXISTS idx_entity_activity ON entity_activity(entity_type, entity_id, created_at);
CREATE INDEX IF NOT EXISTS idx_custom_fields_type ON custom_fields(entity_type, sort_order);
CREATE INDEX IF NOT EXISTS idx_custom_field_values_entity ON custom_field_values(entity_id);
CREATE INDEX IF NOT EXISTS idx_attachments_entity ON attachments(entity_type, entity_id, created_at);
CREATE INDEX IF NOT EXISTS idx_companies_lower_name ON companies(lower(name));
CREATE INDEX IF NOT EXISTS idx_contacts_lower_name ON contacts(lower(name));
CREATE INDEX IF NOT EXISTS idx_contacts_lower_email ON contacts(lower(email));
CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone);
CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at,id);

CREATE OR REPLACE FUNCTION trg_webhook_delivery_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO webhook_deliveries (endpoint_id,event_id)
  SELECT w.id, NEW.id FROM webhook_endpoints w
  WHERE w.active = 1 AND EXISTS (SELECT 1 FROM json_array_elements_text(w.events_json::json) event WHERE event = NEW.event_type);
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION trg_webhook_lead_created() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO webhook_events (event_type,payload_json) VALUES ('lead.created', json_build_object('id',NEW.id,'pipeline_id',NEW.pipeline_id,'title',NEW.title,'contact_name',NEW.contact_name,'company_name',NEW.company_name,'phone',NEW.phone,'email',NEW.email,'source',NEW.source,'status',NEW.status)::text);
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION trg_webhook_deal_created() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO webhook_events (event_type,payload_json) VALUES ('deal.created', json_build_object('id',NEW.id,'pipeline_id',(SELECT pipeline_id FROM stages WHERE id=NEW.stage_id),'stage_id',NEW.stage_id,'name',NEW.name,'amount',NEW.amount,'owner_id',NEW.owner_id,'source',NEW.source)::text);
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION trg_webhook_deal_stage_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO webhook_events (event_type,payload_json) VALUES ('deal.stage_changed', json_build_object('id',NEW.id,'pipeline_id',(SELECT pipeline_id FROM stages WHERE id=NEW.stage_id),'previous_stage_id',OLD.stage_id,'stage_id',NEW.stage_id,'name',NEW.name,'amount',NEW.amount,'owner_id',NEW.owner_id)::text);
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_webhook_delivery_enqueue ON webhook_events;
CREATE TRIGGER trg_webhook_delivery_enqueue AFTER INSERT ON webhook_events FOR EACH ROW EXECUTE FUNCTION trg_webhook_delivery_enqueue();
DROP TRIGGER IF EXISTS trg_webhook_lead_created ON inbox_leads;
CREATE TRIGGER trg_webhook_lead_created AFTER INSERT ON inbox_leads FOR EACH ROW EXECUTE FUNCTION trg_webhook_lead_created();
DROP TRIGGER IF EXISTS trg_webhook_deal_created ON deals;
CREATE TRIGGER trg_webhook_deal_created AFTER INSERT ON deals FOR EACH ROW EXECUTE FUNCTION trg_webhook_deal_created();
DROP TRIGGER IF EXISTS trg_webhook_deal_stage_changed ON deals;
CREATE TRIGGER trg_webhook_deal_stage_changed AFTER UPDATE OF stage_id ON deals FOR EACH ROW WHEN (OLD.stage_id IS DISTINCT FROM NEW.stage_id) EXECUTE FUNCTION trg_webhook_deal_stage_changed();
`;

const defaultStages = [
  ['Новый лид','#f6ef9c','active'], ['Взят в работу','#f5e768','active'],
  ['Лид квалифицирован','#ecd679','active'], ['Встреча назначена','#bcd3f6','active'],
  ['Встреча проведена + КП отправлено','#a8d8e4','active'], ['Переговоры','#b9d5ef','active'],
  ['Отправлен счёт','#cdbfe9','active'], ['Согласование договора','#b7d9b1','active'],
  ['Успешно реализовано','#a9ddb1','won'], ['Закрыто и не реализовано','#e8b7b7','lost']
];

export async function createDb({ url = process.env.DATABASE_URL, dataDir = process.env.PGLITE_DIR } = {}) {
  const db = new Database(url ? await pgDriver(url) : await pgliteDriver(dataDir));
  // Several app instances may start at once against the same database: serialise schema setup.
  await db.transaction(async () => {
    await db.query('SELECT pg_advisory_xact_lock(4242001)');
    await db.exec(schema);
    if (!await db.prepare('SELECT id FROM pipelines LIMIT 1').get()) {
      const pipeline = await db.prepare('INSERT INTO pipelines (name) VALUES (?)').run('Воронка — новые лиды');
      for (const [index, [name, color, kind]] of defaultStages.entries()) {
        await db.prepare('INSERT INTO stages (pipeline_id,name,color,sort_order,kind) VALUES (?,?,?,?,?)').run(pipeline.lastInsertRowid, name, color, index, kind);
      }
    }
  })();
  return db;
}
