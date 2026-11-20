# Changelog

## Unreleased — security hardening

- Admins can disable employees, set a new password, end all of an employee's sessions and reset their two-factor sign-in; disabling or resetting ends sessions immediately. A server-side `npm run admin` command recovers a locked-out administrator.
- Everyone can change their password, end sessions on other devices, and turn on TOTP two-factor sign-in.
- Permissions are now denied unless granted. New members can create and edit but not delete or export by default; existing members keep their previous effective rights.
- Security log for sign-ins, failed attempts, user and permission changes, CSV import/export, file downloads, API keys, webhooks and permanent deletions.
- Login throttling per IP, per IP and account, and per account; constant-time response for unknown emails; malformed cookies no longer cause server errors.
- Content-Security-Policy, X-Frame-Options and related headers, HSTS with `COOKIE_SECURE=1`, and `TRUST_PROXY` for correct client IPs behind a proxy.
- Rejecting or restoring inbox leads requires the right to create deals; admins can delete leads permanently.
- Attachment storage quotas, and permanent deletion from the trash including history and files.
- Updated `body-parser` and `qs` to fix known denial-of-service advisories.

## 0.2.1 — 2026-10-13

Added a read-only public demo mode with fictional data, a Polza Agency link, and support for hosting the frontend under a path prefix. Local development can proxy API requests to a separately running demo via `OPENCRM_DEV_API_TARGET`.

## 0.2.0 — 2026-10-13

Added scoped API keys, a versioned server-to-server API for leads, pipelines, and deals, idempotent lead creation, and signed outgoing webhooks for new leads and deal changes. Webhook delivery uses a persistent retry queue with an admin-facing log and test action. Added integration settings and documentation.

## 0.1.0 — 2026-10-13

Initial public MVP: deals and customizable pipelines, contacts and companies, tasks, manual activity, inbox and public forms, search, CSV import/export, role and owner visibility controls, attachments, trash, basic analytics, and verified local backups. Includes a fictional demo, npm and Docker Compose setup, and MIT licensing.
