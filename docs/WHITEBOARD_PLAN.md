# DeepBoard — build plan

## What we are making

A shared whiteboard, for one small team, hosted on Cloudflare.

You open a link and you are on the board. There is no sign-up, no account, no email, no
log-in screen. The first time you open it, it asks for one shared password, remembers it, and never
asks again on that browser. Everybody on the team types the same password.

Several people can be on the same board at once and see each other's changes as they happen.

It is a cut-down copy of DeepNotes. We keep the drawing surface and throw away everything that
exists to serve many strangers: accounts, groups, invitations, billing, notifications, and the
scrambling that keeps notes secret from the people running the server.

## What we keep

- The endless canvas: pan, zoom, grid.
- Notes: typing, dragging, resizing, colours, collapsing, lists inside notes, tables, images.
- Arrows between notes.
- Selecting several things, aligning them, copy and paste, undo and redo.
- Pages inside pages. A note can open into a whole new board, as deep as you like.
- Live editing with other people, and seeing where their cursor is.

## What we throw away

- The four server programs (`apps/app-server`, `apps/collab-server`, `apps/realtime-server`,
  `apps/scheduler`) and the `apps/manager` tool.
- Postgres and KeyDB. Nothing to install, nothing to pay for.
- Accounts, log-in, sign-up, email checks, two-factor, password resets.
- Groups, members, roles, invitations, join requests, notifications.
- Stripe and the paid plan.
- The secret-keeping layer. The board is stored plainly in our own Cloudflare account.

## Where it runs

| Piece | Where | Costs |
|---|---|---|
| The web page | Cloudflare Pages | Free |
| The live-editing server | One Cloudflare Worker with a Durable Object per board | Free tier, far more than we need |
| Where boards are saved | Inside that Durable Object's own small store | Free tier |

A Durable Object is a tiny piece of Cloudflare that holds one board, keeps everybody's
connections to it, and remembers it. It sleeps when nobody is looking and wakes when somebody
opens the link. It is the one thing on Cloudflare that can do live editing, which is why this
works without a real server.

## The trick that makes this small

DeepNotes already uses **Yjs** to merge everybody's edits. Cloudflare Durable Objects speak the
same thing. So the clever part, the bit that decides who wins when two people drag the same note,
is already written and we do not touch it.

All we replace is the **plumbing**: five places where the app reaches out to its old servers. We
do not rip those calls out of the app, because they are spread across hundreds of files. We leave
every call exactly where it is and swap what sits on the other end.

### Swap 1 — the live editing link

File: `apps/client/src/code/pages/page/collab/websocket.ts`

Today it talks a custom, scrambled binary language to `collab-server`. We replace the whole file
with a plain Yjs link to our Worker, with nothing scrambled. It must keep the same handles the rest
of the app calls: `connect`, `disconnect`, `destroy`, `enableLocalAwareness`,
`disableLocalAwareness`, `syncPromise`, `connected`.

The address comes from `COLLAB_SERVER_URL`, which is already how the app is told where to connect,
so nothing else changes. The board being opened becomes the Durable Object's name, so each page,
including pages inside pages, gets its own room.

### Swap 2 — always signed in

File: `apps/client/src/stores.ts` (the `authStore`)

It always reports: signed in, with one fixed made-up user id. Nothing asks for a password, nothing
expires, no cookies are checked. 61 files ask this store questions and all of them keep working.

### Swap 3 — the shared odds and ends

File: `apps/client/src/code/areas/realtime/client.ts`

Today this is a live link to `realtime-server`, a shared notebook of small facts: page names, which
pages are where, favourites, your default note style. 47 files read and write it.

We keep its shape exactly and put the facts in a **second Yjs document**, shared through the same
Worker, in a room called after the top board. So page names and the page tree stay the same for
everybody, with no database.

### Swap 4 — the request layer

File: `apps/client/src/code/trpc.ts`

Today every request goes to `app-server`. We replace it with a small stand-in that answers only the
handful of questions the whiteboard actually asks, and quietly does nothing for the rest.

### Swap 5 — the scrambling, switched off but still there

The app scrambles things with a "keyring" before saving. Hundreds of calls rely on it. Rather than
hunt every one down, we hand it **one fixed key that is built into the app**. Every call keeps
working, the maths still runs, and nothing is actually kept secret from us.

This is deliberate. It is not security. The board is protected by the shared password and by the
link being secret, nothing else. Do not treat this app as private.

### The password

The web page itself is not secret. It is just the app, with no boards in it.

The **boards** are behind the password. On first open the app asks for it, keeps it in that
browser, and sends it every time it connects to the Worker. The Worker compares it against a secret
only Cloudflare knows and hangs up if it is wrong. Wrong password means no board, not a broken app.

The password is checked by `crypto.subtle.timingSafeEqual`-style comparison, never by `===` on raw
strings, so a bad guess tells an attacker nothing about how close it was.

## The Worker

Folder: `board-server`, at the top of the repo.

