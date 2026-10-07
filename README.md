# DeepBoard

A shared whiteboard for a small team. Open a link, type the one shared password
once, and you are on a canvas. No sign-up, no accounts, nothing to log into
again.

**Start here: [docs/WHITEBOARD.md](./docs/WHITEBOARD.md)** — what it does, how to
run it, how to put it on the web, how to change the password.

Run it locally with `./dev-spa.sh`.

## What it is a copy of

This is a cut-down copy of [DeepNotes](https://github.com/DeepNotesApp/DeepNotes)
by Gustavo Toyota, which is an end-to-end encrypted infinite canvas with deep
page nesting and realtime collaboration.

The canvas, the notes, the arrows and the pages-inside-pages are all theirs.
What has been taken out: accounts, sign-in, groups, invitations, notifications,
billing, the four server programs, Postgres, and the encryption. What has been
put in: one Cloudflare Worker that holds the boards, and one shared password.

The original project's own documents are still here, and describe the full
version rather than this one:
[NON_TECHNICAL_OVERVIEW.md](./docs/NON_TECHNICAL_OVERVIEW.md),
[TECHNICAL_OVERVIEW.md](./docs/TECHNICAL_OVERVIEW.md),
[RESTART_PLAN.md](./docs/RESTART_PLAN.md).

## Licence

AGPL-3.0, the same as the original. See [LICENSE](./LICENSE). That licence says
anybody who uses this over a network must be able to get the source, which is
why this repository is public.
