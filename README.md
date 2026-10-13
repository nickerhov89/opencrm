# OpenCRM

**A self-hosted, open-source CRM for small sales teams.** Track a lead from the first request to a won or lost deal, with contacts, companies, tasks, and a customizable pipeline in one place.

[Русская документация](README.ru.md) · [API and webhooks](docs/INTEGRATIONS.md) · [MVP scope](docs/MVP_SPEC.md) · [Contributing](CONTRIBUTING.md)

**[Try the live demo on Polza Agency](https://polzaagency.ru/opencrm)** — browse the real interface with fictional data. The public demo is read-only; local demos can be edited.

![OpenCRM pipeline with fictional demo data](docs/board-preview.png)

OpenCRM is an independent project. It is not affiliated with amoCRM and does not use its code, logo, API, or customer data. **The current interface is in Russian.**

## What you can do

- Manage deals on a drag-and-drop pipeline board or in a sortable list; use multiple pipelines, custom stages and fields, ownership, tags, and loss reasons.
- Keep contacts, companies, notes, attachments, manual communication records, and a deal history together.
- Assign tasks, see upcoming and overdue work in list, board, or calendar views, and record completion results.
- Accept leads through a built-in public form, search across records, import/export CSV, and view basic sales reports.
- Create users with roles and ownership-based visibility; restore deleted records from the trash.
- Back up the SQLite database and attachments, verify checksums, and restore into a separate directory.
- Connect external systems with scoped API keys and signed, retried webhooks for leads and deals.

The application is designed for a team running its own instance. The [generic API and webhooks](docs/INTEGRATIONS.md) can connect it to other services. Built-in email, messaging, telephony, and amoCRM synchronization are **not** included; communication records are entered manually and do not send messages.

## Try it locally

Requires Node.js **22.12+** and npm.

```bash
git clone https://github.com/nickerhov89/opencrm.git
cd opencrm
npm ci
npm run build
npm run demo
```

Open [http://127.0.0.1:3002](http://127.0.0.1:3002). The demo uses fictional data in a temporary database and leaves your regular database untouched.

For a public, read-only demo under an existing website path, see [the public demo guide](docs/PUBLIC_DEMO.md).

For a persistent installation, run `npm start` after building and open [http://127.0.0.1:3001](http://127.0.0.1:3001). The first visit asks you to create an administrator. SQLite data and uploads live under `data/` by default. Use `.env.example` to configure paths, host, or port. For development, run `npm run dev` and open [http://127.0.0.1:5173](http://127.0.0.1:5173).

You can also use Docker Compose:

```bash
docker compose up --build -d
```

If Compose is installed as a standalone command, use `docker-compose up --build -d` instead.

Compose binds to `127.0.0.1:3001` by default and keeps data and backups in separate volumes. Complete the first administrator setup while the app is private. To serve other users, put the app behind an HTTPS reverse proxy and set `COOKIE_SECURE=1`. Do not expose the SQLite file or app port directly to the internet. The built-in login throttle is per process; add rate limiting at the reverse proxy if you run multiple replicas.

## Quality and data safety

Run `npm test` and `npm run build` before a change. To create a backup, run `npm run backup`; see [backup and restore instructions](README.ru.md#резервная-копия) for verification and recovery. Always keep a copy outside the host running the CRM.

This is an early release, not a drop-in replacement for amoCRM. The permission model is intentionally simpler: visibility can be restricted by owner, but group- or stage-level access controls and task export controls are not implemented. Historical activity may retain the names of previously related records. See the [full limitations](README.ru.md#ограничения).

Licensed under [MIT](LICENSE). Bug reports and focused contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).
