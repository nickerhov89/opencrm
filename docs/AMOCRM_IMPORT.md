# Loading data from amoCRM with the original IDs

`scripts/amocrm-import.mjs` moves an amoCRM account into OpenCRM once, keeping the amoCRM IDs of users, pipelines, stages, custom fields, companies, contacts, deals, tasks and notes. Deal numbers stay the same, so links and references to `https://<crm>/deals/<amo id>` keep working. The script reads your own account through the amoCRM API v4 with a long-lived integration token; it does not synchronise later changes.

## With the script

Run the commands in the app container (`docker compose -p opencrm exec opencrm ...`) or anywhere with Node.js 22.12+ and `DATABASE_URL`.

1. Export. Create a long-lived token in amoCRM (Settings → Integrations → your private integration → Keys and access), then:

   ```sh
   docker compose -p opencrm exec -e AMO_BASE_URL=https://<subdomain>.amocrm.ru -e AMO_ACCESS_TOKEN=<token> opencrm node scripts/amocrm-import.mjs export
   ```

   The files go to `data/amocrm-export` (`--dir` changes it; in the container this is the `opencrm_data` volume, which is not part of backups). `AMO_PROXY_URL=http://[user:password@]host:port` sends the requests through an HTTP CONNECT proxy; `AMO_RPS` (default 3, at most 7) limits requests per second, because the token's limit is shared with other integrations that use it. Network errors and HTTP 429/5xx are retried. Files already downloaded are kept, so a broken export continues where it stopped; `--force` downloads everything again. Exported: users, pipelines with statuses, custom fields of deals, contacts and companies, companies, contacts, deals with their contacts and loss reasons, tasks, notes of deals, contacts and companies, and the `lead_status_changed` events. Deleted records, files, calls as separate entities and other events are not exported.

2. Trial load. `load --dry-run` writes everything in a transaction, runs the checks and rolls back:

   ```sh
   docker compose -p opencrm exec opencrm node scripts/amocrm-import.mjs load --dry-run
   ```

   The report lists row counts, warnings with examples and the number of deals per stage; it is also saved as `data/amocrm-export/load-report.json` for comparison with amoCRM. To try without touching the CRM database at all, add `-e DATABASE_URL=`: the load then runs in a temporary in-memory database.

3. Take a backup (`docker compose -p opencrm exec backup node scripts/backup.mjs now`) and load:

   ```sh
   docker compose -p opencrm exec opencrm node scripts/amocrm-import.mjs load
   ```

   The load goes into a CRM without deals, contacts, companies, tasks, notes or custom fields. `--replace` first removes those (and pipelines with amoCRM IDs), for example to load a fresh export again; users, API keys, webhooks and settings stay. Attachments block `--replace`. The empty seed pipeline «Воронка — новые лиды» is removed unless `--keep-default-pipeline` is given.

4. Give people passwords: `node scripts/admin.mjs reset-password <email>` or **Настройки → Пользователи**. Loaded users cannot sign in until then; users inactive in amoCRM are disabled. An OpenCRM account with the e-mail of an amoCRM user (for example the administrator who set up the CRM) keeps its password and sessions but takes the amoCRM user ID, together with everything that refers to it, so integrations that match employees by amoCRM ID keep working; the report lists these as `rekeyed_users`.

5. Delete the export folder: it holds customers' personal data.

What the script does with the data:

- One transaction with triggers off (`session_replication_role = replica`): no webhooks, no extra history, timestamps from amoCRM. Afterwards it checks references, moves the ID sequences past the loaded IDs and switches the triggers back on, so new records get numbers above the amoCRM ones and everything works as usual.
- Statuses 142 and 143 become a won and a lost stage of each pipeline with new IDs (listed in the report as `closing_stages`); «Неразобранное» is the first active stage. Deals in won or lost stages get `closed_at` from amoCRM.
- Custom fields keep their IDs and names; types map as in the table below. Phones, e-mails and the position of contacts, and the phone, e-mail, website and address of companies go into the card fields (several values comma-separated). A contact field named Telegram (or the Telegram messenger) also fills the contact's Telegram field. Dates are taken in the account's time zone. Select options are matched by text; values missing from the options are added to them.
- Tasks: the first line of the text is the title, the full text the description; amoCRM types 1–3 become «Связаться», «Встреча», «Письмо», custom types keep their names; a task due at 23:59 in the account's time zone is an all-day task. A completed task's completion time is its last update.
- Notes of every type become text; call notes include the phone, duration, result and recording link.
- Stage history: a creation row per deal and a row per `lead_status_changed` event, with the employee and time.

## Manual load

The script follows these rules; they matter if you load by other means.

1. Load inside one transaction with triggers switched off, so the load does not send webhooks, write extra history or rewrite timestamps:

   ```sql
   BEGIN;
   SET LOCAL session_replication_role = replica;  -- needs a superuser; the POSTGRES_USER of the Compose stack is one
   -- INSERT ... with explicit id values
   COMMIT;
   ```

   With `replica` PostgreSQL also skips foreign key checks, so load in dependency order and keep the data consistent: users → pipelines → stages → custom_fields → companies → contacts → deals → deal_contacts → custom_field_values → tasks → notes / entity_notes → deal_stage_changes.

