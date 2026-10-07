import {
  CollabClientDocMessageType,
  CollabMessageType,
  CollabServerDocMessageType,
} from '@deeplib/misc';
import { Resolvable } from '@stdlib/misc';
import { Y } from '@syncedstore/core';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { cloneDeep, once, throttle } from 'lodash';
import { getBoardPass, renewBoardPass } from 'src/code/areas/board/pass';
import { isWithinTimeout } from 'src/code/utils/misc';
import * as awarenessProtocol from 'y-protocols/awareness';

import type { Page } from '../page';
import type { PageCollab } from './collab';
import type { IAwarenessChanges } from './presence';

/**
 * The link between one open board and the board server.
 *
 * Changes travel as plain Yjs updates: nothing is scrambled, because there are
 * no per-person keys in this build. The board server stores them and passes
 * them to everybody else who has the same board open.
 *
 * The password is never sent here. The browser trades it for a pass once (see
 * `areas/board/pass.ts`) and that pass is handed over as the connection's
 * sub-protocol, which is the only thing a browser is allowed to put on a web
 * socket besides the address itself.
 */

/** Wait this long before the first retry, then double it, up to five seconds. */
const FIRST_RETRY_DELAY_MS = 500;
const LONGEST_RETRY_DELAY_MS = 5_000;

/**
 * Two failed handshakes in a row means the pass is being refused rather than
 * the server being down, so it is worth asking for the password again.
 */
const FAILURES_BEFORE_ASKING_AGAIN = 2;

