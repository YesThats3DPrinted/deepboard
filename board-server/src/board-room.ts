import { DurableObject } from 'cloudflare:workers';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as Y from 'yjs';

import {
  AWARENESS_LIFETIME_MS,
  COMPACT_AFTER_UPDATES,
  ClientDocMessageType,
  MessageType,
  ServerDocMessageType,
} from './protocol';

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
 */
export class BoardRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS updates (
          idx INTEGER PRIMARY KEY AUTOINCREMENT,
          data BLOB NOT NULL
        )
      `);

      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS awareness (
          data BLOB PRIMARY KEY,
          expires_at INTEGER NOT NULL
        )
      `);
    });
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a web socket.', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);

    // The browser will not start listening until it has been told the board's
    // current contents, so send them straight away.
    server.send(this._buildAllUpdatesMessage());
    server.send(this._buildAwarenessSyncMessage());

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
    const decoder = decoding.createDecoder(bytes);

    switch (decoding.readVarUint(decoder)) {
      case MessageType.DOC:
        this._handleDocMessage(ws, decoder);
        break;
      case MessageType.AWARENESS:
        this._handleAwarenessMessage(ws, decoder, bytes);
        break;
      default:
        break;
    }
  }

  override async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
  ): Promise<void> {
    // 1006 is never allowed to be sent back; it only ever means "the
    // connection dropped". Anything outside 1000-4999 would throw.
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

    // Store before telling anyone, so a change that other people can see is
    // always a change that survives a restart.
    this.ctx.storage.sql.exec('INSERT INTO updates (data) VALUES (?)', update);

    this._broadcastExcept(this._buildSingleUpdateMessage(update), ws);

    this._sendAck(ws, updateId);

    this._compactIfNeeded();
  }

  private _buildAllUpdatesMessage(): Uint8Array {
    const rows = this.ctx.storage.sql
      .exec<{ idx: number; data: ArrayBuffer }>(
        'SELECT idx, data FROM updates ORDER BY idx',
      )
      .toArray();

    const encoder = encoding.createEncoder();

    encoding.writeVarUint(encoder, MessageType.DOC);
    encoding.writeVarUint(encoder, ServerDocMessageType.ALL_UPDATES_UNMERGED);

    encoding.writeVarUint(encoder, rows.at(-1)?.idx ?? 0);

    encoding.writeVarUint(encoder, rows.length);

    for (const row of rows) {
      encoding.writeVarUint8Array(encoder, new Uint8Array(row.data));
    }

    // No re-keying and no snapshots in this version. Both flags stay off, and
    // because they are off the browser does not read a request id after them.
    encoding.writeUint8(encoder, 0);
    encoding.writeUint8(encoder, 0);

    return encoding.toUint8Array(encoder);
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
   * Squash a long list of updates into one. Yjs does the merging, so the
   * result is the same board in far fewer bytes.
   *
   * Everything happens in one go with no waiting in the middle, so no new
   * update can slip in while the list is half replaced.
   */
  private _compactIfNeeded(): void {
    const count =
      this.ctx.storage.sql
        .exec<{ count: number }>('SELECT COUNT(*) AS count FROM updates')
        .one().count ?? 0;

    if (count <= COMPACT_AFTER_UPDATES) {
      return;
    }

    const rows = this.ctx.storage.sql
      .exec<{ idx: number; data: ArrayBuffer }>(
        'SELECT idx, data FROM updates ORDER BY idx',
      )
      .toArray();

    const highestIdx = rows.at(-1)?.idx ?? 0;

    let merged: Uint8Array;

    try {
      merged = Y.mergeUpdatesV2(rows.map((row) => new Uint8Array(row.data)));
    } catch {
      // A broken update would otherwise take the whole board down on every
      // save. Leave the list alone; it still works, it is just bigger.
      return;
    }

    this.ctx.storage.sql.exec('DELETE FROM updates WHERE idx <= ?', highestIdx);
    this.ctx.storage.sql.exec('INSERT INTO updates (data) VALUES (?)', merged);
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
      this.ctx.storage.sql.exec(
        'INSERT OR REPLACE INTO awareness (data, expires_at) VALUES (?, ?)',
        decoding.readVarUint8Array(decoder),
        now + AWARENESS_LIFETIME_MS,
      );
    }

    this.ctx.storage.sql.exec('DELETE FROM awareness WHERE expires_at <= ?', now);

    // Pass the message straight on, exactly as it arrived.
    this._broadcastExcept(whole, ws);
  }

  private _buildAwarenessSyncMessage(): Uint8Array {
    const rows = this.ctx.storage.sql
      .exec<{ data: ArrayBuffer }>(
        'SELECT data FROM awareness WHERE expires_at > ? ORDER BY expires_at',
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
    } catch {
      // The other end went away mid-send. Nothing to do: its close handler
      // will run, and presence messages time out on their own.
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
