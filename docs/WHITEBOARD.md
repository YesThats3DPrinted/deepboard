# DeepBoard — how it works and how to run it

A shared whiteboard for a small team. You open a link and you are on a canvas.
There is no sign-up and no account. The first time a browser opens a board it
asks for one shared password, then never asks again.

It is a cut-down copy of [DeepNotes](https://github.com/DeepNotesApp/DeepNotes).
Everything that existed to serve many strangers has been taken out: accounts,
groups, invitations, billing, and the scrambling that kept notes secret from the
people running the server.

## What you can do

- An endless canvas you can pan and zoom around.
- Notes you can type in, drag, resize, colour and collapse, with proper text
  formatting, lists and tables inside them.
- Arrows between notes that follow them when they move.
- Selecting several things at once, lining them up, copy and paste, undo and
  redo.
- Pages inside pages. Any note can open into a whole new board, as deep as you
  like.
- Several people on the same board at once, seeing each other's changes and
  each other's cursors.

## Where it runs

| Piece | Where |
|---|---|
| The web page | Cloudflare Pages |
| Boards, and passing changes between people | One Cloudflare Worker, `deepboard-server` |
| Where boards are saved | Inside that Worker, one small store per board |

There is no database to run and nothing to keep awake. A board sleeps when
nobody is looking at it and wakes when somebody opens the link. Cloudflare's
free allowance covers a small team many times over.

## Addresses

A board is `/#/pages/<board id>`. Share that link and the other person lands on
the same board. The board everybody starts on is `board0000000000000001`.

Any other address sends you to that starting board, so there is no way to land
on a screen that is not a canvas.

To start a separate board, put a made-up name in the address, for example
`/#/pages/roadmap-2027`. Nothing has to be created first: a board that nobody
has opened before simply opens empty. Names can use letters, numbers, dashes
and underscores.

To make a board that lives *inside* a note, select the note and press **Create
new page** in the panel on the right. The note then opens into it, and the way
back is the trail along the top.

## Who can get in

Two things keep other people out, and nothing else:

1. **The shared password**, which the board server checks.
2. **The link being private**, since anybody with the password can open any
   board whose id they know.

Inside the app, the locking you can see in the code is switched off: every lock
uses the same key, which is written into the app in plain sight. **Treat a board
as readable by anyone who has the password. Do not put anything on it you would
not put in a shared folder.**

## Running it on this machine

Node 18 is not optional. The build tools are from 2022 and newer Node breaks
them with `ERR_INVALID_THIS`.

```bash
./dev-spa.sh
```

That opens the app at http://localhost:60379. The first run takes a few minutes
while it works through the libraries.

If the packages have never been installed:

```bash
export PATH="$HOME/.local/node18/bin:$PATH"
pnpm install
pnpm run repo:build
```

`pnpm run repo:build` fails on the old server code at the end. That is expected
and harmless: the shared parts the app needs are built before it gets there.

## Building the web version

```bash
export PATH="$HOME/.local/node18/bin:$PATH"
cd apps/client
pnpm run build:spa
```

The finished site lands in `apps/client/dist/spa`. Put it up with:

```bash
cd apps/client
npx wrangler pages deploy dist/spa --project-name deepboard
```

Settings come from `.env` when running locally and `.env.prod` when building the
web version. Neither is committed; copy `env.example` and fill it in. The only
one that matters is `COLLAB_SERVER_URL`, which is where boards live.

## The board server

Lives in `board-server/`. It needs **Node 20 or newer**, which is the opposite of
the app, so run its commands with the normal `node`, not the Node 18 one.

```bash
cd board-server
npx wrangler deploy
```

### Changing the shared password

```bash
cd board-server
npx wrangler secret put BOARD_PASSWORD
```

Everybody has to type the new one once. Old passes keep working for up to half a
day, so somebody already using a board is not thrown out straight away.

### Allowing a new web address

`ALLOWED_ORIGINS` in `board-server/wrangler.jsonc` lists the addresses the app
is allowed to be served from. Anything else is refused, so another website
cannot borrow the board server. It must list the local address for development
**and** the live web address. Comma separated, no spaces. Run `npx wrangler
deploy` after changing it.

### Checking it still works

```bash
cd board-server
PW=$(grep BOARD_PASSWORD .dev.vars | cut -d'"' -f2)
BOARD_URL=https://deepboard-server.yt3dp.workers.dev \
BOARD_ORIGIN=http://localhost:60379 \
BOARD_PASSWORD="$PW" \
node test/board-room.test.mjs
```

It prints a line per check and ends with either `All checks passed.` or a count
of failures. The last check deliberately guesses the password until it gets
blocked, so running it twice inside a minute fails the password checks for the
wrong reason. Wait a minute between runs.

**The board server cannot be run on this machine.** Cloudflare's local runtime
needs macOS 13.5 or newer. `wrangler deploy` is unaffected, which is why the
test talks to the real server instead.

## Things to know

- **Pictures have to be under 1MB.** A picture lives inside the board, and the
  whole board is sent in one go each time somebody opens it. Bigger pictures
  eventually stop a board loading at all.
- **Which pages you looked at recently, and which you starred, are kept in your
  own browser.** They are not shared, and clearing your browser data loses them.
- **Board names are shared.** They live in a list of their own on the board
  server, so everybody sees the same names.
- **There is no history.** The old app could keep snapshots of a page; this one
  keeps only what is on the board now.
