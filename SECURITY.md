# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue.

Use GitHub's private reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Include what you found, how to reproduce it, and what an attacker could do with it.

This is a small project maintained in spare time. Expect a first reply within a week. Once a fix is merged to `main`, the advisory is published with credit to you, unless you'd rather stay anonymous.

## Supported versions

Only the latest `main` is supported. There are no release branches.

## Security model

Knowing what milaclone does and doesn't protect against saves everyone time:

- **The board has no login.** It is built to run on a private network you trust, such as a Tailscale tailnet, and the Docker setup binds it to loopback only. Exposing the board to the public internet is unsupported. "Anyone who can reach the board can edit it" is expected behaviour, not a vulnerability.
- **The task API** (`/api/tasks`) is the one authenticated surface. It requires `Authorization: Bearer $TASK_API_TOKEN` and is switched off (503) when no token is set.
- **Uploads** are served with `nosniff` and, for anything that isn't an inert inline type, `Content-Disposition: attachment`, so uploaded HTML or SVG can't run on the app's origin. A way around that is in scope.
- **The server never fetches URLs** from cards. Video and music embeds are built from the URL in the browser.
- **Optional add-ons** (`addons/`) are off by default. Each add-on's README says what it sends to third parties.

In scope: anything that lets someone on the network do more than the model above allows, such as running code on the server, reading files outside the data and upload folders, bypassing the task API token, script running from an upload, or data loss caused by a crafted request.

Out of scope: problems that need the board exposed to the public internet, attacks that need an already-compromised device on your tailnet, and missing hardening headers with no concrete exploit.
