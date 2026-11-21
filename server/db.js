import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';

// OpenCRM stores its data in PostgreSQL. In production DATABASE_URL points at a Postgres server
// (the compose file starts one next to the app). Without DATABASE_URL — tests, the demo and quick
// local runs — an embedded Postgres (PGlite) is used, in memory or in PGLITE_DIR.
//
// The interface stays close to a prepared-statement API: db.prepare(sql).get/all/run(...params),
// all of them async. Placeholders are written as "?" and translated to $1..$n.

const tablesWithId = new Set(['users','user_groups','deal_saved_filters','pipelines','stages','companies','contacts','deals','inbox_leads','lead_forms','api_keys','webhook_endpoints','webhook_events','webhook_deliveries','tasks','notes','deal_communications','mailboxes','emails','entity_notes','entity_activity','activity','custom_fields','attachments','audit_log','deal_stage_changes']);

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
  constructor(driver) { this.driver = driver; this.scope = new AsyncLocalStorage(); this.actorScope = new AsyncLocalStorage(); this.depth = 0; }
  // Who is acting in this request: 'user:<id>' or 'api_key:<id>'. Transactions started inside
  // runAs() expose it to triggers as current_setting('opencrm.actor') (stage history, webhooks).
  runAs(actor, fn) { return this.actorScope.run(actor, fn); }
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
      const actor = this.actorScope.getStore();
      return this.driver.transaction(async client => {
        if (actor) await client.query("SELECT set_config('opencrm.actor', $1, true)", [actor]);
        return this.scope.run({ client, savepoints: 0 }, () => fn(...args));
      });
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
-- Connected mailboxes (server/mail.js). secret holds the encrypted password or service-account key.
CREATE TABLE IF NOT EXISTS mailboxes (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', auth_type TEXT NOT NULL CHECK(auth_type IN ('password','google_sa')), imap_host TEXT NOT NULL DEFAULT '', imap_port BIGINT NOT NULL DEFAULT 993, smtp_host TEXT NOT NULL DEFAULT '', smtp_port BIGINT NOT NULL DEFAULT 465, username TEXT NOT NULL DEFAULT '', secret TEXT NOT NULL DEFAULT '', history_days BIGINT NOT NULL DEFAULT 60, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), sync_state TEXT NOT NULL DEFAULT '{}', last_sync_at TEXT, last_error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT now_text());
CREATE TABLE IF NOT EXISTS emails (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, mailbox_id BIGINT REFERENCES mailboxes(id) ON DELETE SET NULL, deal_id BIGINT REFERENCES deals(id) ON DELETE SET NULL, linked_by TEXT NOT NULL DEFAULT '', direction TEXT NOT NULL CHECK(direction IN ('incoming','outgoing')), message_id TEXT NOT NULL UNIQUE, in_reply_to TEXT NOT NULL DEFAULT '', references_json TEXT NOT NULL DEFAULT '[]', from_address TEXT NOT NULL DEFAULT '', from_name TEXT NOT NULL DEFAULT '', reply_to TEXT NOT NULL DEFAULT '', to_json TEXT NOT NULL DEFAULT '[]', cc_json TEXT NOT NULL DEFAULT '[]', subject TEXT NOT NULL DEFAULT '', subject_key TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', attachments_json TEXT NOT NULL DEFAULT '[]', sent_at TEXT NOT NULL, user_id BIGINT REFERENCES users(id) ON DELETE SET NULL, folder TEXT NOT NULL DEFAULT '', uid BIGINT, created_at TEXT NOT NULL DEFAULT now_text());
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
CREATE INDEX IF NOT EXISTS idx_emails_deal ON emails(deal_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_emails_unlinked ON emails(sent_at) WHERE deal_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_emails_mailbox ON emails(mailbox_id);
CREATE INDEX IF NOT EXISTS idx_emails_subject ON emails(subject_key, sent_at);
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

-- API sync: contacts, companies and tasks get updated_at, maintained by a trigger.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['contacts','companies','tasks','notes','entity_notes'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = t AND column_name = 'updated_at') THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN updated_at TEXT', t);
      EXECUTE format('UPDATE %I SET updated_at = created_at', t);
      EXECUTE format('ALTER TABLE %I ALTER COLUMN updated_at SET DEFAULT now_text(), ALTER COLUMN updated_at SET NOT NULL', t);
    END IF;
  END LOOP;
END $$;
-- updated_at moves when the row really changes, unless the statement sets updated_at itself.
CREATE OR REPLACE FUNCTION trg_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at AND (to_jsonb(OLD) - 'updated_at') IS DISTINCT FROM (to_jsonb(NEW) - 'updated_at') AND coalesce(current_setting('opencrm.source_mirror', true), '') <> '1' THEN
    NEW.updated_at := now_text();
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_deals_touch ON deals;
CREATE TRIGGER trg_deals_touch BEFORE UPDATE ON deals FOR EACH ROW EXECUTE FUNCTION trg_touch_updated_at();
DROP TRIGGER IF EXISTS trg_notes_touch ON notes;
CREATE TRIGGER trg_notes_touch BEFORE UPDATE ON notes FOR EACH ROW EXECUTE FUNCTION trg_touch_updated_at();
DROP TRIGGER IF EXISTS trg_entity_notes_touch ON entity_notes;
CREATE TRIGGER trg_entity_notes_touch BEFORE UPDATE ON entity_notes FOR EACH ROW EXECUTE FUNCTION trg_touch_updated_at();
CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at,id);
CREATE INDEX IF NOT EXISTS idx_entity_notes_updated ON entity_notes(updated_at,id);
CREATE INDEX IF NOT EXISTS idx_deals_deleted ON deals(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_deleted ON contacts(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_companies_deleted ON companies(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_deleted ON tasks(deleted_at) WHERE deleted_at IS NOT NULL;

-- Who acts in the current transaction: set by the app as opencrm.actor = 'user:<id>' or 'api_key:<id>'.
CREATE OR REPLACE FUNCTION current_actor_id(kind text) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN split_part(COALESCE(current_setting('opencrm.actor', true), ''), ':', 1) = kind
    THEN NULLIF(split_part(current_setting('opencrm.actor', true), ':', 2), '')::bigint END
$$;

-- Deals: closed_at is set when a deal enters a won or lost stage and cleared when it returns to a
-- working stage. An explicit closed_at in the same statement (data import) is kept.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'deals' AND column_name = 'closed_at') THEN
    ALTER TABLE deals ADD COLUMN closed_at TEXT;
    UPDATE deals d SET closed_at = d.updated_at FROM stages s WHERE s.id = d.stage_id AND s.kind <> 'active';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION trg_deal_closed_at() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE closed boolean;
BEGIN
  SELECT kind <> 'active' INTO closed FROM stages WHERE id = NEW.stage_id;
  IF TG_OP = 'INSERT' THEN
    NEW.closed_at := CASE WHEN closed THEN COALESCE(NEW.closed_at, now_text()) END;
  ELSIF NEW.stage_id IS DISTINCT FROM OLD.stage_id AND NEW.closed_at IS NOT DISTINCT FROM OLD.closed_at THEN
    NEW.closed_at := CASE WHEN closed THEN now_text() END;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_deal_closed_at ON deals;
CREATE TRIGGER trg_deal_closed_at BEFORE INSERT OR UPDATE OF stage_id ON deals FOR EACH ROW EXECUTE FUNCTION trg_deal_closed_at();
CREATE INDEX IF NOT EXISTS idx_deals_closed ON deals(closed_at) WHERE closed_at IS NOT NULL;

-- deals.source mirrors the deal custom field «Источник» (amoCRM moves and the portal write the source
-- there). Any write of the field — interface, API, import — updates the source; the deal's updated_at
-- does not move, as it does not for other custom fields.
CREATE OR REPLACE FUNCTION trg_deal_source_mirror() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_field BIGINT; row_entity BIGINT; row_value TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN row_field := OLD.field_id; row_entity := OLD.entity_id; row_value := '';
  ELSE row_field := NEW.field_id; row_entity := NEW.entity_id; row_value := NEW.value; END IF;
  IF EXISTS (SELECT 1 FROM custom_fields f WHERE f.id = row_field AND f.entity_type = 'deal' AND lower(btrim(f.name)) = 'источник') THEN
    PERFORM set_config('opencrm.source_mirror', '1', true);
    UPDATE deals SET source = row_value WHERE id = row_entity AND source IS DISTINCT FROM row_value;
    PERFORM set_config('opencrm.source_mirror', '', true);
  END IF;
  RETURN NULL;
END $$;
-- Who completed a task: the employee acting in the transaction (NULL for the API, robots and imports).
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_by BIGINT REFERENCES users(id) ON DELETE SET NULL;
CREATE OR REPLACE FUNCTION trg_task_completed_by() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.completed_at IS NULL THEN NEW.completed_by := NULL;
  ELSIF OLD.completed_at IS NULL THEN NEW.completed_by := COALESCE(NEW.completed_by, current_actor_id('user'));
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_task_completed_by ON tasks;
CREATE TRIGGER trg_task_completed_by BEFORE UPDATE OF completed_at ON tasks FOR EACH ROW EXECUTE FUNCTION trg_task_completed_by();
DROP TRIGGER IF EXISTS trg_deal_source_mirror ON custom_field_values;
CREATE TRIGGER trg_deal_source_mirror AFTER INSERT OR UPDATE OR DELETE ON custom_field_values FOR EACH ROW EXECUTE FUNCTION trg_deal_source_mirror();

-- Stage history: one row per deal creation (from_* empty) and per stage change.
DO $$
BEGIN
  IF to_regclass('deal_stage_changes') IS NULL THEN
    CREATE TABLE deal_stage_changes (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, deal_id BIGINT NOT NULL REFERENCES deals(id) ON DELETE CASCADE, from_stage_id BIGINT, from_pipeline_id BIGINT, to_stage_id BIGINT NOT NULL, to_pipeline_id BIGINT, user_id BIGINT, api_key_id BIGINT, changed_at TEXT NOT NULL DEFAULT now_text());
    INSERT INTO deal_stage_changes (deal_id,to_stage_id,to_pipeline_id,changed_at) SELECT d.id, d.stage_id, s.pipeline_id, d.created_at FROM deals d JOIN stages s ON s.id = d.stage_id ORDER BY d.id;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_deal_stage_changes_time ON deal_stage_changes(changed_at,id);
CREATE INDEX IF NOT EXISTS idx_deal_stage_changes_deal ON deal_stage_changes(deal_id,id);
CREATE OR REPLACE FUNCTION trg_deal_stage_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO deal_stage_changes (deal_id,to_stage_id,to_pipeline_id,user_id,api_key_id)
    VALUES (NEW.id, NEW.stage_id, (SELECT pipeline_id FROM stages WHERE id = NEW.stage_id), current_actor_id('user'), current_actor_id('api_key'));
  ELSIF NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
    INSERT INTO deal_stage_changes (deal_id,from_stage_id,from_pipeline_id,to_stage_id,to_pipeline_id,user_id,api_key_id)
    VALUES (NEW.id, OLD.stage_id, (SELECT pipeline_id FROM stages WHERE id = OLD.stage_id), NEW.stage_id, (SELECT pipeline_id FROM stages WHERE id = NEW.stage_id), current_actor_id('user'), current_actor_id('api_key'));
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_deal_stage_history ON deals;
CREATE TRIGGER trg_deal_stage_history AFTER INSERT OR UPDATE OF stage_id ON deals FOR EACH ROW EXECUTE FUNCTION trg_deal_stage_history();

-- After rows were inserted with explicit IDs (data import), move every ID sequence past the largest
-- ID so that new records do not collide. Sequences that are already ahead are left alone.
CREATE OR REPLACE FUNCTION sync_id_sequences() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE r record; seq text; top bigint; cur bigint; called boolean; fixed integer := 0;
BEGIN
  FOR r IN SELECT c.table_name FROM information_schema.columns c WHERE c.table_schema = current_schema() AND c.column_name = 'id' AND c.is_identity = 'YES' LOOP
    seq := pg_get_serial_sequence(quote_ident(r.table_name), 'id');
    EXECUTE format('SELECT max(id) FROM %I', r.table_name) INTO top;
    EXECUTE format('SELECT last_value, is_called FROM %s', seq) INTO cur, called;
    IF top IS NOT NULL AND (top > cur OR (top = cur AND NOT called)) THEN
      PERFORM setval(seq, top, true);
      fixed := fixed + 1;
    END IF;
  END LOOP;
  RETURN fixed;
END $$;

-- Contacts: Telegram username, matched without @, t.me/ and letter case.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS telegram TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
-- Where a note came from: 'common' is written by a person; loads from amoCRM keep its note types (call_in, amomail_message, ...).
ALTER TABLE notes ADD COLUMN IF NOT EXISTS note_type TEXT NOT NULL DEFAULT 'common';
ALTER TABLE entity_notes ADD COLUMN IF NOT EXISTS note_type TEXT NOT NULL DEFAULT 'common';
-- Mail section: when a letter was read (any employee); notifications: when the user last opened them.
ALTER TABLE emails ADD COLUMN IF NOT EXISTS read_at TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS notifications_seen_at TEXT;
CREATE INDEX IF NOT EXISTS idx_emails_sent ON emails(sent_at);
CREATE OR REPLACE FUNCTION normalize_telegram(value text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(regexp_replace(btrim(COALESCE(value, '')), '^(https?://)?(www[.])?((t|telegram)[.]me/)?@?', ''))
$$;
CREATE INDEX IF NOT EXISTS idx_contacts_telegram ON contacts(normalize_telegram(telegram)) WHERE telegram <> '';
DROP TRIGGER IF EXISTS trg_contacts_touch ON contacts;
CREATE TRIGGER trg_contacts_touch BEFORE UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION trg_touch_updated_at();
DROP TRIGGER IF EXISTS trg_companies_touch ON companies;
CREATE TRIGGER trg_companies_touch BEFORE UPDATE ON companies FOR EACH ROW EXECUTE FUNCTION trg_touch_updated_at();
DROP TRIGGER IF EXISTS trg_tasks_touch ON tasks;
CREATE TRIGGER trg_tasks_touch BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION trg_touch_updated_at();
CREATE INDEX IF NOT EXISTS idx_deals_updated ON deals(updated_at,id);
CREATE INDEX IF NOT EXISTS idx_contacts_updated ON contacts(updated_at,id);
CREATE INDEX IF NOT EXISTS idx_companies_updated ON companies(updated_at,id);
CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks(updated_at,id);

-- Stage transition rules: with transition_mode='restricted' a deal may only move between stages of
-- its pipeline along a listed pair; lock_deals=1 keeps deals from being moved to another pipeline.
ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS transition_mode TEXT NOT NULL DEFAULT 'any' CHECK(transition_mode IN ('any','restricted'));
ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS lock_deals INTEGER NOT NULL DEFAULT 0 CHECK(lock_deals IN (0,1));
CREATE TABLE IF NOT EXISTS stage_transitions (from_stage_id BIGINT NOT NULL REFERENCES stages(id) ON DELETE CASCADE, to_stage_id BIGINT NOT NULL REFERENCES stages(id) ON DELETE CASCADE, PRIMARY KEY(from_stage_id,to_stage_id), CHECK(from_stage_id<>to_stage_id));
CREATE INDEX IF NOT EXISTS idx_stage_transitions_to ON stage_transitions(to_stage_id);

-- Idempotent creates through API v1 (POST /api/v1/leads keeps its own table).
CREATE TABLE IF NOT EXISTS api_requests (api_key_id BIGINT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, resource TEXT NOT NULL, resource_id BIGINT NOT NULL, created_at TEXT NOT NULL DEFAULT now_text(), PRIMARY KEY(api_key_id,idempotency_key));

CREATE OR REPLACE FUNCTION trg_webhook_delivery_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO webhook_deliveries (endpoint_id,event_id)
  SELECT w.id, NEW.id FROM webhook_endpoints w
  WHERE w.active = 1 AND EXISTS (SELECT 1 FROM json_array_elements_text(w.events_json::json) event WHERE event = NEW.event_type);
  RETURN NULL;
END $$;
-- Events are stored only when an active endpoint subscribes to them.
CREATE OR REPLACE FUNCTION webhook_emit(kind text, payload json) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM webhook_endpoints w WHERE w.active = 1 AND EXISTS (SELECT 1 FROM json_array_elements_text(w.events_json::json) event WHERE event = kind)) THEN
    INSERT INTO webhook_events (event_type,payload_json) VALUES (kind, payload::text);
  END IF;
END $$;
CREATE OR REPLACE FUNCTION webhook_deal_payload(d deals) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('id',d.id,'pipeline_id',(SELECT pipeline_id FROM stages WHERE id=d.stage_id),'stage_id',d.stage_id,'name',d.name,'amount',d.amount,'owner_id',d.owner_id,'contact_id',d.contact_id,'company_id',d.company_id,'source',d.source,'tags',d.tags,'loss_reason',d.loss_reason,'created_at',d.created_at,'updated_at',d.updated_at,'closed_at',d.closed_at,'deleted_at',d.deleted_at,'changed_by',jsonb_build_object('user_id',current_actor_id('user'),'api_key_id',current_actor_id('api_key')))
$$;
CREATE OR REPLACE FUNCTION trg_webhook_lead_created() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM webhook_emit('lead.created', json_build_object('id',NEW.id,'pipeline_id',NEW.pipeline_id,'title',NEW.title,'contact_name',NEW.contact_name,'company_name',NEW.company_name,'phone',NEW.phone,'email',NEW.email,'source',NEW.source,'status',NEW.status));
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION trg_webhook_deal_created() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM webhook_emit('deal.created', webhook_deal_payload(NEW)::json);
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION trg_webhook_deal_stage_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM webhook_emit('deal.stage_changed', (webhook_deal_payload(NEW) || jsonb_build_object('previous_stage_id',OLD.stage_id,'previous_pipeline_id',(SELECT pipeline_id FROM stages WHERE id=OLD.stage_id)))::json);
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION trg_webhook_deal_updated() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    PERFORM webhook_emit('deal.deleted', webhook_deal_payload(NEW)::json);
  ELSIF NEW.deleted_at IS NULL AND (to_jsonb(OLD) - 'updated_at') IS DISTINCT FROM (to_jsonb(NEW) - 'updated_at') AND coalesce(current_setting('opencrm.source_mirror', true), '') <> '1' THEN
    PERFORM webhook_emit('deal.updated', webhook_deal_payload(NEW)::json);
  END IF;
  RETURN NULL;
END $$;
-- Contacts and companies: TG_ARGV[0] is 'contact' or 'company'.
CREATE OR REPLACE FUNCTION trg_webhook_entity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM webhook_emit(TG_ARGV[0] || '.created', row_to_json(NEW));
  ELSIF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    PERFORM webhook_emit(TG_ARGV[0] || '.deleted', row_to_json(NEW));
  ELSIF NEW.deleted_at IS NULL AND (to_jsonb(OLD) - 'updated_at') IS DISTINCT FROM (to_jsonb(NEW) - 'updated_at') THEN
    PERFORM webhook_emit(TG_ARGV[0] || '.updated', row_to_json(NEW));
  END IF;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION trg_webhook_task() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM webhook_emit('task.created', row_to_json(NEW));
  ELSIF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    PERFORM webhook_emit('task.deleted', row_to_json(NEW));
  ELSIF NEW.deleted_at IS NULL AND OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL THEN
    PERFORM webhook_emit('task.completed', row_to_json(NEW));
  ELSIF NEW.deleted_at IS NULL AND (to_jsonb(OLD) - 'updated_at') IS DISTINCT FROM (to_jsonb(NEW) - 'updated_at') THEN
    PERFORM webhook_emit('task.updated', row_to_json(NEW));
  END IF;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION trg_webhook_deal_note() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM webhook_emit('note.created', json_build_object('id',NEW.id,'entity_type','deal','entity_id',NEW.deal_id,'user_id',NEW.user_id,'body',NEW.body,'note_type',NEW.note_type,'created_at',NEW.created_at));
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION trg_webhook_entity_note() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM webhook_emit('note.created', json_build_object('id',NEW.id,'entity_type',NEW.entity_type,'entity_id',NEW.entity_id,'user_id',NEW.user_id,'body',NEW.body,'note_type',NEW.note_type,'created_at',NEW.created_at));
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
DROP TRIGGER IF EXISTS trg_webhook_deal_updated ON deals;
CREATE TRIGGER trg_webhook_deal_updated AFTER UPDATE ON deals FOR EACH ROW EXECUTE FUNCTION trg_webhook_deal_updated();
DROP TRIGGER IF EXISTS trg_webhook_contact ON contacts;
CREATE TRIGGER trg_webhook_contact AFTER INSERT OR UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION trg_webhook_entity('contact');
DROP TRIGGER IF EXISTS trg_webhook_company ON companies;
CREATE TRIGGER trg_webhook_company AFTER INSERT OR UPDATE ON companies FOR EACH ROW EXECUTE FUNCTION trg_webhook_entity('company');
DROP TRIGGER IF EXISTS trg_webhook_task ON tasks;
CREATE TRIGGER trg_webhook_task AFTER INSERT OR UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION trg_webhook_task();
DROP TRIGGER IF EXISTS trg_webhook_deal_note ON notes;
CREATE TRIGGER trg_webhook_deal_note AFTER INSERT ON notes FOR EACH ROW EXECUTE FUNCTION trg_webhook_deal_note();
DROP TRIGGER IF EXISTS trg_webhook_entity_note ON entity_notes;
CREATE TRIGGER trg_webhook_entity_note AFTER INSERT ON entity_notes FOR EACH ROW EXECUTE FUNCTION trg_webhook_entity_note();
-- Fill deals.source from «Источник» for deals loaded before the mirror existed. After the webhook
-- triggers above, so it neither touches updated_at nor sends deal.updated.
DO $$
BEGIN
  PERFORM set_config('opencrm.source_mirror', '1', true);
  UPDATE deals d SET source = v.value FROM custom_field_values v JOIN custom_fields f ON f.id = v.field_id AND f.entity_type = 'deal' AND lower(btrim(f.name)) = 'источник'
    WHERE v.entity_id = d.id AND d.source IS DISTINCT FROM v.value;
  PERFORM set_config('opencrm.source_mirror', '', true);
END $$;
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
    await db.query('SELECT sync_id_sequences()');
    if (!await db.prepare('SELECT id FROM pipelines LIMIT 1').get()) {
      const pipeline = await db.prepare('INSERT INTO pipelines (name) VALUES (?)').run('Воронка — новые лиды');
      for (const [index, [name, color, kind]] of defaultStages.entries()) {
        await db.prepare('INSERT INTO stages (pipeline_id,name,color,sort_order,kind) VALUES (?,?,?,?,?)').run(pipeline.lastInsertRowid, name, color, index, kind);
      }
    }
  })();
  return db;
}
