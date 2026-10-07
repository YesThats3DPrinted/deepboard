// The wire format spoken between the browser and a board room.
//
// It is the same format the original DeepNotes collab-server used, with one
// difference: nothing is encrypted. Board contents are stored and relayed as
// plain Yjs updates. Keep these numbers and the field order exactly as they
// are — the browser side reads them in this order and a mismatch shows up as a
// silently empty board, not an error.

export const enum MessageType {
  DOC = 0,
  AWARENESS = 1,
}

export const enum ServerDocMessageType {
  ALL_UPDATES_UNMERGED = 0,
  SINGLE_UPDATE = 1,
  SINGLE_UPDATE_ACK = 2,
}

export const enum ClientDocMessageType {
  ALL_UPDATES_UNMERGED_RESPONSE = 0,
  SINGLE_UPDATE = 1,
}

// How long a presence message (someone else's cursor) stays alive, in
// milliseconds. The browser re-sends its own every few seconds, so anything
// older than this belongs to somebody who has gone. Matches the lifetime the
// original server used.
export const AWARENESS_LIFETIME_MS = 30_000;

// Squash the stored updates into one once there are more than this many. Keeps
// the stored board small and makes opening it fast. Chosen to match the
// original server, which squashed every 100 updates.
export const COMPACT_AFTER_UPDATES = 100;

// The biggest a single stored row may be. Cloudflare's limit is 2 MB for a
// row, so one change bigger than this is split across several rows and joined
// back up when it is read.
export const MAX_CHUNK_BYTES = 1_000_000;

// How much of a change list to put in one message. Cloudflare accepts incoming
// messages up to 32 MiB but publishes no figure for outgoing ones, so keep
// each message small and send the rest as separate messages.
export const MAX_MESSAGE_BYTES = 900_000;

// Do not squash a board into one change bigger than this. A list can be sent
// in several messages; one enormous change cannot be split, because a Yjs
// change is only usable whole.
export const MAX_MERGED_BYTES = 8_000_000;

// How long to wait, in milliseconds, before telling somebody a board is empty
// when another person reached that same brand-new board first. Long enough for
// their starting point to arrive, short enough not to feel like a hang.
export const NEW_BOARD_SETTLE_MS = 3_000;
