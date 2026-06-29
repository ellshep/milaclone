# Milaclone (or your new name)

A lightweight, self-hosted visual canvas app for organizing notes, 
images, links, and to-dos on an infinite board.

> Inspired by Milanote. Not affiliated with or endorsed by Milanote Pty Ltd.

## Features
- Infinite pan/zoom canvas
- Note, image, link, to-do, and board card types
- Nested board navigation
- Drag-and-drop with persistent positions
- Image uploads
- Docker-ready

## Tech Stack
- **Backend:** Node.js + Express
- **Frontend:** Vanilla JS (no build step)
- **Storage:** JSON file-backed (no database required)
- **Access:** Tailscale Serve for HTTPS

## Getting Started

### Docker
\`\`\`bash
git clone https://github.com/you/milaclone
cd milaclone
docker compose up -d
\`\`\`

Access at http://localhost:4321 or via Tailscale.

## Configuration
| Variable | Default | Description |
|---|---|---|
| PORT | 4321 | Server port |
| DATA_DIR | ./data | JSON storage path |
| UPLOADS_DIR | ./uploads | Image uploads path |

## Self-Hosting Notes
- Bind to 127.0.0.1 for LAN/Tailscale-only access
- Use `tailscale serve` for HTTPS without a public domain
- Data persists in ./data and ./uploads via Docker bind mounts

## License
MIT

## Disclaimer
This project is not affiliated with, endorsed by, or connected to Milanote Pty Ltd.
