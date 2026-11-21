# Contributing to OpenCRM

Thank you for helping improve OpenCRM. Please keep changes focused on the core workflow: lead, contact, company, deal, next task, and outcome.

## Before you start

Search existing issues. For a bug, describe the steps to reproduce it, expected and actual behavior, OpenCRM version, Node.js version, and whether you use npm or Docker. Remove names, emails, tokens, and other customer data from logs and screenshots. For a feature, explain the user problem and why it belongs in a small, self-hosted CRM.

For security vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Local development

```bash
npm ci
npm run dev
```

The first visit to `http://127.0.0.1:5173` creates a local administrator. `npm run build && npm run demo` starts a separate fictional demo on port 3002.

Before submitting a pull request:

```bash
npm test
npm run build
```

Write styles with ordinary colors for the light theme: the build adds a dark twin of every rule that sets a color (`scripts/dark-theme.mjs`), so new screens get the dark theme automatically. Check a new screen in both themes (the «Тема» button in the left menu). Text placed on a color that comes from data (stage colors) needs a hand-written rule in `src/theme.css`.

Add a test when you change API behavior or fix a regression. Update documentation when the user-visible workflow changes. Do not commit `.env`, databases, backups, uploads, API keys, or real customer data. The project uses MIT licensing; by submitting a contribution, you agree that it may be distributed under that license.
