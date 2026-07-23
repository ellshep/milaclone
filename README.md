# Canvas Board — a self-hosted Milanote-style board

An infinite visual canvas for notes, to-do lists, links, images, columns, and
nested boards. Runs as a small Node.js app with **zero native dependencies** and
**no build step** — clone, `npm install`, `node server.js`. Your data lives in a
plain JSON file on disk, so it's trivial to back up and fully yours.

## Features

- Infinite pan/zoom canvas with a dotted grid
- Cards: **Note** (serif title + body), **To-do** (checkable tasks), **Link**,
  **Image** (drag-upload), **Column** (stack cards vertically), **Board**
  (nested sub-canvas you can open into)
- Nested boards with clickable breadcrumb navigation (Home / … / …)
- Drag cards freely, drag them in and out of columns, resize, recolor
- 12-color palette for boards and columns
- Everything autosaves to `data/board.json`
- Per-board camera position remembered in your browser

## Requirements

- Node.js 18 or newer (`node --version` to check)
- That's it. No database, no compiler, no Python.

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

The server already binds to `0.0.0.0`, so once your Ubuntu box is on your
tailnet it's reachable from any of your devices.

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

- Board content: `data/board.json`
- Uploaded images: `public/uploads/`

Back up those two paths and you've backed up everything. To reset to a blank
canvas, stop the server and delete `data/board.json` (it'll be recreated on next
start). A corrupt JSON file is automatically backed up to
`data/board.corrupt-<timestamp>.json` rather than being overwritten.

## Configuration

All optional, via environment variables:

| Variable     | Default              | Purpose                          |
|--------------|----------------------|----------------------------------|
| `PORT`       | `4321`               | Port to listen on                |
| `HOST`       | `0.0.0.0`            | Bind address                     |
| `DATA_DIR`   | `./data`             | Where `board.json` is written    |
| `UPLOAD_DIR` | `./public/uploads`   | Where uploaded images go         |

## Not included (yet)

These were left out to keep the first version solid and dependency-free; they're
natural next additions: line/arrow connectors between cards, comments, freehand
drawing/sketch cards, multi-select, and real-time multi-user sync (the current
model is single-document, last-write-wins — great for one person across their
own devices).

## Keyboard shortcuts

- `N` note · `L` link · `T` to-do · `B` board · `C` column
- `Esc` deselect / cancel the armed tool
- `Delete` / `Backspace` remove the selected card (when not typing)
