# Changelog

## Unreleased — plugins

- Plugins extend OpenCRM without changing its code: a ZIP with `plugin.json`, an optional server module and an optional browser module. Admins upload, configure, enable, update and delete them in Settings → Plugins; every action is in the security log. `OPENCRM_PLUGIN_UPLOAD=0` turns uploads off, `npm run plugin -- pack|install|list|enable|disable` works on the server.
- Server API (`ctx`): routes behind sign-in and public routes for incoming webhooks, CRM events (the webhook event list), periodic tasks, key-value storage, requests in «Неразобранное», events and notes in the deal feed, the plugin log. Settings forms are built from `plugin.json`; password settings are encrypted and never sent to the browser.
- Browser API: a page in the left menu (`/apps/<plugin>/<page>`) and a panel in the deal card, drawn with the app's React or plain DOM.
- Examples: `tilda-forms` (Tilda forms → «Неразобранное», deduplicated by `tranid`) and `hello-world`. See docs/PLUGINS.md.

## Unreleased — closer to amoCRM

- The desktop opens on «Сегодня»; board cards show how many days the earliest open task is overdue («3 дн.»).
- Distribution of new deals (Settings → Распределение, like the amoCRM widget): rules by pipeline, source and origin (API, accepted requests, created by hand) give new deals to managers in turn a few seconds after creation; the manager becomes the owner of the deal, its main contact, its company and its open tasks, then the rule's task («Связаться: Взять в работу», due at the end of the day) is created for them. Deals loaded with an old date are never redistributed. API: `/api/distribution/rules`.
- Mail sync links letters to deals through an address index built once per run: a letter takes milliseconds instead of a scan of every deal (about 18 s per letter on 7500 deals).
- `deals.source` mirrors the deal custom field «Источник» on every write (interface, API, import) without moving `updated_at` or sending `deal.updated`; deals loaded before are filled on start. The deal card hides the built-in «Источник» when the field exists.
- Completed tasks in the deal feed show when they were completed and who completed them (`tasks.completed_by`), not the due date.
- Task types from amoCRM: «Оформить сделку», «Передать проект», «Поставить задачу», «Дубль», «Повторная заявка».
- «Почта» in the left menu with an unread badge: folders (inbox, unread, sent, without a deal, all), mailbox choice, search, the letter with its thread, «Ответить», «Ответить всем», «Непрочитанное», «Прочитать все». Employees see letters of the deals they can open, admins see all.
- «Написать» sends a new letter from a connected mailbox; in the deal card «Письмо» now sends for real (recipients from the deal contacts) and the letter lands in the feed. «Записать без отправки» keeps the manual record. API: `GET /api/mail/summary`, `GET /api/mail/emails`, `GET /api/mail/emails/:id`, `POST /api/mail/send`, `POST /api/mail/emails/:id/reply`, read marks.
- «Сообщения» at the bottom of the menu: overdue tasks and tasks due within the hour, unread letters of my deals, new requests in «Неразобранное», with a badge for what appeared since the panel was last opened.
- Board: every open deal of the pipeline is loaded (before, only the 1000 most recently changed deals, so open deals could be missing); the header counts open deals; won and lost stages are drop zones at the bottom while a card is dragged; an empty imported «Неразобранное» stage is hidden next to the requests column; the card shows the «Источник» custom field when the built-in source is empty and hides a zero budget.
- Deal feed: HTML entities in notes moved from amoCRM are shown decoded, long notes fold with «Показать полностью», three or more system events in a row fold into one line.

## Unreleased — mail in deals

