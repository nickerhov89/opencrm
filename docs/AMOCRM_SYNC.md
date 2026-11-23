# Keeping amoCRM and OpenCRM in sync

While a team moves from amoCRM, both CRMs can run side by side. The sync (`server/amocrm-sync.js`) runs inside OpenCRM and is off by default.

**amoCRM → OpenCRM** (`amo_to_opencrm`): changes made in amoCRM appear in OpenCRM within a minute; changes made only in OpenCRM are logged as `pending_to_amo`.

**Both ways** (`both`, stage 2): in addition, what changes in OpenCRM is written to amoCRM through API v4. Writing has its own trial switch, `AMOCRM_SYNC_TO_AMO`: `dry_run` (the default) only logs the requests it would send, `on` sends them.

## Settings

The same connection as the history load: `AMO_BASE_URL`, `AMO_ACCESS_TOKEN`, `AMO_PROXY_URL`, `AMO_RPS`. Then, in `.env`:

| Variable | Default | Meaning |
|---|---|---|
| `AMOCRM_SYNC_MODE` | `off` | `off`; `dry_run` — read and compare, only write the log; `amo_to_opencrm`; `both` — also OpenCRM → amoCRM |
| `AMOCRM_SYNC_TO_AMO` | `dry_run` | Mode `both`: `dry_run` — log what would be written to amoCRM; `on` — write |
| `AMOCRM_SYNC_PRIMARY` | `amo` | Whose value wins when a field changed in both CRMs: `amo` or `opencrm` |
| `AMOCRM_SYNC_SINCE` | — | Where the first run starts reading amoCRM changes (ISO time), e.g. when the export of the last load began. Without it: from the start of the sync |
| `AMOCRM_SYNC_INTERVAL_SEC` | `60` | Pause between runs (15–3600) |
| `AMOCRM_SYNC_OVERLAP_SEC` | `120` | Every run reads this much before the cursor again, so nothing is lost to clock skew or slow amoCRM indexes |
| `AMOCRM_SYNC_DEFAULT_OWNER_ID` | — | Owner for records whose amoCRM employee has no account here |
| `AMOCRM_SYNC_NATIVE_FROM` | `50000001` | Deals, contacts, companies and tasks made in OpenCRM have numbers from here |
| `AMOCRM_SYNC_NATIVE_NOTES_FROM` | `500000001` | The same for notes |

`dry_run` and the other modes keep separate cursors and separate "what would be" states, so a dry run leaves nothing behind for the real one.

## How it works

Every run reads from amoCRM what changed since the cursor: companies, contacts, deals (with contacts and loss reasons), tasks, notes of deals, contacts and companies, and the card events. It goes through the same transform as the one-time move (`scripts/amocrm-lib.mjs`), so stages 142/143, custom fields and lists, phones, e-mails, Telegram, task types and texts, and note texts are mapped exactly as in the move. New records keep their amoCRM numbers. A number at or above OpenCRM's own counter of that table is not created (error in the log): the counters are never moved. Stages and pipelines new in amoCRM are created first, with their amoCRM IDs and order, so a deal never lands in another stage; a deal whose stage still cannot be found is skipped and retried.

The sync compares **states**, not events. `amocrm_sync_links` keeps, per record, the state last seen equal in both CRMs (for records of the move it starts as their OpenCRM state). For every field, and for every custom field separately:

- changed only in amoCRM → copied to OpenCRM;
- changed only in OpenCRM → left as it is, logged as `pending_to_amo` (in mode `both` it is written to amoCRM instead, see below);
- changed in both, differently → `AMOCRM_SYNC_PRIMARY` wins. The conflict goes to the log; when amoCRM wins, the lost OpenCRM value also goes to a note in the deal, contact or company.

A record read twice matches its snapshot and is left alone. Custom fields that exist only in OpenCRM are never touched.

A record that fails — a database error, a number above the counter, an unknown stage, a note whose record is not here — goes to `amocrm_sync_retry` and is read again from amoCRM by its ID in later cycles (after 1, 2, 4… minutes, at most an hour apart), so the moving cursor does not lose it. After 10 attempts it leaves the queue with a `gave_up` error in the log.

Writes go to the database directly: no stage transition rules, no distribution, no stage tasks. Stage history, `closed_at` and webhooks come from the usual triggers, and the stage history names the amoCRM employee who changed the deal. Card history comes from the amoCRM events, as in the move. Notes are only added, never changed. A deal, contact, company or task deleted in amoCRM goes to the OpenCRM trash. Note edits are not carried over. Mail and Mango calls are not synced.

## OpenCRM → amoCRM (mode `both`)

Every run first takes the amoCRM changes, then looks at OpenCRM: records changed since its own cursor, records made here that amoCRM does not have yet, and records waiting in the retry queue. A record whose state matches its snapshot is skipped without asking amoCRM. The others are read from amoCRM and compared the same way: fields changed only in OpenCRM — and conflicts that OpenCRM wins with `AMOCRM_SYNC_PRIMARY=opencrm` — are written. With `PRIMARY=amo` a conflict goes as before: amoCRM wins.

