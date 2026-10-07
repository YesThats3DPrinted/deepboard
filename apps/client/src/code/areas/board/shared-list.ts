import { Y } from '@syncedstore/core';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';

import { useSharedList } from './local-data';
import { getBoardPass, renewBoardPass } from './pass';

/**
 * The one small list everybody shares: what each board is called, and which
 * boards link to which.
 *
 * It is kept the same way boards are: as a Yjs document on the board server,
 * in a room of its own. That means two people renaming different boards at the
 * same time both get their way, with no server logic at all.
 *
 * Board contents do NOT go through here. Each board has its own room.
 */

const ROOM = 'index:main';

const FIRST_RETRY_DELAY_MS = 500;
const LONGEST_RETRY_DELAY_MS = 5_000;
const FAILURES_BEFORE_ASKING_AGAIN = 2;

// The same numbers the board rooms use. See board-server/src/protocol.ts.
const DOC = 0;
const SERVER_ALL_UPDATES_UNMERGED = 0;
const SERVER_SINGLE_UPDATE = 1;
const SERVER_SINGLE_UPDATE_ACK = 2;
const CLIENT_SINGLE_UPDATE = 1;

const moduleLogger = mainLogger.sub('board/shared-list');

let started = false;

export function startSharedList(): void {
  if (started || process.env.SERVER) {
    return;
  }

  started = true;

  const doc = new Y.Doc();
  const data = doc.getMap<unknown>('data');

  // Listening from the moment the document exists, not from the moment the
  // connection is ready. A name changed in between still has to reach the
  // server, and `sendUpdate` queues it until there is somewhere to send it.
  doc.on('updateV2', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'server') {
      sendUpdate(update);
    }
  });

  let socket: WebSocket | undefined;
  let keepConnected = true;
  let retryDelay = FIRST_RETRY_DELAY_MS;
  let openedThisAttempt = false;
  let failedHandshakes = 0;
  let passInUse: string | undefined;
  let updateId = 0;

  /** Changes made before the connection was ready, or while it was down. */
  const unsent: Uint8Array[] = [];

  /** Changes sent but not yet confirmed, in case the connection drops. */
  const unconfirmed = new Map<number, Uint8Array>();

  function sendUpdate(update: Uint8Array) {
    if (socket?.readyState !== WebSocket.OPEN) {
      unsent.push(update);
      return;
    }

    const encoder = encoding.createEncoder();

    encoding.writeVarUint(encoder, DOC);
    encoding.writeVarUint(encoder, CLIENT_SINGLE_UPDATE);
    encoding.writeVarUint(encoder, updateId);
    encoding.writeVarUint8Array(encoder, update);

    unconfirmed.set(updateId, update);
    updateId++;

    socket.send(encoding.toUint8Array(encoder));
  }

  function sendEverythingWaiting() {
    // Anything the server never confirmed goes back in the queue first, so a
    // name changed just as the connection dropped is not quietly lost.
    if (unconfirmed.size > 0) {
      unsent.unshift(...unconfirmed.values());
      unconfirmed.clear();
    }

    for (const update of unsent.splice(0)) {
      sendUpdate(update);
    }
  }

  function handleMessage(bytes: Uint8Array) {
    const decoder = decoding.createDecoder(bytes);

    if (decoding.readVarUint(decoder) !== DOC) {
      return;
    }

    switch (decoding.readVarUint(decoder)) {
      case SERVER_ALL_UPDATES_UNMERGED: {
        decoding.readVarUint(decoder); // highest change number

        const count = decoding.readVarUint(decoder);

        doc.transact(() => {
          for (let i = 0; i < count; i++) {
            try {
              Y.applyUpdateV2(doc, decoding.readVarUint8Array(decoder), 'server');
            } catch (error) {
              moduleLogger.error('Bad stored list change %o', error);
            }
          }
        });

        sendEverythingWaiting();

        break;
      }

      case SERVER_SINGLE_UPDATE:
        try {
          Y.applyUpdateV2(doc, decoding.readVarUint8Array(decoder), 'server');
        } catch (error) {
          moduleLogger.error('Bad list change from somebody else %o', error);
        }
        break;

      case SERVER_SINGLE_UPDATE_ACK:
        unconfirmed.delete(decoding.readVarUint(decoder));
        break;

      default:
        break;
    }
  }

  async function open() {
    const pass = await getBoardPass();

    if (!keepConnected || socket != null || pass == null) {
      return;
    }

    openedThisAttempt = false;
    passInUse = pass;

    const opening = new WebSocket(
      `${process.env.COLLAB_SERVER_URL}/${ROOM}`,
      [pass],
    );

    opening.binaryType = 'arraybuffer';

    socket = opening;

    opening.addEventListener('open', () => {
      openedThisAttempt = true;
      failedHandshakes = 0;
      retryDelay = FIRST_RETRY_DELAY_MS;

      moduleLogger.info('Shared list connected');

      sendEverythingWaiting();
    });

    opening.addEventListener('message', (event) => {
      if (socket === opening) {
        handleMessage(new Uint8Array(event.data as ArrayBuffer));
      }
    });

    opening.addEventListener('close', () => {
      if (socket !== opening) {
        return;
      }

      socket = undefined;

      if (!keepConnected) {
        return;
      }

      if (!openedThisAttempt) {
        failedHandshakes++;

        if (failedHandshakes >= FAILURES_BEFORE_ASKING_AGAIN) {
          failedHandshakes = 0;

          void renewBoardPass(passInUse).then(() => {
            if (keepConnected) {
              void open();
            }
          });

          return;
        }
      }

      const delay = Math.min(retryDelay, LONGEST_RETRY_DELAY_MS);

      retryDelay = delay * 2;

      setTimeout(() => {
        if (keepConnected) {
          void open();
        }
      }, delay + delay * Math.random());
    });
  }

  useSharedList({
    publish: (fullKey, value) => data.set(fullKey, value),

    existing: [],

    onChange: (notify) => {
      data.observe((event) => {
        for (const fullKey of event.keysChanged) {
          notify(fullKey, data.get(fullKey));
        }
      });
    },
  });

  void open();

  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
      keepConnected = false;
    });
  }
}
