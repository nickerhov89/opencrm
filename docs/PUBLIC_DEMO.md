# Public read-only demo

The public demo uses the regular `scripts/demo.mjs` seed: all people, companies, messages and amounts are fictional. It starts a private OpenCRM server against a temporary SQLite database, then serves the built UI through a proxy that supplies a demo session. This mode must never point at a real CRM database.

Build the image for a path-prefixed deployment:

```bash
docker build \
  --build-arg OPENCRM_BASE_PATH=/opencrm-demo/ \
  --build-arg VITE_PUBLIC_DEMO=1 \
  -t opencrm:public-demo .
```

Start it on a private network with `DEMO_HOST=0.0.0.0`, `DEMO_PORT=3002`, `PUBLIC_DEMO_READ_ONLY=1`, and `node scripts/demo.mjs`. The public proxy should strip `/opencrm-demo` before forwarding requests to port 3002. No public port is needed on the container. The read-only gateway allows GET and HEAD and rejects all mutations with HTTP 405; the UI labels this limitation. The demo database is recreated when the container restarts, so its content remains synthetic and disposable.

For the Polza Agency deployment, the site proxies `/opencrm-demo/:path*` to the private demo service. Its landing page is `/opencrm`, and the demo banner links back to that page. The site Compose service runs the container with a read-only filesystem, an isolated `/tmp`, dropped Linux capabilities, and a memory limit.

The default `npm run demo` remains a localhost-only, editable demonstration for contributors. Do not expose that default mode publicly.
