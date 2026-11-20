# Changelog

## Unreleased — PostgreSQL

- `BACKUP_KEEP=0` keeps no copies on the host: each copy is deleted once S3 confirms it, failed uploads are retried. `backup.mjs restore-s3` restores the newest (or a named) copy straight from S3; every copy includes RESTORE.txt.
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