2. Every `id` column is `GENERATED BY DEFAULT AS IDENTITY`: insert the amoCRM ID explicitly.
3. After the load run `docker compose -p opencrm exec opencrm node scripts/admin.mjs sync-ids` (the app also does this on every start). It moves each ID sequence past the largest loaded ID, so records created later get new numbers above the amoCRM ones.
4. Check the result in the interface and through `GET /api/v1/...`, then remove leftovers you do not need (for example the default pipeline «Воронка — новые лиды» if it has no deals: `DELETE FROM pipelines WHERE id = ...` also removes its stages).

A fresh installation contains user 1 (the administrator), pipeline 1 and stages 1–10. amoCRM IDs are far larger, so they do not collide.

## Table notes

All timestamps are UTC text `YYYY-MM-DD HH:MM:SS` (task `due_at` and `completed_at` are ISO 8601 `2026-12-01T09:00:00.000Z`). Convert amoCRM Unix times accordingly.

| Table | What to fill |
|---|---|
| `users` | `id`, `name`, `email` (unique, lower case), `password_hash` = `'x:y'` (no login possible), `role` `admin`/`member`, `permissions_json` = `{"deal":{"create":true,"edit":true,"delete":false,"export":false},"contact":{…same…},"company":{…},"task":{…}}`. People then get a password with `node scripts/admin.mjs reset-password <email>` or from an administrator in Settings. |
| `pipelines` | `id`, `name`, `sort_order`. |
| `stages` | `id`, `pipeline_id`, `name`, `color`, `sort_order`, `kind` (`active`/`won`/`lost`). amoCRM statuses 142 (won) and 143 (lost) are shared by all pipelines; here every pipeline needs its **own** `won` and `lost` stage. Create them without an explicit ID after the other stages (or pick unused IDs) and map deals in 142/143 to the stage of their pipeline. Load the amoCRM «Неразобранное» status of each pipeline as an ordinary `active` stage, first by `sort_order`. |
| `custom_fields` | `id`, `entity_type` (`deal`/`contact`/`company`), `name` (unique per type), `field_type` (`text`/`number`/`date`/`url`/`select`), `options_json` (JSON list of option texts for `select`), `sort_order`. Keep amoCRM field names unchanged: integrations find fields such as `utm_source` by name. amoCRM types map as follows: `text`, `textarea`, `tracking_data` (utm_*, referrer, _ym_uid, yclid, fbclid, gclid, from) → `text`; `numeric` → `number`; `date`, `date_time`, `birthday` → `date`; `url` → `url`; `select`, `radiobutton` → `select`. A `multiselect` has no direct match: store its options comma-separated in a `text` field. |
| `custom_field_values` | `field_id`, `entity_id`, `value` as text up to 5000 characters: the option text for `select`, `YYYY-MM-DD` for `date` (for `date_time` keep the date), a number for `number`. |
| `companies`, `contacts` | `id`, `name`, `owner_id`, `phone`, `email`, `notes`, `tags` (comma-separated), `created_at`, `updated_at`; contacts also `company_id`, `position`, `telegram`. Several phones or emails can be stored comma-separated in one field. |
| `deals` | `id`, `name`, `stage_id`, `owner_id`, `amount` (integer), `company_id`, `contact_id` (main contact), `source`, `tags`, `description`, `loss_reason`, `created_at`, `updated_at`, `closed_at` (for deals in won/lost stages — the triggers do not fill it during the load). |
| `deal_contacts` | Every link `deal_id`, `contact_id`, including the main contact. |
| `tasks` | `id`, `title` (up to 500 characters), `description` (up to 5000: the amoCRM task text that does not fit the title), `task_type` (use the preset names, for example `Встреча` for meetings, see `GET /api/v1/task-types`), `due_at`, `duration_minutes`, `all_day`, `completed_at`, `completion_result`, `deal_id` / `contact_id` / `company_id`, `owner_id`, `created_at`, `updated_at`. |
| `notes` | Deal notes: `id`, `deal_id`, `user_id`, `body`, `pinned`, `created_at`, `updated_at`. |
| `entity_notes` | Contact and company notes: `id`, `entity_type`, `entity_id`, `user_id`, `body`, `created_at`, `updated_at`. |
| `deal_stage_changes` | Stage history from amoCRM `lead_status_changed` events: `deal_id`, `from_stage_id`, `from_pipeline_id`, `to_stage_id`, `to_pipeline_id`, `user_id`, `changed_at`. Add one row per deal for its creation with `from_*` empty. The `id` may be left to the database. Replace 142/143 in `from_stage_id` and `to_stage_id` with the won/lost stage of the pipeline named in the event (`value_before` / `value_after[0].lead_status.pipeline_id`). Stages deleted in amoCRM may stay with their old IDs: the stage columns of this table have no foreign keys. |

Activity history in the deal card (`activity`, `entity_activity`) is free text; loading it is optional.

## After the load

- New stage changes, `closed_at`, `updated_at`, webhooks and history work through the triggers as usual.
- Webhook endpoints created before the load receive nothing about loaded rows (the triggers were off).
- `GET /api/v1/stage-changes`, `GET /api/v1/deals?closed_since=…` and the other lists return loaded data immediately.