- Connected mailboxes (Settings → Mail, admins): IMAP/SMTP with an app password, or Google Workspace through a service account with domain-wide delegation (XOAUTH2). The connection is checked before saving; passwords and keys are encrypted with `OPENCRM_SECRET_KEY` or a key file outside the backups.
- Sync every two minutes by UID (Gmail: All Mail; others: INBOX and Sent), 60 days of history on connect, duplicates merged by Message-ID, drafts skipped. Text (HTML converted), headers and the list of attachments are kept.
- Letters link to deals by thread (In-Reply-To/References), by the address of a contact or company (open deal first), or by the same subject with the same correspondent when only one deal fits. Inside a deal a letter is incoming when it comes from the client's address or domain, otherwise outgoing. Unlinked letters are kept, checked again on every sync and can be linked by hand.
- The deal feed shows letters with notes; «Ответить» and «Ответить всем» send over SMTP of the same mailbox with In-Reply-To, References and the unchanged «Re:» subject, and the sent letter appears in the feed at once.
- API: `GET /api/v1/deals/:id/emails`, `GET /api/v1/emails`, new key scope `emails:read`. See docs/MAIL.md.
- `scripts/mail-add.mjs` connects a mailbox from the server with the key or password read from a file, never printed.

## Unreleased — data for reports and the amoCRM move

- The amoCRM import brings the card history: all events of deals, contacts and companies (field changes, tags, responsible, links, stages) become history rows worded like OpenCRM's own; `history` adds it to a CRM loaded earlier without touching anything else, and with `AMO_BASE_URL` and `AMO_ACCESS_TOKEN` in `.env` the server does this by itself once after start, straight from amoCRM. Deal, contact and company history is ordered by time and shows up to 500 rows; the deal feed also shows the history of its contacts and company, as amoCRM does.
- Notes have `note_type` (`common` for notes written here, the amoCRM type for loaded ones) in the API, the `note_type` filter and the `note.created` webhook. The amoCRM import downloads files directly when the proxy refuses a host.
- `scripts/amocrm-import.mjs`: one-time move from amoCRM. `export` downloads the account through the amoCRM API v4 (proxy, rate limit, retries, resumable), `load` writes it in one transaction keeping amoCRM IDs, with per-pipeline won/lost stages, stage history, tasks, notes, files and custom fields; an existing account with an amoCRM e-mail takes the amoCRM user ID; `--dry-run` rolls back after the checks, `--replace` loads again. See docs/AMOCRM_IMPORT.md.
- Tasks have a `description` (up to 5000 characters) next to the 500-character title, in the task window, the deal timeline, the task board and the API.
- Custom field values may be up to 5000 characters (was 1000).
- docs/AMOCRM_IMPORT.md: amoCRM field type mapping, the «Неразобранное» stage, 142/143 and deleted stages in the stage history.
- Stage history as data: every deal creation and stage change is a row in `deal_stage_changes` with the stage and pipeline before and after, who made it (employee or API key) and when; `GET /api/v1/stage-changes` lists it for all deals.
- Deals have `closed_at`, set on entering a won or lost stage and cleared on return to work; `closed_since`/`closed_before` filters.
- Lists can include records in the trash (`include_deleted=1`) or only recently trashed ones (`deleted_since`); every record has `deleted_at`, and moving to the trash updates `updated_at`.
- `GET /api/v1/notes` lists notes of all deals, contacts or companies; notes have `updated_at`.
- Contacts have a Telegram field (in the card and the API) with lookup that ignores `@`, `t.me/` and case; lists filter by custom field values with `custom_field[<id>]=`.
- `GET /api/v1/task-types`; preset task types are shared between the interface and the API.
- Deal webhooks carry `changed_by`.
- `node scripts/admin.mjs sync-ids` (also run on every start) moves ID sequences past rows loaded with explicit IDs; docs/AMOCRM_IMPORT.md describes a load from amoCRM that keeps the original IDs.

## Unreleased — full API v1

- API v1 covers deals, contacts, companies, tasks, notes, calls, employees, custom fields and pipelines: list with filters, cursor pagination and `updated_since` sync, read, create (with `Idempotency-Key`), update, and move to the trash. New key scopes: `contacts:*`, `companies:*`, `tasks:*`, `users:read`, `pipelines:write`, `fields:write`; `deals:write` now covers creating, updating and deleting deals, not only changing the stage. See docs/INTEGRATIONS.md.
- Stage transition rules per pipeline: free movement, or only listed from → to stages, and an option to keep deals in their pipeline. Set in the pipeline settings (**Правила переходов**) or through the API; they apply to employees and API keys, administrators are exempt in the interface.
- New webhook events: `deal.updated`, `deal.deleted`, `contact.*`, `company.*`, `task.*`, `note.created`. Deal payloads include contact and company IDs. Events are stored only while an endpoint subscribes to them.
- Contacts, companies and tasks have `updated_at`.

