# Milaclone: a self-hosted Milanote-style canvas board

An infinite visual canvas for notes, to-do lists, links, images, columns, and
nested boards. Runs as a small Node.js app with **no frontend build step** —
clone, `npm install`, `node server.js`. Your data lives in a single SQLite file
on disk, so it's trivial to back up and fully yours.

## Features

- Infinite pan/zoom canvas with a dotted grid
- Cards: **Note**, **To-do**, **Link**, **Comment**, **Image**, **Upload** (files),
  **Column**, **Board** (nested sub-canvas with Lucide icons)
- Nested boards with clickable breadcrumb navigation (Home / … / …)
- Drag cards freely, drag them in and out of columns, resize, recolor
- Customizable board icons (Lucide) + 12-color palette
- Right-click menu: copy, cut, paste, duplicate, rename, lock position, trash
- Everything autosaves to SQLite under `data/`
- Per-board camera position remembered in your browser

## Requirements

- Node.js 18 or newer (`node --version` to check)
- No database server and no Python needed. The only native dependency is
  [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3), which ships
  prebuilt binaries for common platforms; on other platforms `npm install`
  compiles it, which needs a C++ toolchain (`build-essential` on Debian/Ubuntu).

## Run it

```bash
npm install
npm start
```

Then open <http://localhost:4321>.

To use a different port:

```bash
PORT=8080 node server.js
```

## Run it with Docker

Same shape as the `reflections` deployment: its own Compose project, resource
capped, bound to loopback only, published to the tailnet by a Tailscale
sidecar. Two services come up — `app` (the Node server) and `tailscale` (its
own tailnet node).

