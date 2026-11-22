# Contributing

Thanks for looking. milaclone is a small, self-hosted board app kept deliberately small. The fastest way to help is a clear bug report.

## Reporting bugs

Open an issue with the **Bug report** form. Include your version (commit), browser and device, how you run it (npm or Docker), the steps to reproduce, and what you expected. One bug per issue.

Security problems go through private reporting, not issues: see [SECURITY.md](SECURITY.md).

## Ideas and feature requests

Describe the problem you have, not only the feature you want. The app aims to stay small and easy to self-host, so many good ideas will be declined. That's about scope, not the idea.

## Shipping a change

Work in a [treehouse](https://github.com/kunchenguid/treehouse) worktree (`treehouse` from the repo root; `.worktreeinclude` seeds `.env`), never in the deploy checkout. Push through the [no-mistakes](https://github.com/kunchenguid/no-mistakes) gate, `git push no-mistakes <branch>`, or let the agent run `/no-mistakes`. The gate runs the targeted commands in `.no-mistakes.yaml`, has Codex review and fix the change, then pushes and opens the PR. Codex runs `gpt-6.2-sol`; the agent starting a run sets the reviewer effort to match the risk of the change by editing `agent_config.codex.effort` in `~/.no-mistakes/config.yaml` before `axi run` (`low`, `medium` or `high`): `low` for docs and copy, `high` for `db.js`, `routes.js`, `tasklist.js`, `focus.js` and the add-ons.

## Pull requests

- **Start with an issue.** Pull requests must reference an issue the maintainer has accepted. Pull requests that don't are closed without review. (Pull requests may also be limited to collaborators in the repository settings; if so, an accepted issue is where it starts.)
- **Keep it small.** One change per pull request. Prefer the smallest change that works, and say what it removes, or why it removes nothing.
- **Tests and checks.** New behaviour needs a test. `npm run lint`, `npm run format:check`, `npm test`, `npm run test:ui` and `npm run test:e2e` must pass, and nothing may be skipped or marked `.only`. Fill in the pull request template.
- **No drive-by refactors, renames or dependency additions** unless the issue calls for them.

Setup is in the [README](README.md#development). Architecture notes for humans and agents are in [CLAUDE.md](CLAUDE.md).

## AI-assisted contributions

AI coding tools are welcome. AI-generated noise is not. These rules apply to everyone, including the maintainer's own agent sessions:

1. **You are the author.** You must understand every line you submit and be able to explain why it is there. "The AI wrote it" is not an answer to a review question.
2. **Say so.** If an AI tool wrote a meaningful part of the code, tests or description, say which tool and what it did in the pull request. A `Co-Authored-By` trailer is fine.
3. **A person opens it.** Pull requests and issues opened directly by an autonomous agent, with no person who has reviewed and run the change, are closed.
4. **Run it yourself.** Show that you ran the app and the checks. Don't paste a generated test plan you didn't follow.
5. **Write descriptions yourself, briefly.** A few sentences on what changed and why. Long generated summaries, checklists of things that weren't done, and invented benchmarks get the pull request closed.
6. **No generated issues.** Bug reports must describe something you saw. Speculative "potential issues" from an AI scan of the code are not bug reports. Report real security findings privately (see above).
7. **One open pull request at a time** until you've had one merged.
8. **The project's rules bind your agent too.** If your tool reads `CLAUDE.md` or `AGENTS.md`, let it; if not, give it [CLAUDE.md](CLAUDE.md) yourself. Agents must stay in scope, prefer deleting to adding, and never skip tests or lower coverage floors.

The maintainer may close anything that doesn't follow these rules without a detailed review. That isn't personal: reviewing takes far longer than generating.
