# openpad

A self-hosted clone of [dontpad.com](https://dontpad.com). Every URL is a shared plain-text page: no sign-up, auto-save, and edits that reach everyone on the page in well under a second. It starts with a single `docker compose up` and keeps everything in one SQLite file.

## Quick start

You need Docker with the Compose plugin.

```bash
git clone https://github.com/joaoribeiiro15/Dontpad-Docker.git
cd Dontpad-Docker
docker compose up -d --build
```

Open `http://localhost:3000`, type a name and press **Go**. Share the link: whoever opens it sees and edits the same text.

```bash
docker compose ps                   # wait for "healthy"
docker compose logs -f openpad      # follow the logs
docker compose down                 # stop; the data stays in the openpad-data volume
```

## Features

- **One page per path.** `/meeting`, `/team/notes/2026`: any valid path is a page, created the moment someone writes in it. An empty page is not stored.
- **Real-time sync.** Edits are saved about 250 ms after you stop typing and pushed to everyone else on the page over a live connection. Between two browsers on a local network this takes around 350 ms.
- **Automatic merging.** When two people edit different parts of the page at the same time, both changes are kept. Only edits to the same spot open a dialog, with **Overwrite**, **Discard** and **Copy my text**.
- **Sync and save indicators** in the top-right corner. Sync shows *Live*, *Syncing*, *Reconnecting* or *Offline*. Save shows *Saved*, *Unsaved*, *Saving* or *Not saved*. A counter shows how many people are on the page.
- **Subpages.** `/parent/child` is its own page. A sidebar lists the direct subpages and lets you create new ones.
- **Survives outages.** If the server goes away, your text stays in the editor, the indicators say so, and it is saved as soon as the server is back. While the live connection is down, the page falls back to polling.
- **Light and dark themes**, an optional monospace font, a word and character count, and *Recently opened* pages on the home page (stored only in your browser).
- **Export** as `.txt`, or as a `.zip` with all subpages.
- **Keyboard:** Tab inserts a tab, Ctrl/Cmd+S saves right away, and the browser warns before you leave with unsaved text.

## Configuration

Every variable is optional. With Compose, copy `.env.example` to `.env` and change what you need.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST_PORT` | `3000` | Port published on the host (Compose only) |
| `PORT` | `3000` | HTTP port inside the container |
| `APP_NAME` | `openpad` | Name on the home page and in tab titles |
| `DB_PATH` | `/data/openpad.db` | SQLite file |
| `SYNC_INTERVAL_MS` | `5000` | Fallback polling interval while the live connection is down |
| `REQUEST_TIMEOUT_MS` | `10000` | Browser request timeout |
| `MAX_BODY_BYTES` | `1048576` | Maximum text size of one page, in UTF-8 bytes |
| `MAX_DEPTH` | `10` | Maximum subpage depth |
| `RATE_LIMIT_PER_MIN` | `600` | API requests per IP per minute |
| `MAX_STREAMS_PER_IP` | `20` | Open live connections per IP (one per open tab) |
| `TRUST_PROXY` | `false` | Read the client IP from `X-Forwarded-For` behind a reverse proxy |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |

Someone typing non-stop sends about one save per second. The default rate limit leaves plenty of room for several tabs behind the same IP address.

## Exposing it to the internet

Put a reverse proxy with TLS in front of port 3000 and set `TRUST_PROXY=true`, so rate limits use each client's real IP. The live updates use Server-Sent Events, which are plain HTTP. They work through any proxy that does not buffer responses. Caddy needs no extra settings:

```
notes.example.com {
	reverse_proxy localhost:3000
}
```

With Nginx, turn buffering off for `/api/events/`. The server also sends `X-Accel-Buffering: no`.

```nginx
location /api/events/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_read_timeout 1h;
}
```

## API

The API lives on the same origin, under `/api`. Every response carries `Cache-Control: no-store`.

| Method and route | Purpose | Response |
| --- | --- | --- |
| `GET /api/body/<path>?lastModified=<n>` | Read the text if it changed since `n` | `{"changed": false, "lastModified": n}` or `{"changed": true, "lastModified": m, "body": "..."}` |
| `POST /api/body/<path>` | Save `text`, `lastModified` and `force` as `x-www-form-urlencoded` | The new `lastModified` as a JSON number |
| `GET /api/events/<path>` | Live updates (Server-Sent Events) | `hello` and `change` with `{"lastModified"}`, `presence` with `{"count"}` |
| `GET /api/menu/<path>` | Direct subpages | `["meeting", "shopping"]`, unordered |
| `GET /api/zip/<path>` | The page and its subpages, one `.txt` each | `application/zip` |
| `GET /api/config` | Browser configuration | `{"appName", "syncIntervalMs", "requestTimeoutMs", "maxBodyBytes", "maxDepth"}` |
| `GET /healthz` | Health check | `{"status": "ok"}` |

Errors when saving:

| Situation | Status | Body |
| --- | --- | --- |
| `lastModified` differs from the server's and `force=false` | 409 | `{"error":"update-timestamp-mismatch"}` |
| Text larger than `MAX_BODY_BYTES` | 413 | `{"error":"body-too-large"}` |
| Path nested too deeply | 400 | `{"error":"nesting-limit-reached"}` |
| Invalid or reserved path | 400 | `{"error":"invalid-path"}` |
| Rate limit exceeded | 429 | `{"error":"rate-limited"}` |

Example:

```bash
curl "http://localhost:3000/api/body/meeting?lastModified=0"
curl -X POST --data-urlencode "text@notes.txt" -d lastModified=0 -d force=true http://localhost:3000/api/body/meeting
curl -N http://localhost:3000/api/events/meeting
```

### Path rules

- The path is the decoded URL pathname, without a trailing slash and with repeated slashes collapsed.
- Paths are case-sensitive.
- At most 255 characters and `MAX_DEPTH` segments.
- The first segments `api`, `assets`, `healthz` and `robots.txt` are reserved.
- The segments `.` and `..` and control characters are rejected.

## How sync works

1. Each page has a version number, `lastModified`, generated by the server on every save. It never repeats and never goes back.
2. The browser saves the whole text together with the version it was based on. If someone else saved in the meantime, the server answers 409.
3. On a 409, the browser fetches the latest text and does a three-way merge between the last common version, its own text and the server's. Edits in different places are combined and saved straight away. Overlapping edits open the conflict dialog.
4. After every save the server pushes a `change` event to everyone else on that page, and their browsers fetch the new text immediately. Incoming text is merged into anything they are still typing, keeping the caret and scroll position.
5. A tab in the background does not fetch anything; it catches up as soon as it is visible again.

## Backups

A consistent copy while the service is running:

```bash
docker compose exec openpad node -e "require('better-sqlite3')('/data/openpad.db').backup('/data/backup.db').then(()=>console.log('ok'))"
docker compose cp openpad:/data/backup.db ./backup.db
```

To restore: `docker compose down`, copy the file into the volume as `openpad.db`, and start again.

## Security

As with the original, anyone who knows a URL can read and write it: the page name is the only secret. Use names that are hard to guess, such as the ones from **Random page**. The measures below protect the service, not the content.

- Page text only reaches the DOM through `textarea.value` and `textContent`, never `innerHTML`.
- Prepared statements with parameters only.
- Per-IP rate limit on the API and a per-IP cap on live connections, both answering 429. The browser backs off up to 60 seconds and recovers after a success.
- Per-page size limit and a request body limit on the server.
- `Content-Security-Policy: default-src 'self'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and `X-Frame-Options: DENY`.
- `robots.txt` blocks everything, and editing pages and the API send `X-Robots-Tag: noindex`.
- The process runs as the `node` user. With Compose the container filesystem is read-only except `/data` and `/tmp`, with no capabilities.
- Logs record the method, route pattern, status and duration. They never record a page path or its text.