The sidecar needs an auth key, so create a `.env` next to `docker-compose.yml`
first (it's gitignored):

```bash
echo 'TS_AUTHKEY=tskey-auth-…' > .env
```

Generate the key at
[login.tailscale.com/admin/settings/keys](https://login.tailscale.com/admin/settings/keys).
A reusable key is easiest; the node's state lives in the `milaclone_ts_state`
volume, so it won't need to re-authenticate on restart. Then:

```bash
docker compose up -d --build
```

The app itself listens on `127.0.0.1:8182` only — not on the LAN, not directly
on the tailnet (`8181` is taken by `reflections`). The sidecar is what puts it
on the tailnet, over HTTPS, at <https://mila.your-tailnet.ts.net> — see
[Access over Tailscale](#access-over-tailscale) below. On iPhone, Share → Add
to Home Screen gives it an app icon that opens fullscreen.

Data lives in three named volumes, so `docker compose down` keeps it:

| Volume                | Mounted at              | Holds                     |
|-----------------------|-------------------------|---------------------------|
| `milaclone_data`      | `/data`                 | `board.db` (SQLite)       |
| `milaclone_uploads`   | `/app/public/uploads`   | uploaded images/files     |
| `milaclone_ts_state`  | `/var/lib/tailscale`    | the sidecar's node identity |

Back up the board with:

```bash
docker compose cp app:/data/board.db ./backup-$(date +%F).db
```

To ship a new version, see [Deploying to the server](#deploying-to-the-server).
`docker compose down -v` wipes the volumes and resets to a blank canvas — it
also drops the tailnet node identity, so the next start re-authenticates.

## Access over Tailscale

### With Docker: the Tailscale sidecar

The Compose stack runs a `tailscale` service alongside the app. It joins your
tailnet as **its own node** — not as a path on the host's node — so the board
gets a clean URL of its own with `/` as the root:

```
https://mila.your-tailnet.ts.net
```

That matters because the app serves absolute paths (`/style.css`, `/uploads/*`),
which break under a path-prefixed proxy.

How the pieces fit:

| Piece                    | Where                              | Does what                                        |
|--------------------------|------------------------------------|--------------------------------------------------|
| `TS_AUTHKEY`             | `.env` (gitignored)                | Authenticates the node on first start            |
| `TS_HOSTNAME=mila`       | `docker-compose.yml`               | Names the node → `mila.your-tailnet.ts.net`      |
| `tailscale/serve.json`   | mounted at `/config/serve.json`    | Terminates HTTPS, proxies `/` → `app:4321`       |
| `milaclone_ts_state`     | volume at `/var/lib/tailscale`     | Remembers the node so restarts don't re-auth     |

The Serve config uses `${TS_CERT_DOMAIN}`, which the container substitutes at
startup, so it works on any tailnet without editing. Tailscale provisions the
TLS certificate itself. To change the hostname, edit `TS_HOSTNAME` and run
`docker compose up -d` — the node is renamed on next start.

Checking and troubleshooting:

```bash
docker compose logs tailscale                      # auth + serve errors show here
docker compose exec tailscale tailscale status     # is the node up?
docker compose exec tailscale tailscale serve status  # is / proxied to app:4321?
```

If `docker compose up` fails immediately with `set TS_AUTHKEY in .env`, the
`.env` file is missing or empty. If the node appears on the tailnet but the URL
returns nothing, the Serve config didn't load — check that `tailscale/serve.json`
exists as a **file** (a missing file makes Docker create an empty directory in
its place) and is valid JSON.

Traffic reaches the app over the private Compose network, so the app's
`127.0.0.1:8182` binding stays loopback-only and is never exposed.

### Without Docker: `tailscale serve` on the host

Running `npm start` directly, the server binds to `0.0.0.0`, so once the box is
on your tailnet it's reachable at `http://my-server.your-tailnet.ts.net:4321`
(`tailscale ip -4` or the MagicDNS name). For a clean HTTPS URL instead of
`:4321`:

```bash
sudo tailscale serve --bg 4321
```

That proxies `https://my-server.your-tailnet.ts.net` to the app on the host's
own tailnet node. `tailscale serve status` shows the mapping and
`sudo tailscale serve --bg off` stops it. Don't combine this with the sidecar —
pick one or the other.

## Deploying to the server

The server runs from a git checkout, so deploying is: move the checkout to the
commit you want, then rebuild the image. Code is baked into the image at build
time, so `docker compose restart` alone will **not** pick up changes.

Deploy the latest `main`:

```bash
cd ~/milaclone                  # wherever the checkout lives
git fetch origin
git checkout main
git pull --ff-only
docker compose up -d --build
```

Deploy a feature branch instead (e.g. to try a PR on the real device):

```bash
git fetch origin
git switch -c magicDNS origin/magicDNS   # first time for that branch
# git switch magicDNS && git pull --ff-only   # every time after
docker compose up -d --build
```

If `git checkout` refuses because the working tree is dirty — usually an edit
made directly on the server — either keep it with `git stash` (then
`git stash pop` later) or discard it with `git checkout -- .`.

Verify it came up:

```bash
docker compose ps                    # app + tailscale both "running"
curl -s localhost:8182/api/health    # {"ok":true}
docker compose logs -f app           # ctrl-C to stop following
```

Roll back by pointing the same loop at the previous commit:

```bash
git checkout <previous-sha>          # `git log --oneline` to find it
docker compose up -d --build
```

Worth knowing:

- **Your data survives.** The named volumes aren't touched by a rebuild, so
  boards and uploads carry across deploys and rollbacks. Never use
  `docker compose down -v` to deploy — that deletes them.
- **Most rebuilds are fast.** `npm ci` is a cached layer keyed on
  `package.json` / `package-lock.json`; only dependency changes trigger the slow
  path where `better-sqlite3` recompiles.
- **Only `app` rebuilds.** The `tailscale` service runs a published image, so
  `--build` leaves it alone unless its own config changed.
- **Rebuild after editing `public/`.** The frontend has no build step, but it's
  copied into the image, so a browser refresh alone won't show server-side
  changes until you rebuild.
- **Live-editing on the server:** `docker compose watch` syncs `public/` into the
  running container and restarts the backend on `server.js` / `routes.js` /
  `db.js` edits. Good for poking at something, but changes live only in that
  container until you commit and rebuild.

## Run it as a service (auto-start on boot)

Create `/etc/systemd/system/canvas-board.service` (adjust the paths and user):

```ini
[Unit]
Description=Canvas Board
After=network.target

[Service]
Type=simple
User=YOUR_USERNAME
WorkingDirectory=/home/YOUR_USERNAME/canvas-board
ExecStart=/usr/bin/node server.js
Environment=PORT=4321
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now canvas-board
sudo systemctl status canvas-board
```

## Your data & backups

- Board content: `data/board.db` (SQLite; WAL mode also writes
  `board.db-wal` and `board.db-shm` alongside it)
- Uploaded images/files: `public/uploads/`

Back up those paths and you've backed up everything. To reset to a blank
canvas, stop the server and delete `data/board.db` (it'll be recreated on next
start).

## Configuration

All optional, via environment variables:

| Variable     | Default              | Purpose                          |
|--------------|----------------------|----------------------------------|
| `PORT`       | `4321`               | Port to listen on                |
| `HOST`       | `0.0.0.0`            | Bind address                     |
| `DATA_DIR`   | `./data`             | Where the SQLite DB is written   |

Uploads always go to `public/uploads/` (they're served as static files from
there, so the path isn't configurable).

## Tech stack

- **Backend:** [Express](https://expressjs.com/) with
  [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) for storage and
  [`multer`](https://github.com/expressjs/multer) for uploads
- **Frontend:** vanilla JavaScript, HTML, and CSS in `public/` — no bundler, no
  framework

## Import from Milanote

Milanote’s markdown export has no layout data, so this is a one-shot CLI that
creates nested boards / notes / todos / links via the running app’s API (grid
positions; rearrange in the UI after). Copy your `.md` files onto a machine
that can reach the server, then:

```bash
node scripts/import-milanote-md.js \
  --base http://127.0.0.1:8182 \
  business-ideas.md creative-projects.md therapy.md writing.md
```

Use your Tailscale URL for `--base` if you’re not on the host. Optional
`--parent <canvasId>` targets a board other than Home. Images are uploaded when
the Milanote CDN allows the fetch; otherwise a link card is kept. Running twice
duplicates — there is no idempotency.

## Development

```bash
npm test        # unit/API tests (node --test)
npm run test:e2e   # Playwright end-to-end tests
```

The Playwright tests drive a real browser, so run
`npx playwright install` once beforehand to fetch the browser binaries.

## Not included (yet)

These were left out to keep the first version small and focused; they're
natural next additions: line/arrow connectors between cards, freehand
drawing/sketch cards, multi-select, and real-time multi-user sync (the current
model is single-document, last-write-wins — great for one person across their
own devices).

## Keyboard shortcuts

- `N` note · `L` link · `T` to-do · `B` board · `C` column · `M` comment
- `⌘/Ctrl+C` copy · `⌘/Ctrl+X` cut · `⌘/Ctrl+V` paste · `⌘/Ctrl+D` duplicate
- `Enter` rename selected card · `Esc` deselect / cancel armed tool
- `Delete` / `Backspace` remove the selected card (when not typing)

## License

[MIT](LICENSE)
