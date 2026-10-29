---
name: setup
description: Walk a first-time user through getting Milaclone running — locally with npm, or with Docker and the Tailscale sidecar — then onto their phone. Use when someone has just cloned the repo, asks how to install, run or set up Milaclone, or invokes /setup.
---

# Set up Milaclone

Get a first-time user from a fresh clone to a working board, one step at a
time. Do each step yourself where you can (run the command, read the output),
explain it in a sentence, and only move on once it works. Don't dump every
step up front.

## 1. Ask how they want to run it

Ask one question (use AskUserQuestion when available):

- **On this computer** (recommended for trying it) — `npm start`, needs Node.js 18+.
- **With Docker on a server** — `docker compose`, reachable over HTTPS on their
  Tailscale tailnet. Needs Docker and a Tailscale account.

Also ask whether they want to use it from their phone; that decides step 4.

## 2a. On this computer

1. Check Node: `node --version`. If it's missing or older than 18, stop and
   point them to <https://nodejs.org> (the LTS installer); re-check after.
2. `npm install`. `better-sqlite3` compiles a native module — if it fails, the
   usual cause is missing build tools: Xcode Command Line Tools on macOS
   (`xcode-select --install`), `build-essential` and `python3` on Debian/Ubuntu.
3. Start it in the background with `npm start` and wait for it to answer:
   `curl -s localhost:4321/api/health` should print `{"ok":true}`. If port
   4321 is taken, use `PORT=8080 npm start` and use that port from here on.
4. Tell them to open <http://localhost:4321>. They should see the **Home**
   board.

## 2b. With Docker

1. Check `docker --version` and `docker compose version`.
2. The Tailscale sidecar needs an auth key. Ask them to create one at
   <https://login.tailscale.com/admin/settings/keys> (reusable is easiest) and
   paste it, then write it to `.env` (gitignored): `TS_AUTHKEY=tskey-auth-…`.
   Never echo the key back or commit it.
3. `docker compose up -d --build`. The first build compiles `better-sqlite3`
   and takes a few minutes.
4. Verify: `docker compose ps` shows `app` and `tailscale` running, and
   `curl -s localhost:8182/api/health` prints `{"ok":true}`.
5. The board is at `https://mila.<their-tailnet>.ts.net` from any device on
   the tailnet (`docker compose exec tailscale tailscale status` shows the
   name). The app port is bound to `127.0.0.1` only, on purpose.

If anything fails here, follow the troubleshooting in
[docs/self-hosting.md](../../../docs/self-hosting.md#access-over-tailscale) —
most often a missing `.env` (`set TS_AUTHKEY in .env`) or `tailscale/serve.json`
having become a directory.

## 3. A quick tour

Point them at the essentials, briefly:

- Pick a card type in the toolbar, then click the canvas to place it; drag to
  move it.
- A **Board** card opens a nested board.
- ⌘K / Ctrl+K searches every board; `/` lists all keyboard shortcuts.
- Deleting goes to **Trash** and can be undone (⌘Z / Ctrl+Z).
- Everything saves automatically; there's no save button.

## 4. On their phone (optional)

Follow the README's [Put it on your phone](../../../README.md#put-it-on-your-phone)
section for their setup:

- **Local `npm start`, same Wi-Fi:** find the computer's LAN IP
  (`ipconfig getifaddr en0` on macOS, `hostname -I` on Linux), and have them
  open `http://<ip>:4321` on the phone. Mention the firewall prompt on macOS.
- **Docker / Tailscale:** install Tailscale on the phone, sign in to the same
  tailnet, open the `ts.net` URL.

Then Add to Home Screen (Safari: Share; Chrome: ⋮), and point out **Quick
notes** in the bottom bar.

## 5. Wrap up

Before finishing, tell them plainly:

- **There is no login.** Anyone who can reach the address can read and edit
  every board, so only expose it on networks they trust.
- **Where their data lives:** `data/board.db` and `public/uploads/` (or the
  `milaclone_data` / `milaclone_uploads` volumes with Docker). Back up with
  **Export → Download database backup**.
- To keep it running after a reboot, see
  [docs/self-hosting.md](../../../docs/self-hosting.md#run-it-as-a-service-auto-start-on-boot)
  (systemd), or rely on Docker's `restart: unless-stopped`.

Don't change any code or config beyond `.env` during setup.