## Development

Requires Node.js 22.2 or later.

```bash
npm install
npm run dev                      # http://localhost:3000, database in ./data/openpad.db
npm test                         # unit and API tests (node --test)
npx playwright install chromium  # once
npm run test:e2e                 # end-to-end tests with two browsers
```

The end-to-end tests start their own server by default. To run them against the container:

```bash
BASE_URL=http://localhost:3000 npm run test:e2e
```

Project layout:

```
src/
  server.js        startup and graceful shutdown
  app.js           Fastify setup, headers, logging, errors
  config.js        environment variables
  paths.js         path normalisation and validation, lastModified rule
  db.js            SQLite (WAL), schema, prepared statements, menu query
  events.js        live-update hub (Server-Sent Events)
  zip.js           dependency-free .zip writer
  routes/api.js    body, events, menu, config, zip, rate limit
  routes/pages.js  index.html, pad.html, robots.txt, healthz
public/
  index.html, pad.html
  assets/          base.css, home.css, pad.css, theme.js, home.js, pad.js, merge.js, icons/
test/
  paths.test.js, db.test.js, merge.test.js, api.test.js
  e2e/sync.spec.js
```

The workflow in `.github/workflows/ci.yml` runs the unit, API and end-to-end tests. It then builds the image, runs a smoke test, repeats the end-to-end tests against the container, and publishes the image to `ghcr.io/joaoribeiiro15/dontpad-docker` on every push to `main`.

## License

MIT.
