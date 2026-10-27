# Self-hosting

How to run milaclone on a server, put it on your tailnet, and deploy updates.

## Run it with Docker

Its own Compose project, resource
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
on the tailnet. The sidecar is what puts it
on the tailnet, over HTTPS, at <https://mila.your-tailnet.ts.net> — see
[Access over Tailscale](#access-over-tailscale) below. On iPhone, Share → Add
to Home Screen gives it an app icon that opens fullscreen.

Data lives in three named volumes, so `docker compose down` keeps it:

| Volume               | Mounted at            | Holds                       |
| -------------------- | --------------------- | --------------------------- |
| `milaclone_data`     | `/data`               | `board.db` (SQLite)         |
| `milaclone_uploads`  | `/app/public/uploads` | uploaded images/files       |
| `milaclone_ts_state` | `/var/lib/tailscale`  | the sidecar's node identity |

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

| Piece                  | Where                           | Does what                                    |
| ---------------------- | ------------------------------- | -------------------------------------------- |
| `TS_AUTHKEY`           | `.env` (gitignored)             | Authenticates the node on first start        |
| `TS_HOSTNAME=mila`     | `docker-compose.yml`            | Names the node → `mila.your-tailnet.ts.net`  |
| `tailscale/serve.json` | mounted at `/config/serve.json` | Terminates HTTPS, proxies `/` → `app:4321`   |
| `milaclone_ts_state`   | volume at `/var/lib/tailscale`  | Remembers the node so restarts don't re-auth |

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
git switch -c my-branch origin/my-branch   # first time for that branch
# git switch my-branch && git pull --ff-only   # every time after
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

Create `/etc/systemd/system/milaclone.service` (adjust the paths and user):

```ini
[Unit]
Description=Canvas Board
After=network.target

[Service]
Type=simple
User=YOUR_USERNAME
WorkingDirectory=/home/YOUR_USERNAME/milaclone
ExecStart=/usr/bin/node server.js
Environment=PORT=4321
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now milaclone
sudo systemctl status milaclone
```