How values go back:

| OpenCRM | amoCRM |
|---|---|
| Stage | `status_id` and `pipeline_id`; won / lost stages → 142 / 143. «Неразобранное» cannot be set through the API: logged as `unsupported` |
| List field | `enum_id` of the option with the same text; checkbox `Да`/`Нет` → true/false; multi-list by every option |
| Date field | Unix time of midnight in the account's time zone |
| Phone, e-mail | `PHONE` / `EMAIL`, every value; values amoCRM already had keep their type, new ones get `WORK` |
| Telegram | The field the move read it from: the messenger field (`IM`, `TELEGRAM`) or a field named Telegram |
| Task | text = title + new line + description; type → `task_type_id` by name; due, duration, «весь день» (23:59 in the account's time zone); completed with its result |
| Loss reason | `loss_reason_id` by name; a reason amoCRM does not have goes to a note in the deal |
| Owner | The amoCRM user with the same e-mail (or number) |
| Contacts and company of a deal, company of a contact | link / unlink |
| Tags | added / removed one by one |

Records, tasks and notes made in OpenCRM are created in amoCRM; amoCRM gives them its own numbers, and the pair is kept in `amocrm_sync_links` (`amo_id` ≠ `opencrm_id`). Changes coming from amoCRM find such records by the pair. A deal is created after its contacts and company; a link to a record amoCRM does not have yet is made in a later run. Only common notes are copied, and only once; notes the sync writes about conflicts stay here. A record counts as made here when its number is at or above `AMOCRM_SYNC_NATIVE_FROM`, it has no pair and it was created after `AMOCRM_SYNC_SINCE` — records of the move keep their amoCRM numbers, however high.

Deleted in OpenCRM: a deal gets the tag «Удалена в OpenCRM» and goes to «Закрыто и не реализовано», a contact or company gets the tag, a task is completed with the result «Удалена в OpenCRM» (API v4 deletes none of them). Reading such a record back keeps it in the trash here. Restoring it here removes the tag.

**No echo.** After a write the record is read back from amoCRM at once and its snapshot becomes that state. Where amoCRM keeps a value in another shape (a task text, a value that also fills another field), that shape is written to OpenCRM once (`normalized` in the log). So the next run, which reads the same record among the amoCRM changes, finds nothing to copy either way.

Writes share the `AMO_RPS` limit; 429 is retried, a 5xx or network error is retried for PATCH but not for POST (it may have been done). A record that fails goes to the same retry queue (`entity_type` `to_amo:<type>`, the OpenCRM number) and is tried again in later runs. In `dry_run` nothing is sent: the log has, per record, the requests (`details.requests`) it would send, once per distinct change.

Not copied to amoCRM: note edits and deletions, mail, calls, fields that exist only in OpenCRM, files.

## Status and log

- `GET /api/v1/sync/status` (any key with `deals:read`): `mode`, `primary`, `to_amo` (`off`, `dry_run`, `on`), `writes_to_amo`, `cursor`, `lag_seconds.amo_to_opencrm` and `lag_seconds.opencrm_to_amo`, `errors_last_hour`, `conflicts_last_hour`, `retry_queue`, `directions` (errors, conflicts and retry queue per direction), `last_ok_at`, `last_error`, `last_counts` (with `to_amo` for the other direction). For alerts: a lag growing past a few intervals, or errors.
- `GET /api/v1/sync/log?after=<id>&limit=<n>&action=<action>&entity_type=<type>&amo_id=<id>&direction=<amo_to_opencrm|opencrm_to_amo>`: `create`, `update`, `delete`, `restore`, `conflict`, `pending_to_amo`, `field_created`, `stage_created`, `warning`, `error`, and for OpenCRM → amoCRM also `unsupported` and `normalized`. Each entry has `dry_run`, `direction`, `entity_type`, `amo_id`, `opencrm_id`, `details` (the fields written, the conflict with both values, or the requests to amoCRM). Kept 30 days.
- The same for administrators in the interface session: `GET /api/sync/status`, `GET /api/sync/log`.

## Turning it on

1. Reload amoCRM into OpenCRM (`load --replace`) and note when the export began.
2. Make sure the counters of deals, contacts, companies and tasks are at 50 000 001 and those of notes at 500 000 001 or above, so amoCRM numbers stay below them.
3. `AMOCRM_SYNC_MODE=dry_run`, `AMOCRM_SYNC_SINCE=<export start>`, restart. Read the log for a day: it should only show real changes made by managers in amoCRM.
4. `AMOCRM_SYNC_MODE=amo_to_opencrm`, restart. OpenCRM is now a live copy of amoCRM.
5. `AMOCRM_SYNC_MODE=both` (`AMOCRM_SYNC_TO_AMO` stays `dry_run`), restart. Read `GET /api/v1/sync/log?direction=opencrm_to_amo`: the requests should match what employees changed in OpenCRM.
6. `AMOCRM_SYNC_TO_AMO=on`, restart. Changes in OpenCRM now reach amoCRM within a minute.
