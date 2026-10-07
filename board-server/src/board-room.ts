import { DurableObject } from 'cloudflare:workers';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as Y from 'yjs';

import {
  AWARENESS_LIFETIME_MS,
  COMPACT_AFTER_UPDATES,
  ClientDocMessageType,
  MAX_CHUNK_BYTES,
  MAX_MERGED_BYTES,
  MAX_MESSAGE_BYTES,
  MessageType,
  NEW_BOARD_SETTLE_MS,
  ServerDocMessageType,
} from './protocol';

interface UpdateRow extends Record<string, SqlStorageValue> {
  idx: number;
  gid: number;
  data: ArrayBuffer;
}

/**
 * One board.
 *
 * Holds everybody who has that board open, passes each person's changes to
 * everybody else, and remembers the board so it is still there tomorrow.
 *
 * Changes are stored as a list of Yjs updates, exactly as the browser sent
 * them. Yjs can merge a list of updates in any order into the same result, so
 * the list never needs sorting and two people editing at once cannot corrupt
 * it. Once the list gets long it is squashed into one update.
 *
 * Every change is written to storage inside the same handler that received it,
 * before anybody else is told about it. Nothing is held in memory waiting to be
 * saved, because memory is thrown away when a sleeping board is woken up
 * somewhere else, and a change that other people can see must never be a
 * change that can vanish.
 */
