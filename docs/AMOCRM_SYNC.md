# Keeping amoCRM and OpenCRM in sync

While a team moves from amoCRM, both CRMs can run side by side. The sync (`server/amocrm-sync.js`) runs inside OpenCRM and is off by default.

**Stage 1 (now): amoCRM → OpenCRM.** Changes made in amoCRM appear in OpenCRM within a minute. Nothing is written to amoCRM yet; changes made only in OpenCRM are logged as `pending_to_amo` for stage 2.

## Settings

The same connection as the history load: `AMO_BASE_URL`, `AMO_ACCESS_TOKEN`, `AMO_PROXY_URL`, `AMO_RPS`. Then, in `.env`:

| Variable | Default | Meaning |
|---|---|---|
| `AMOCRM_SYNC_MODE` | `off` | `off`; `dry_run` — read and compare, only write the log; `amo_to_opencrm`; `both` — for now the same as `amo_to_opencrm` |
| `AMOCRM_SYNC_PRIMARY` | `amo` | Whose value wins when a field changed in both CRMs: `amo` or `opencrm` |
| `AMOCRM_SYNC_SINCE` | — | Where the first run starts reading amoCRM changes (ISO time), e.g. when the export of the last load began. Without it: from the start of the sync |
| `AMOCRM_SYNC_INTERVAL_SEC` | `60` | Pause between runs (15–3600) |
| `AMOCRM_SYNC_OVERLAP_SEC` | `120` | Every run reads this much before the cursor again, so nothing is lost to clock skew or slow amoCRM indexes |
| `AMOCRM_SYNC_DEFAULT_OWNER_ID` | — | Owner for records whose amoCRM employee has no account here |

`dry_run` and the other modes keep separate cursors and separate "what would be" states, so a dry run leaves nothing behind for the real one.

## How it works

Every run reads from amoCRM what changed since the cursor: companies, contacts, deals (with contacts and loss reasons), tasks, notes of deals, contacts and companies, and the card events. It goes through the same transform as the one-time move (`scripts/amocrm-lib.mjs`), so stages 142/143, custom fields and lists, phones, e-mails, Telegram, task types and texts, and note texts are mapped exactly as in the move. New records keep their amoCRM numbers. A number at or above OpenCRM's own counter of that table is not created (error in the log): the counters are never moved. Stages and pipelines new in amoCRM are created first, with their amoCRM IDs and order, so a deal never lands in another stage; a deal whose stage still cannot be found is skipped and retried.

The sync compares **states**, not events. `amocrm_sync_links` keeps, per record, the state last seen equal in both CRMs (for records of the move it starts as their OpenCRM state). For every field, and for every custom field separately:

- changed only in amoCRM → copied to OpenCRM;
- changed only in OpenCRM → left as it is, logged as `pending_to_amo`;
- changed in both, differently → `AMOCRM_SYNC_PRIMARY` wins. The conflict goes to the log; when amoCRM wins, the lost OpenCRM value also goes to a note in the deal, contact or company.

A record read twice matches its snapshot and is left alone. Custom fields that exist only in OpenCRM are never touched.

A record that fails — a database error, a number above the counter, an unknown stage, a note whose record is not here — goes to `amocrm_sync_retry` and is read again from amoCRM by its ID in later cycles (after 1, 2, 4… minutes, at most an hour apart), so the moving cursor does not lose it. After 10 attempts it leaves the queue with a `gave_up` error in the log.

Writes go to the database directly: no stage transition rules, no distribution, no stage tasks. Stage history, `closed_at` and webhooks come from the usual triggers, and the stage history names the amoCRM employee who changed the deal. Card history comes from the amoCRM events, as in the move. Notes are only added, never changed. A deal, contact, company or task deleted in amoCRM goes to the OpenCRM trash. Note edits are not carried over. Mail and Mango calls are not synced.

## Status and log

- `GET /api/v1/sync/status` (any key with `deals:read`): `mode`, `primary`, `cursor`, `lag_seconds.amo_to_opencrm`, `errors_last_hour`, `conflicts_last_hour`, `retry_queue`, `last_ok_at`, `last_error`, `last_counts`. For alerts: the lag growing past a few intervals, or errors.
- `GET /api/v1/sync/log?after=<id>&limit=<n>&action=<action>&entity_type=<type>&amo_id=<id>`: `create`, `update`, `delete`, `restore`, `conflict`, `pending_to_amo`, `field_created`, `stage_created`, `warning`, `error`. Each entry has `dry_run`, `entity_type`, `amo_id`, `details` (the fields written, or the conflict with both values). Kept 30 days.
- The same for administrators in the interface session: `GET /api/sync/status`, `GET /api/sync/log`.

## Turning it on

1. Reload amoCRM into OpenCRM (`load --replace`) and note when the export began.
2. Make sure the counters of deals, contacts, companies and tasks are at 50 000 001 and those of notes at 500 000 001 or above, so amoCRM numbers stay below them.
3. `AMOCRM_SYNC_MODE=dry_run`, `AMOCRM_SYNC_SINCE=<export start>`, restart. Read the log for a day: it should only show real changes made by managers in amoCRM.
4. `AMOCRM_SYNC_MODE=amo_to_opencrm`, restart. OpenCRM is now a live copy of amoCRM.
