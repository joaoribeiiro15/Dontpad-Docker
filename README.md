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
- **Shared files in floating windows.** Drag files onto a page, paste them, or use the paperclip. Each file appears for everyone on the page, in real time, in a small window that floats over the page. Anyone can drag a window around, and everyone sees it move. Any file type works.
- **Image previews.** A dropped image shows up straight away as a lighter preview (at most 1280 px, made in the uploader's browser) and opens larger on click. **Download original** always returns the exact file that was uploaded, at full quality.
- **Files are temporary.** They are kept only in the server's memory, never on disk. Each one expires after `FILE_TTL_MS` (6 hours by default), and a restart, crash or redeploy clears them all. The page text itself is stored permanently as before.
- **Export** as `.txt`, or as a `.zip` with all subpages.
- **Delete a page for everyone** from the **⋯** menu. Everyone on the page watches the text crumble away and the shared windows fall, then all of them are sent to the home page. The page's text and shared files are deleted; subpages are kept. A browser that was offline at the time can't quietly bring the old text back: it gets the same "This page was deleted" screen when it reconnects. Anyone can still start a new page at that address from scratch.
- **Your own address.** The first time someone opens the home page, it asks which address people will use, for example `notes.example.com` or `192.168.1.20:3000`. That address is shown in front of the page name on the home page and used by **Copy link**, and it is saved in the database, so it survives restarts and rebuilds.
- **Keyboard:** Tab inserts a tab, Ctrl/Cmd+S saves right away, and the browser warns before you leave with unsaved text.

## Configuration

Every variable is optional. With Compose, copy `.env.example` to `.env` and change what you need.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST_PORT` | `3000` | Port published on the host (Compose only) |
| `PORT` | `3000` | HTTP port inside the container |
| `APP_NAME` | `openpad` | Name on the home page and in tab titles |
| `PUBLIC_ADDRESS` | *(empty)* | Fixed public address, such as `notes.example.com`. When set, the first-run question is skipped and this value always wins |
| `DB_PATH` | `/data/openpad.db` | SQLite file |
| `SYNC_INTERVAL_MS` | `5000` | Fallback polling interval while the live connection is down |
| `REQUEST_TIMEOUT_MS` | `10000` | Browser request timeout |
| `MAX_BODY_BYTES` | `1048576` | Maximum text size of one page, in UTF-8 bytes |
| `MAX_DEPTH` | `10` | Maximum subpage depth |
| `RATE_LIMIT_PER_MIN` | `600` | API requests per IP per minute |
| `MAX_STREAMS_PER_IP` | `20` | Open live connections per IP (one per open tab) |
| `MAX_FILE_BYTES` | `10485760` | Largest shared file (10 MB) |
| `MAX_FILES_PER_PAGE` | `20` | Shared files on one page at a time |
| `MAX_FILES_TOTAL_BYTES` | `268435456` | Memory used by all shared files together (256 MB). New uploads get 507 when it is full |
| `FILE_TTL_MS` | `21600000` | How long a shared file lives (6 hours) |
| `TRUST_PROXY` | `false` | Read the client IP from `X-Forwarded-For` behind a reverse proxy |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |

Someone typing non-stop sends about one save per second. The default rate limit leaves plenty of room for several tabs behind the same IP address.

Shared files live in the process's memory, so give the container at least `MAX_FILES_TOTAL_BYTES` plus about 100 MB of RAM.

### Public address

On a fresh install the home page asks for the address once. Without a scheme, local names and IP addresses get `http://` and domains get `https://`. You can also type the scheme yourself. To see or change it later:

```bash
docker compose exec openpad node src/cli.js address                     # show it
docker compose exec openpad node src/cli.js address notes.example.com   # change it
docker compose exec openpad node src/cli.js address --reset             # ask again on the home page
```

Until someone answers, anyone who opens the home page can set the address, so answer it right after the first `docker compose up`, or set `PUBLIC_ADDRESS` in `.env`.

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

Nginx also rejects uploads over 1 MB by default. To allow shared files, set `client_max_body_size 13m;` (`MAX_FILE_BYTES` plus room for the 2 MB image preview).

## API

The API lives on the same origin, under `/api`. Every response carries `Cache-Control: no-store`.

| Method and route | Purpose | Response |
| --- | --- | --- |
| `GET /api/body/<path>?lastModified=<n>` | Read the text if it changed since `n` | `{"changed": false, "lastModified": n}` or `{"changed": true, "lastModified": m, "body": "..."}` |
| `POST /api/body/<path>` | Save `text`, `lastModified` and `force` as `x-www-form-urlencoded` | The new `lastModified` as a JSON number |
| `DELETE /api/body/<path>` | Delete the page and its shared files for everyone; subpages are kept | `{"deleted": true, "existed", "removedFiles", "kicked"}` |
| `POST /api/setup` | First-run setup: JSON `{"address": "notes.example.com"}`. Works only once | `{"publicAddress", "host"}` |
| `GET /api/events/<path>` | Live updates (Server-Sent Events) | `hello` and `change` with `{"lastModified"}`, `presence` with `{"count"}`, `deleted` (the last event before the stream closes), `file-added` with the file, `file-moved` with `{"id", "x", "y", "z"}`, `file-removed` with `{"id"}` |
| `GET /api/files/<path>` | The page's shared files | An array of `{"id", "name", "type", "size", "x", "y", "z", "expiresAt", "preview", ...}` |
| `POST /api/files/<path>?x=&y=` | Share a file. The body is the raw bytes (`application/octet-stream`). The name goes in `X-File-Name`, URI-encoded, and the type in `X-File-Type`. `x` and `y` are fractions from 0 to 1 | 201 with the file |
| `GET /api/file/<id>` | Download the original, byte for byte | `application/octet-stream`, as an attachment |
| `GET /api/file/<id>/preview` | The light image preview | The image, or 404 `no-preview` if the file has none |
| `PATCH /api/file/<id>` | Move a window: JSON `{"x", "y", "front"}` | `{"id", "x", "y", "z"}` |
| `DELETE /api/file/<id>` | Remove a file for everyone | `{"removed": id}` |
| `GET /api/menu/<path>` | Direct subpages | `["meeting", "shopping"]`, unordered |
| `GET /api/zip/<path>` | The page and its subpages, one `.txt` each | `application/zip` |
| `GET /api/config` | Browser configuration | `{"appName", "syncIntervalMs", "requestTimeoutMs", "maxBodyBytes", "maxDepth", "maxFileBytes", "maxFilesPerPage", "fileTtlMs", "publicAddress"}` |
| `GET /healthz` | Health check | `{"status": "ok"}` |

Errors when saving:

| Situation | Status | Body |
| --- | --- | --- |
| `lastModified` differs from the server's and `force=false` | 409 | `{"error":"update-timestamp-mismatch"}` |
| Text larger than `MAX_BODY_BYTES` | 413 | `{"error":"body-too-large"}` |
| Path nested too deeply | 400 | `{"error":"nesting-limit-reached"}` |
| Invalid or reserved path | 400 | `{"error":"invalid-path"}` |
| Rate limit exceeded | 429 | `{"error":"rate-limited"}` |
| The page was deleted (in the last 15 minutes) after this version was loaded | 410 | `{"error":"page-deleted"}` |

Errors when sharing a file:

| Situation | Status | Body |
| --- | --- | --- |
| File larger than `MAX_FILE_BYTES` | 413 | `{"error":"file-too-large"}` |
| Page already has `MAX_FILES_PER_PAGE` files | 409 | `{"error":"too-many-files"}` |
| `MAX_FILES_TOTAL_BYTES` reached | 507 | `{"error":"storage-full"}` |
| Empty file | 400 | `{"error":"empty-file"}` |
| Unknown or expired id | 404 | `{"error":"file-not-found"}` |

Example:

```bash
curl "http://localhost:3000/api/body/meeting?lastModified=0"
curl -X POST --data-urlencode "text@notes.txt" -d lastModified=0 -d force=true http://localhost:3000/api/body/meeting
curl -N http://localhost:3000/api/events/meeting
curl -X POST -H "content-type: application/octet-stream" -H "x-file-name: report.pdf" --data-binary @report.pdf http://localhost:3000/api/files/meeting
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

As with the original, anyone who knows a URL can read, write and delete it: the page name is the only secret. Use names that are hard to guess, such as the ones from **Random page**. The measures below protect the service, not the content.

- Page text only reaches the DOM through `textarea.value` and `textContent`, never `innerHTML`.
- Prepared statements with parameters only.
- Per-IP rate limit on the API and a per-IP cap on live connections, both answering 429. The browser backs off up to 60 seconds and recovers after a success.
- Per-page size limit and a request body limit on the server.
- Shared files are always downloaded as attachments with `application/octet-stream` and a sandboxing CSP, so an uploaded HTML or SVG file never runs on this origin. Inline previews are only served for raster images (no SVG). File names only reach the DOM through `textContent`.
- Shared files have a per-file, per-page and total memory limit, and expire on their own.
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