## Unreleased — PostgreSQL

- `BACKUP_KEEP=0` keeps no copies on the host: each copy is deleted once S3 confirms it, failed uploads are retried. `backup.mjs restore-s3` restores the newest (or a named) copy straight from S3; every copy is a single opencrm-<time>.tar.gz with the full dump, attachments, checksums and RESTORE.txt.
- Backups run every day at a fixed time (`BACKUP_AT`, default 00:00 Moscow time); `backup.mjs now` runs one full cycle on demand.
- The backup service can upload every copy to S3-compatible storage with rclone, check it after upload, optionally encrypt it, and delete remote copies older than `BACKUP_S3_KEEP_DAYS`.
- Data is stored in PostgreSQL instead of SQLite. Docker Compose now starts the app, PostgreSQL 17 and a backup service with daily `pg_dump` and attachment copies. Without `DATABASE_URL` the app runs on embedded PGlite (tests, demo, local development). There is no automatic migration from SQLite: a new installation starts empty.
- Backups are `pg_dump` archives with checksums; restore goes into an empty database.
- Malformed numeric input now returns 400 instead of a server error.

## Unreleased — security hardening

- Admins can disable employees, set a new password, end all of an employee's sessions and reset their two-factor sign-in; disabling or resetting ends sessions immediately. A server-side `npm run admin` command recovers a locked-out administrator.
- Everyone can change their password, end sessions on other devices, and turn on TOTP two-factor sign-in.
- Permissions are now denied unless granted. New members can create and edit but not delete or export by default; existing members keep their previous effective rights.
- Security log for sign-ins, failed attempts, user and permission changes, CSV import/export, file downloads, API keys, webhooks and permanent deletions.
- Login throttling per IP, per IP and account, and per account; constant-time response for unknown emails; malformed cookies no longer cause server errors.
- Content-Security-Policy, X-Frame-Options and related headers, HSTS with `COOKIE_SECURE=1`, and real client IPs behind a local or private-network reverse proxy without extra configuration.
- Rejecting or restoring inbox leads requires the right to create deals; admins can delete leads permanently.
- Attachment storage quotas, and permanent deletion from the trash including history and files.
- Updated `body-parser` and `qs` to fix known denial-of-service advisories.
- Second audit fixes: contact-list presets no longer run a quadratic query that could block the server; CSV imports are capped at `IMPORT_MAX_ROWS` (5000) with indexed name lookups; cross-site checks cover every state-changing request and API routes are case-sensitive (`/API/...` bypassed the check); accepting an inbox lead only matches contacts and companies the employee can see; a browser that signed in before is not locked out when someone fails logins for that account from many addresses.

## 0.2.1 — 2026-10-13

Added a read-only public demo mode with fictional data, a Polza Agency link, and support for hosting the frontend under a path prefix. Local development can proxy API requests to a separately running demo via `OPENCRM_DEV_API_TARGET`.

## 0.2.0 — 2026-10-13

Added scoped API keys, a versioned server-to-server API for leads, pipelines, and deals, idempotent lead creation, and signed outgoing webhooks for new leads and deal changes. Webhook delivery uses a persistent retry queue with an admin-facing log and test action. Added integration settings and documentation.

## 0.1.0 — 2026-10-13

Initial public MVP: deals and customizable pipelines, contacts and companies, tasks, manual activity, inbox and public forms, search, CSV import/export, role and owner visibility controls, attachments, trash, basic analytics, and verified local backups. Includes a fictional demo, npm and Docker Compose setup, and MIT licensing.