It must sit outside `apps/`. Everything under `apps/` belongs to the pnpm workspace, and npm then
refuses to install the Worker's own packages with `Unsupported URL Type "workspace:"`.

- One Durable Object class, one instance per board room.
- Accepts a web socket at `/room/:roomId`, with the password sent as the socket's sub-protocol so
  it never lands in a URL or a log.
- Relays Yjs updates between everybody in the room.
- Saves the board in its own store after a pause in typing, and on hibernation.
- Uses the hibernation web socket API, so an idle board costs nothing.
- The password lives in a Wrangler secret called `BOARD_PASSWORD`. It is never in the repo.

## Local versions

The app needs **Node 18** and **pnpm 7.6.0**. Newer Node breaks pnpm 7's downloads with
`ERR_INVALID_THIS`. Before any `pnpm` command in this repo:

```bash
export PATH="$HOME/.local/node18/bin:$PATH"
```

The same line is in `use-node18.sh` at the top of the repo.

The Worker needs the opposite: Wrangler 4 needs **Node 20 or newer**, so run every `wrangler`
command with the normal `node` on the path, not the Node 18 one. The Worker's packages are
installed with `npm`, separately from the rest of the repo.

### The Worker cannot be run on this machine

Cloudflare's local runtime needs **macOS 13.5 or newer**. On macOS 12 `wrangler dev` stops with:

```
Unsupported macOS version: The Cloudflare Workers runtime cannot run on the current version of macOS
```

`wrangler deploy` is unaffected, because it only uploads. So the Worker is tested by **deploying it
and talking to the real one**:

```bash
cd board-server
npx wrangler deploy
PW=$(grep BOARD_PASSWORD .dev.vars | cut -d'"' -f2)
BOARD_URL=https://deepboard-server.yt3dp.workers.dev \
BOARD_ORIGIN=http://localhost:60379 \
BOARD_PASSWORD="$PW" \
node test/board-room.test.mjs
```

`.dev.vars` holds the shared password and the signing secret. It is never committed. The same two
values are set on the live Worker with `npx wrangler secret put BOARD_PASSWORD` and
`npx wrangler secret put PASS_SECRET`.

`ALLOWED_ORIGINS` in `wrangler.jsonc` lists the addresses the app is allowed to be served from.
Every other address is refused, so another website cannot borrow the board server. It must include
the local address while developing **and** the live web address once the app is published.

## Order of work

Working first, tidy second. Nothing gets deleted until the board is drawing on screen, because
deleting early turns one broken thing into fifty.

1. Install everything and build the shared parts: `pnpm install` then `pnpm run repo:build`.
2. Write the Worker and run it locally with `wrangler dev`.
3. Do the five swaps.
4. Point `COLLAB_SERVER_URL` at the local Worker and open the board in a browser.
5. Get it drawing: a note appears, text types, the note drags, it is still there after a reload.
6. Prove live editing with two browser windows on the same board.
7. Only now delete the dead parts: the other apps, the account and group screens, the home and
   pricing pages, and the routes that lead to them.
8. Make the opening link land straight on a board.
9. Build the web page for real and put it on Cloudflare Pages. Put the Worker on Cloudflare.
10. Test the real thing on the real address.

## How we know it works

Each one is checked by actually doing it, in a browser, not by reading the code.

- A note can be made, typed in, dragged, resized, recoloured, and deleted.
- An arrow can be drawn between two notes and follows them when they move.
- Undo and redo work.
- A note opens into a page inside it, and the way back works.
- Reloading the page shows the same board.
- Two windows on one board see each other's changes within a second.
- A wrong password gets a clear "wrong password", and no board.
- A brand new board name opens an empty board instead of an error.
- The Worker survives being closed and reopened: the board is still there.

## Trying to break it

After it works, attack it on purpose:

- Reload while typing. Close a window mid-drag.
- Two windows dragging the same note at the same time.
- Two windows typing in the same note at the same time.
- Open a board, go offline, keep editing, come back online.
- Paste a very large block of text, and a large image.
- Make a page inside a page inside a page, five deep.
- Open the same board in two windows with different passwords.
- A room name with spaces, slashes and non-English letters in it.
- Hammer refresh twenty times to look for connections that never get cleaned up.

Then a second pair of eyes goes looking for what we missed: holes in the password check, anything
still phoning home to the old servers, anything that silently swallows an error, anything that
would lose somebody's work.

## Known risks

- **Old build tools.** The app is built with Vite 2.9 and a private copy of Quasar. It builds, but
  it is slow and the error messages are poor.
- **The shared odds and ends.** Swap 3 is the fiddliest. The old realtime link has a loading state
  and a waiting system that parts of the screen depend on. If it fights back, the fallback is to
  keep page names inside each page's own document and accept that the page tree is rebuilt as you
  walk it.
- **Memory while building.** Building needs a lot of memory for a 2015 laptop. The build scripts
  already ask for 4 GB; if it dies, build on Cloudflare Pages instead of here.
- **Disk.** The installed parts are several gigabytes and this machine has little room spare. Check
  before and after.
