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
// older than this belongs to somebody who has gone.
export const AWARENESS_LIFETIME_MS = 30_000;

// Squash the stored updates into one once there are more than this many. Keeps
// the stored board small and makes opening it fast. Chosen to match the
// original server, which squashed every 100 updates.
export const COMPACT_AFTER_UPDATES = 100;
