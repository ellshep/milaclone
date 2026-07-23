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
node server.js
```

Then open <http://localhost:4321>.

To use a different port:

```bash
PORT=8080 node server.js
```

## Access over Tailscale

The server binds to `0.0.0.0` by default, so once your box is on your tailnet
it's reachable from any of your devices.

1. Make sure Tailscale is up on the server: `sudo tailscale up`
2. Find the machine's tailnet name/IP: `tailscale ip -4` (or use its MagicDNS
   name, e.g. `my-server.tailnet-name.ts.net`).
3. From any device on your tailnet, visit
   `http://my-server.tailnet-name.ts.net:4321`.

### Optional: HTTPS via `tailscale serve`

If you'd like a clean HTTPS URL instead of `:4321`:

```bash
sudo tailscale serve --bg 4321
```

Tailscale will proxy `https://my-server.tailnet-name.ts.net` to the app and
handle the certificate for you. Run `tailscale serve status` to see the mapping
and `sudo tailscale serve --bg off` to stop it.

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
| `UPLOAD_DIR` | `./public/uploads`   | Where uploaded files go          |

## Tech stack

- **Backend:** [Express](https://expressjs.com/) with
  [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) for storage and
  [`multer`](https://github.com/expressjs/multer) for uploads
- **Frontend:** vanilla JavaScript, HTML, and CSS in `public/` — no bundler, no
  framework

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