export class BoardRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    ctx.blockConcurrencyWhile(async () => {
      // One logical change can be too big for a single row, so it is split
      // across rows that share a `gid` and are put back together in `idx`
      // order.
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS updates (
          idx INTEGER PRIMARY KEY AUTOINCREMENT,
          gid INTEGER NOT NULL,
          data BLOB NOT NULL
        )
      `);

      // Remembers the moment the first person ever opened this board, so a
      // second person arriving at the same instant can be made to wait rather
      // than start a rival empty board.
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS meta (
          name TEXT PRIMARY KEY,
          value INTEGER NOT NULL
        )
      `);

      // One row per person, not one per cursor movement. Keyed on the blob
      // instead, every twitch of a mouse would be a new row that nothing ever
      // replaces, and a new joiner would be sent hundreds of stale cursors.
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS awareness (
          client_id INTEGER PRIMARY KEY,
          data BLOB NOT NULL,
          expires_at INTEGER NOT NULL
        )
      `);

      // A board made by the earlier version has the old shape. Spotting the
      // missing column is the only way to tell, and rebuilding it costs
      // nothing.
      const hasClientId = this.ctx.storage.sql
        .exec<{ name: string }>('PRAGMA table_info(awareness)')
        .toArray()
        .some((column) => column.name === 'client_id');

      if (!hasClientId) {
        this.ctx.storage.sql.exec('DROP TABLE awareness');

        this.ctx.storage.sql.exec(`
          CREATE TABLE awareness (
            client_id INTEGER PRIMARY KEY,
            data BLOB NOT NULL,
            expires_at INTEGER NOT NULL
          )
        `);
      }
    });
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a web socket.', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Two people opening the same brand-new board at the same moment would
    // both be told it is empty, and both would then build their own empty
    // board. Yjs keeps only one of those, so one person's first few notes
    // would quietly disappear.
    //
    // So the first person ever to open a board claims it, and that claim is
    // written down before anything is waited on. A board handles one thing at
    // a time, so a second person arriving in the same instant always sees the
    // claim, and waits for the first person's starting point instead.
    const claimedAt = this._claim();

    if (claimedAt !== null) {
      // Never further ahead than the wait is long, even if the written-down
      // moment somehow sits in the future. Otherwise the wait never ends and
      // the connection never opens.
      const deadline =
        Math.min(claimedAt, Date.now()) + NEW_BOARD_SETTLE_MS;

      while (this._updateCount() === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    // Only joined up once the waiting is over. A socket that is joined up
    // early would be sent other people's changes before it has been told what
    // is on the board, and the browser expects that message first.
    this.ctx.acceptWebSocket(server);

    // The browser does not start listening for changes until it has been told
    // the board's contents, so send them straight away.
    for (const message of this._buildContentsMessages()) {
      this._send(server, message);
    }

    this._send(server, this._buildAwarenessSyncMessage());

    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(
    ws: WebSocket,
    message: ArrayBuffer | string,
  ): Promise<void> {
    if (typeof message === 'string') {
      return;
    }

    const bytes = new Uint8Array(message);

    let messageType: number;
    const decoder = decoding.createDecoder(bytes);

    try {
      messageType = decoding.readVarUint(decoder);
    } catch {
      return;
    }

    try {
      switch (messageType) {
        case MessageType.DOC:
          this._handleDocMessage(ws, decoder);
          break;
        case MessageType.AWARENESS:
          this._handleAwarenessMessage(ws, decoder, bytes);
          break;
        default:
          break;
      }
    } catch (error) {
      // A message we cannot read must never take the board down for everybody
      // else, but it must still be visible when something is wrong.
      console.error('Bad message', {
        messageType,
        error: String(error),
      });
    }
  }

  override async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
  ): Promise<void> {
    this.ctx.storage.sql.exec(
      'DELETE FROM awareness WHERE expires_at <= ?',
      Date.now(),
    );

    // 1006 may never be sent back; it only ever means "the connection
    // dropped". Anything outside 1000-4999 would throw.
    ws.close(code >= 1000 && code < 5000 && code !== 1006 ? code : 1000, reason);
  }

  override async webSocketError(): Promise<void> {
    // Nothing to clean up: the connection is already gone, and presence
    // messages time out on their own.
  }

  // Board contents

  private _handleDocMessage(ws: WebSocket, decoder: decoding.Decoder): void {
    switch (decoding.readVarUint(decoder)) {
      case ClientDocMessageType.SINGLE_UPDATE:
        this._handleSingleUpdate(ws, decoder);
        break;
      case ClientDocMessageType.ALL_UPDATES_UNMERGED_RESPONSE:
        // Only the old server ever asked for this, to re-key a board or take a
        // snapshot. This one squashes the board itself, so there is nothing to
        // do.
        break;
      default:
        break;
    }
  }

  private _handleSingleUpdate(ws: WebSocket, decoder: decoding.Decoder): void {
    const updateId = decoding.readVarUint(decoder);
    const update = decoding.readVarUint8Array(decoder);

    if (update.length === 0) {
      this._sendAck(ws, updateId);
      return;
    }

    this._storeUpdate(update);

    this._broadcastExcept(this._buildSingleUpdateMessage(update), ws);

    this._sendAck(ws, updateId);

    this._compactIfNeeded();
  }

  /**
   * Claim an empty board for this connection.
   *
   * Returns null when this connection is the one that should build the empty
   * board, and the moment of the original claim when it should instead wait for
   * somebody else's starting point.
   */
  private _claim(): number | null {
    if (this._updateCount() > 0) {
      return null;
    }

    const existing = this.ctx.storage.sql
      .exec<{ value: number }>(
        "SELECT value FROM meta WHERE name = 'claimed_at'",
      )
      .toArray();

    if (existing.length === 0) {
      this.ctx.storage.sql.exec(
        "INSERT INTO meta (name, value) VALUES ('claimed_at', ?)",
        Date.now(),
      );

      return null;
    }

    const claimedAt = existing[0].value;

    // Long enough ago that the first person clearly never saved anything —
    // they closed the tab, or never typed. Let this one build the board.
    if (Date.now() - claimedAt > NEW_BOARD_SETTLE_MS) {
      this.ctx.storage.sql.exec(
        "UPDATE meta SET value = ? WHERE name = 'claimed_at'",
        Date.now(),
      );

      return null;
    }

    return claimedAt;
  }

  /** Write one change to storage, split across rows if it is too big. */
  private _storeUpdate(update: Uint8Array): void {
    const gid = this._nextGid();

    for (let start = 0; start < update.length; start += MAX_CHUNK_BYTES) {
      this.ctx.storage.sql.exec(
        'INSERT INTO updates (gid, data) VALUES (?, ?)',
        gid,
        update.subarray(start, start + MAX_CHUNK_BYTES),
      );
    }
  }

  private _nextGid(): number {
    return (
      (this.ctx.storage.sql
        .exec<{ gid: number | null }>('SELECT MAX(gid) AS gid FROM updates')
        .one().gid ?? 0) + 1
    );
  }

  private _updateCount(): number {
    return (
      this.ctx.storage.sql
        .exec<{ count: number }>(
          'SELECT COUNT(DISTINCT gid) AS count FROM updates',
        )
        .one().count ?? 0
    );
  }

  /** Read the stored changes back, each one joined up from its rows. */
  private _readUpdates(): { highestIdx: number; updates: Uint8Array[] } {
    const rows = this.ctx.storage.sql
      .exec<UpdateRow>('SELECT idx, gid, data FROM updates ORDER BY idx')
      .toArray();

    const byGid = new Map<number, Uint8Array[]>();

    for (const row of rows) {
      const parts = byGid.get(row.gid);
      const bytes = new Uint8Array(row.data);

      if (parts == null) {
        byGid.set(row.gid, [bytes]);
      } else {
        parts.push(bytes);
      }
    }

    const updates: Uint8Array[] = [];

    for (const parts of byGid.values()) {
      updates.push(parts.length === 1 ? parts[0] : concat(parts));
    }

    return { highestIdx: rows.at(-1)?.idx ?? 0, updates };
  }

  /**
   * The messages that tell a browser what is on the board.
   *
   * The first is always the "here is everything" message, even when the board
   * is empty, because the browser waits for it before it will accept anything
   * else. Anything that does not fit in it follows as ordinary single changes,
   * which the browser applies the same way. This keeps each message well under
   * any size limit, however big the board gets.
   */
  private _buildContentsMessages(): Uint8Array[] {
    const { highestIdx, updates } = this._readUpdates();

    const firstBatch: Uint8Array[] = [];
    const leftOver: Uint8Array[] = [];

    let budget = MAX_MESSAGE_BYTES;

    for (const update of updates) {
      // Never forced in. A change too big for the budget goes on its own,
      // because the browser will not touch the board at all until this first
      // message arrives, and an oversized one may never arrive.
      if (update.length <= budget) {
        firstBatch.push(update);
        budget -= update.length;
      } else {
        leftOver.push(update);
      }
    }

    const encoder = encoding.createEncoder();

    encoding.writeVarUint(encoder, MessageType.DOC);
    encoding.writeVarUint(encoder, ServerDocMessageType.ALL_UPDATES_UNMERGED);

    encoding.writeVarUint(encoder, highestIdx);

    encoding.writeVarUint(encoder, firstBatch.length);

    for (const update of firstBatch) {
      encoding.writeVarUint8Array(encoder, update);
    }

    // No re-keying and no snapshots in this version. Both flags stay off, and
    // because they are off the browser does not read a request id after them.
    encoding.writeUint8(encoder, 0);
    encoding.writeUint8(encoder, 0);

    return [
      encoding.toUint8Array(encoder),
      ...leftOver.map((update) => this._buildSingleUpdateMessage(update)),
    ];
  }

  private _buildSingleUpdateMessage(update: Uint8Array): Uint8Array {
    const encoder = encoding.createEncoder();

    encoding.writeVarUint(encoder, MessageType.DOC);
    encoding.writeVarUint(encoder, ServerDocMessageType.SINGLE_UPDATE);
    encoding.writeVarUint8Array(encoder, update);

    return encoding.toUint8Array(encoder);
  }

  private _sendAck(ws: WebSocket, updateId: number): void {
    const encoder = encoding.createEncoder();

    encoding.writeVarUint(encoder, MessageType.DOC);
    encoding.writeVarUint(encoder, ServerDocMessageType.SINGLE_UPDATE_ACK);
    encoding.writeVarUint(encoder, updateId);

    this._send(ws, encoding.toUint8Array(encoder));
  }

  /**
   * Squash a long list of changes into one. Yjs does the merging, so the result
   * is the same board in far fewer bytes.
   *
   * It all happens in one go with no waiting in the middle, so no new change
   * can slip in while the list is half replaced.
   */
  private _compactIfNeeded(): void {
    const count = this._updateCount();

    if (count <= COMPACT_AFTER_UPDATES) {
      return;
    }

    // Squashing can fail, and when it does it will keep failing. Without this,
    // every later keystroke would read the whole board back out and try again.
    const gaveUpAt = this.ctx.storage.sql
      .exec<{ value: number }>(
        "SELECT value FROM meta WHERE name = 'squash_gave_up_at'",
      )
      .toArray()[0]?.value;

    if (gaveUpAt != null && count < gaveUpAt * 2) {
      return;
    }

    const { highestIdx, updates } = this._readUpdates();

    let merged: Uint8Array;

    try {
      merged = Y.mergeUpdatesV2(updates);
    } catch (error) {
      // A change we cannot merge would otherwise break every save from now on.
      // Leaving the list alone is harmless: it still works, it is just bigger.
      console.error('Could not squash board', String(error));

      this._rememberSquashFailed(count);

      return;
    }

    // A single change this big could not be sent to a browser in one piece, and
    // unlike a list it cannot be broken up. Keep the list instead.
    if (merged.length > MAX_MERGED_BYTES) {
      this._rememberSquashFailed(count);

      return;
    }

    this.ctx.storage.sql.exec('DELETE FROM updates WHERE idx <= ?', highestIdx);
    this._storeUpdate(merged);

    this.ctx.storage.sql.exec(
      "DELETE FROM meta WHERE name = 'squash_gave_up_at'",
    );
  }

  private _rememberSquashFailed(count: number): void {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO meta (name, value) VALUES ('squash_gave_up_at', ?)",
      count,
    );
  }

  // Presence: where other people's cursors are

  private _handleAwarenessMessage(
    ws: WebSocket,
    decoder: decoding.Decoder,
    whole: Uint8Array,
  ): void {
    const now = Date.now();
    const numUpdates = decoding.readVarUint(decoder);

    for (let i = 0; i < numUpdates; i++) {
      const update = decoding.readVarUint8Array(decoder);

      // Presence is small by nature. Anything oversized is not presence.
      if (update.length === 0 || update.length > 16_384) {
        continue;
      }

      const clientId = readAwarenessClientId(update);

      if (clientId === null) {
        continue;
      }

      this.ctx.storage.sql.exec(
        'INSERT OR REPLACE INTO awareness (client_id, data, expires_at) VALUES (?, ?, ?)',
        clientId,
        update,
        now + AWARENESS_LIFETIME_MS,
      );
    }

    this.ctx.storage.sql.exec(
      'DELETE FROM awareness WHERE expires_at <= ?',
      now,
    );

    // Pass the message straight on, exactly as it arrived.
    this._broadcastExcept(whole, ws);
  }

  private _buildAwarenessSyncMessage(): Uint8Array {
    const rows = this.ctx.storage.sql
      .exec<{ data: ArrayBuffer }>(
        'SELECT data FROM awareness WHERE expires_at > ? ORDER BY expires_at DESC LIMIT 200',
        Date.now(),
      )
      .toArray();

    const encoder = encoding.createEncoder();

    encoding.writeVarUint(encoder, MessageType.AWARENESS);
    encoding.writeVarUint(encoder, rows.length);

    for (const row of rows) {
      encoding.writeVarUint8Array(encoder, new Uint8Array(row.data));
    }

    return encoding.toUint8Array(encoder);
  }

  // Sending

  private _send(ws: WebSocket, message: Uint8Array): void {
    try {
      ws.send(message);
    } catch (error) {
      // Usually the other end went away mid-send, which needs no action: its
      // close handler runs and presence times out on its own. Logged anyway,
      // because the other cause is a message too big to send, and that one
      // leaves somebody staring at a board that never finishes loading.
      console.error('Could not send', {
        bytes: message.length,
        error: String(error),
      });
    }
  }

  private _broadcastExcept(message: Uint8Array, except: WebSocket): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== except) {
        this._send(ws, message);
      }
    }
  }
}

/**
 * Which person a presence message is about.
 *
 * The format is: how many people, then for each one their number, a counter,
 * and their state. Only the first number is needed, and these messages always
 * carry exactly one person.
 */
function readAwarenessClientId(update: Uint8Array): number | null {
  try {
    const decoder = decoding.createDecoder(update);

    if (decoding.readVarUint(decoder) !== 1) {
      return null;
    }

    return decoding.readVarUint(decoder);
  } catch {
    return null;
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  let length = 0;

  for (const part of parts) {
    length += part.length;
  }

  const joined = new Uint8Array(length);
  let offset = 0;

  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }

  return joined;
}