export const PageWebsocket = once(
  () =>
    class {
      private readonly _logger;

      readonly page: Page;
      readonly collab: PageCollab;

      readonly doc;

      /**
       * Where everybody's cursors are. The board makes this, not the
       * connection, and the text editor reads it straight off here — so it
       * must stay the very same object, and must never be destroyed from here.
       */
      readonly awareness;

      private readonly _url: string;

      socket?: WebSocket;

      connectPromise?: Resolvable;
      syncPromise?: Resolvable;

      private _keepConnected = false;
      private _retryDelay = FIRST_RETRY_DELAY_MS;
      private _openedThisAttempt = false;
      private _failedHandshakes = 0;

      private readonly _updateBuffer: Uint8Array[] = [];

      private _updateId = 0;
      private _unackedUpdates = new Map<number, Uint8Array>();

      private _localAwarenessEnabled = false;

      constructor(input: { collab: PageCollab }) {
        this.page = input.collab.page;
        this.collab = input.collab;

        this.doc = input.collab.doc;
        this.awareness = input.collab.presence.awareness;

        this._url = `${process.env.COLLAB_SERVER_URL}/page:${this.page.id}`;

        this._logger = mainLogger.sub('Websocket').sub(this.page.id);
      }

      get connected() {
        return this.socket?.readyState === WebSocket.OPEN;
      }

      connect() {
        if (this.socket != null) {
          return;
        }

        this._keepConnected = true;

        this.connectPromise ??= new Resolvable();
        this.syncPromise ??= new Resolvable();

        void this._openSocket();
      }

      private async _openSocket() {
        const pass = await getBoardPass();

        if (!this._keepConnected || this.socket != null) {
          return;
        }

        if (pass == null) {
          this._logger.error('No pass, cannot open the board');
          return;
        }

        this._openedThisAttempt = false;

        const socket = new WebSocket(this._url, [pass]);

        socket.binaryType = 'arraybuffer';

        this.socket = socket;

        socket.addEventListener('error', (event) => {
          if (this.socket !== event.target) {
            return;
          }

          this._logger.error('Websocket error %o', event);
        });

        socket.addEventListener('open', () => {
          if (this.socket !== socket) {
            return;
          }

          this._logger.info('Websocket opened');

          this._openedThisAttempt = true;
          this._failedHandshakes = 0;
          this._retryDelay = FIRST_RETRY_DELAY_MS;

          this.connectPromise?.resolve();
          this.connectPromise = undefined;

          // Anything the server never confirmed goes back in the queue, so a
          // change made while the connection was down is not lost.
          if (this._unackedUpdates.size > 0) {
            this._updateBuffer.push(...this._unackedUpdates.values());

            this._unackedUpdates.clear();
          }

          this._sendDocSingleUpdateMessageImmediate();

          if (this._localAwarenessEnabled) {
            this._sendAwarenessMessageImmediate();
          }
        });

        socket.addEventListener('message', (event) => {
          if (this.socket !== socket) {
            return;
          }

          this._handleMessage(new Uint8Array(event.data as ArrayBuffer));
        });

        socket.addEventListener('close', () => {
          if (this.socket !== socket) {
            return;
          }

          this._logger.info('Websocket closed');

          this.socket = undefined;

          if (!this._keepConnected) {
            return;
          }

          // A connection that closes without ever opening was refused. The
          // likeliest reason is a pass that has run out.
          if (!this._openedThisAttempt) {
            this._failedHandshakes++;

            if (this._failedHandshakes >= FAILURES_BEFORE_ASKING_AGAIN) {
              this._failedHandshakes = 0;

              void renewBoardPass().then(() => {
                if (this._keepConnected) {
                  void this._openSocket();
                }
              });

              return;
            }
          }

          const delay = Math.min(this._retryDelay, LONGEST_RETRY_DELAY_MS);

          this._retryDelay = delay * 2;

          setTimeout(
            () => {
              if (this._keepConnected) {
                void this._openSocket();
              }
            },
            delay + delay * Math.random(),
          );
        });
      }

      send(message: Uint8Array, callback?: () => void) {
        if (this.connected) {
          this.socket?.send(message);

          callback?.();
        } else {
          void this.connectPromise?.then(() => {
            this.socket?.send(message);

            callback?.();
          });
        }
      }

      // Presence

      enableLocalAwareness() {
        if (!this.connected) {
          return;
        }

        if (this._localAwarenessEnabled) {
          return;
        }

        this._localAwarenessEnabled = true;

        this._logger.info('Enable local awareness');

        // Recover local awareness state

        this.awareness.setLocalState(
          cloneDeep((this as any).awareness.localStateBackup),
        );

        this._sendAwarenessMessageImmediate();

        this.awareness.on('update', this._handleAwarenessUpdate);

        if (typeof window !== 'undefined') {
          window.addEventListener('beforeunload', this.disableLocalAwareness);
        } else if (typeof process !== 'undefined') {
          process.on('exit', this.disableLocalAwareness);
        }
      }
      disableLocalAwareness = () => {
        if (!this._localAwarenessEnabled) {
          return;
        }

        this._localAwarenessEnabled = false;

        this._logger.info('Disable local awareness');

        if (typeof window !== 'undefined') {
          window.removeEventListener(
            'beforeunload',
            this.disableLocalAwareness,
          );
        } else if (typeof process !== 'undefined') {
          process.off('exit', this.disableLocalAwareness);
        }

        this.awareness.off('update', this._handleAwarenessUpdate);

        awarenessProtocol.removeAwarenessStates(
          this.awareness,
          [this.doc.clientID],
          null,
        );

        // Only worth sending while the connection is actually open. Queuing it
        // would be pointless: the message says "I have gone", and it is being
        // sent because this connection is going away.
        if (this.connected) {
          this._sendAwarenessMessageImmediate();
        }
      };

      // Changes going out

      private _handleDocUpdate = (update: Uint8Array, origin: any) => {
        if (origin === this) {
          return;
        }

        this._updateBuffer.push(update);

        this._sendDocSingleUpdateMessageThrottled();
      };

      private _sendDocSingleUpdateMessageImmediate() {
        if (this._updateBuffer.length === 0) {
          return;
        }

        const mergedUpdate = Y.mergeUpdatesV2(this._updateBuffer);

        const encoder = encoding.createEncoder();

        encoding.writeVarUint(encoder, CollabMessageType.DOC);
        encoding.writeVarUint(
          encoder,
          CollabClientDocMessageType.SINGLE_UPDATE,
        );

        encoding.writeVarUint(encoder, this._updateId);
        encoding.writeVarUint8Array(encoder, mergedUpdate);

        // Only clear the queue once the change is definitely on its way and
        // recorded as unconfirmed. Clearing any earlier loses the change if
        // anything below throws.
        this._unackedUpdates.set(this._updateId, mergedUpdate);
        this._updateBuffer.length = 0;

        const updateId = this._updateId++;

        this.send(encoding.toUint8Array(encoder), () => {
          this._logger.info(
            `Doc single update message sent (id: ${updateId}, size: ${mergedUpdate.length})`,
          );
        });
      }
      private _sendDocSingleUpdateMessageThrottled = throttle(
        () => this._sendDocSingleUpdateMessageImmediate(),
        200,
        { leading: false },
      );

      private _handleAwarenessUpdate = ({
        added,
        updated,
        removed,
      }: IAwarenessChanges) => {
        if (
          !added.includes(this.doc.clientID) &&
          !updated.includes(this.doc.clientID) &&
          !removed.includes(this.doc.clientID)
        ) {
          return;
        }

        if (!isWithinTimeout()) {
          this._sendAwarenessMessageThrottled();
        }
      };

      private _sendAwarenessMessageImmediate = () => {
        const awarenessUpdate = awarenessProtocol.encodeAwarenessUpdate(
          this.awareness,
          [this.doc.clientID],
        );

        const encoder = encoding.createEncoder();

        encoding.writeVarUint(encoder, CollabMessageType.AWARENESS);
        encoding.writeVarUint(encoder, 1);
        encoding.writeVarUint8Array(encoder, awarenessUpdate);

        this.send(encoding.toUint8Array(encoder), () => {
          this._logger.info(
            `Awareness message sent (size: ${awarenessUpdate.length})`,
          );
        });
      };
      private _sendAwarenessMessageThrottled = throttle(
        this._sendAwarenessMessageImmediate,
        200,
        { leading: false },
      );

      // Changes coming in

      private _handleMessage(message: Uint8Array) {
        const decoder = decoding.createDecoder(message);
        const messageType = decoding.readVarUint(decoder);

        switch (messageType) {
          case CollabMessageType.AWARENESS:
            this._handleAwarenessMessage(decoder);
            break;
          case CollabMessageType.DOC:
            this._handleDocMessage(decoder);
            break;
          default:
            this._logger.error(`Unknown message type ${messageType}`);
        }
      }

      private _handleAwarenessMessage(decoder: decoding.Decoder) {
        const numUpdates = decoding.readVarUint(decoder);

        for (let i = 0; i < numUpdates; i++) {
          try {
            awarenessProtocol.applyAwarenessUpdate(
              this.awareness,
              decoding.readVarUint8Array(decoder),
              this,
            );
          } catch (error) {
            // One unreadable cursor must not throw away the rest. Logged
            // because a silent catch here once hid a whole broken format.
            this._logger.error('Bad awareness update %o', error);
          }
        }
      }

      private _handleDocMessage(decoder: decoding.Decoder) {
        const syncMessageType = decoding.readVarUint(decoder);

        switch (syncMessageType) {
          case CollabServerDocMessageType.ALL_UPDATES_UNMERGED:
            this._handleDocAllUpdatesUnmergedMessage(decoder);
            break;
          case CollabServerDocMessageType.SINGLE_UPDATE:
            this._handleDocSingleUpdateMessage(decoder);
            break;
          case CollabServerDocMessageType.SINGLE_UPDATE_ACK:
            this._handleDocSingleUpdateAckMessage(decoder);
            break;
          default:
            this._logger.error(`Unknown doc message type ${syncMessageType}`);
        }
      }

      /**
       * Everything on the board, sent the moment a connection opens.
       *
       * The board only starts listening for its own changes once this arrives,
       * which is why the server always sends it, even for an empty board.
       */
      private _handleDocAllUpdatesUnmergedMessage(decoder: decoding.Decoder) {
        this._logger.info('Doc all updates unmerged message received');

        decoding.readVarUint(decoder); // highest change number, not needed here

        const numUpdates = decoding.readVarUint(decoder);

        this.doc.transact(() => {
          for (let i = 0; i < numUpdates; i++) {
            try {
              Y.applyUpdateV2(
                this.doc,
                decoding.readVarUint8Array(decoder),
                this,
              );
            } catch (error) {
              this._logger.error('Bad stored change %o', error);
            }
          }
        });

        this.syncPromise?.resolve();
        this.syncPromise = undefined;

        // Listen for our own changes from here on. Added after the stored ones
        // are applied so opening a board does not send it all straight back.
        this.doc.off('updateV2', this._handleDocUpdate);
        this.doc.on('updateV2', this._handleDocUpdate);

        // The old server could ask the browser to re-key the board or take a
        // snapshot here. This one never does, and both flags are always off.
        decoding.readUint8(decoder);
        decoding.readUint8(decoder);
      }

      private _handleDocSingleUpdateMessage(decoder: decoding.Decoder) {
        try {
          const update = decoding.readVarUint8Array(decoder);

          this._logger.info(
            `Doc single update message received (size: ${update.length})`,
          );

          Y.applyUpdateV2(this.doc, update, this);
        } catch (error) {
          this._logger.error('Bad change from somebody else %o', error);
        }
      }

      private _handleDocSingleUpdateAckMessage(decoder: decoding.Decoder) {
        const updateId = decoding.readVarUint(decoder);

        this._unackedUpdates.delete(updateId);

        this._logger.info(
          `Doc single update ack message received (id: ${updateId})`,
        );
      }

      disconnect() {
        this._logger.info('Disconnecting');

        this._keepConnected = false;

        this.disableLocalAwareness();

        this.connectPromise = undefined;
        this.syncPromise = undefined;

        if (this.socket?.readyState === WebSocket.OPEN) {
          this.socket.close();
        }

        this.socket = undefined;
      }

      destroy() {
        this.doc.off('updateV2', this._handleDocUpdate);

        this.disconnect();
      }
    },
);
export type PageWebsocket = InstanceType<ReturnType<typeof PageWebsocket>>;
