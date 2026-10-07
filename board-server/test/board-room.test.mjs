// Checks a running board server end to end: password, pass, joining a board,
// sending a change, getting it back on a second connection, and two people
// seeing each other's changes.
//
// This talks to a real deployed server, because the Cloudflare runtime cannot
// run on this machine (it needs macOS 13.5 or newer).
//
// Run it like this, from the board-server folder:
//
//   BOARD_URL=https://deepboard-server.yt3dp.workers.dev \
//   BOARD_ORIGIN=http://localhost:60379 \
//   BOARD_PASSWORD="<the shared password>" \
//   node test/board-room.test.mjs
//
// It prints one line per check and exits non-zero if any check fails.

import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import WebSocket from 'ws';
import * as Y from 'yjs';

const BASE = process.env.BOARD_URL;
const ORIGIN = process.env.BOARD_ORIGIN;
const PASSWORD = process.env.BOARD_PASSWORD;

if (!BASE || !ORIGIN || !PASSWORD) {
  console.error('Set BOARD_URL, BOARD_ORIGIN and BOARD_PASSWORD.');
  process.exit(2);
}

const DOC = 0;
const AWARENESS = 1;
const SERVER_ALL_UPDATES = 0;
const SERVER_SINGLE_UPDATE = 1;
const SERVER_ACK = 2;
const CLIENT_SINGLE_UPDATE = 1;

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function getPass(password = PASSWORD) {
  const response = await fetch(`${BASE}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ password }),
  });

  if (!response.ok) {
    return null;
  }

  return (await response.json()).pass;
}

function connect(room, pass) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `${BASE.replace(/^http/, 'ws')}/${room}`,
      [pass],
      { origin: ORIGIN },
    );

    socket.binaryType = 'arraybuffer';

    const messages = [];
    const waiters = [];

    socket.on('message', (data) => {
      const bytes = new Uint8Array(data);
      messages.push(bytes);

      for (const waiter of waiters.splice(0)) {
        waiter();
      }
    });

    socket.on('open', () =>
      resolve({
        socket,
        messages,
        send: (bytes) => socket.send(bytes),
        close: () => socket.close(),
        /** Wait until `messages` has at least `n` entries, or time out. */
        async waitFor(n, ms = 8000) {
          const deadline = Date.now() + ms;

          while (messages.length < n && Date.now() < deadline) {
            await new Promise((r) => {
              waiters.push(r);
              setTimeout(r, 100);
            });
          }

          return messages.length >= n;
        },
      }),
    );

    socket.on('error', reject);

    setTimeout(() => reject(new Error('Connection timed out.')), 15000);
  });
}

function singleUpdateMessage(updateId, update) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, DOC);
  encoding.writeVarUint(encoder, CLIENT_SINGLE_UPDATE);
  encoding.writeVarUint(encoder, updateId);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}

/** Pull the list of stored updates out of an ALL_UPDATES_UNMERGED message. */
function readAllUpdates(bytes) {
  const decoder = decoding.createDecoder(bytes);

  if (decoding.readVarUint(decoder) !== DOC) {
    return null;
  }
  if (decoding.readVarUint(decoder) !== SERVER_ALL_UPDATES) {
    return null;
  }

  decoding.readVarUint(decoder); // highest index, not needed here

  const count = decoding.readVarUint(decoder);
  const updates = [];

  for (let i = 0; i < count; i++) {
    updates.push(decoding.readVarUint8Array(decoder));
  }

  const rotate = decoding.readUint8(decoder);
  const snapshot = decoding.readUint8(decoder);

  return { updates, rotate, snapshot };
}

/** Build a Yjs change that writes one key into a map. */
function makeUpdate(key, value) {
  const doc = new Y.Doc();
  doc.getMap('test').set(key, value);
  return Y.encodeStateAsUpdateV2(doc);
}

/** Apply a list of updates and read a key back out. */
function readKey(updates, key) {
  const doc = new Y.Doc();
  doc.transact(() => {
    for (const update of updates) {
      Y.applyUpdateV2(doc, update);
    }
  });
  return doc.getMap('test').get(key);
}

const room = `page:test${Math.floor(Date.now() / 1000)}`;

console.log(`Board server: ${BASE}`);
console.log(`Test room: ${room}\n`);

// --- The password

console.log('Password');
check('a wrong password is refused', (await getPass('definitely-wrong')) === null);

const pass = await getPass();
check('the right password gives a pass', typeof pass === 'string' && pass.includes('.'));

// --- A made-up pass

console.log('\nPasses');
try {
  await connect(room, '9999999999999.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  check('a made-up pass is refused', false, 'the connection was accepted');
} catch {
  check('a made-up pass is refused', true);
}

// --- Joining an empty board

console.log('\nJoining a board');
const first = await connect(room, pass);
check('connected', true);

await first.waitFor(2);
check('the board sends its contents and who is here', first.messages.length >= 2);

const firstAll = readAllUpdates(first.messages[0]);
check('the contents message can be read', firstAll !== null);
check('a new board is empty', firstAll?.updates.length === 0, `got ${firstAll?.updates.length}`);
check('re-keying is off', firstAll?.rotate === 0);
check('snapshots are off', firstAll?.snapshot === 0);

// --- Sending a change

console.log('\nSending a change');
first.send(singleUpdateMessage(0, makeUpdate('colour', 'amber')));

await first.waitFor(3);
const ack = first.messages[2];
check(
  'the change is confirmed',
  ack != null && ack[0] === DOC && ack[1] === SERVER_ACK,
  ack ? `got type ${ack[1]}` : 'no reply',
);

// --- A second person joining sees it

console.log('\nA second person joins');
const second = await connect(room, pass);
await second.waitFor(2);

const secondAll = readAllUpdates(second.messages[0]);
check('they are sent the stored change', secondAll?.updates.length === 1, `got ${secondAll?.updates.length}`);
check(
  'the change says what it should',
  readKey(secondAll?.updates ?? [], 'colour') === 'amber',
  `got ${readKey(secondAll?.updates ?? [], 'colour')}`,
);

// --- Live relay between the two

console.log('\nLive changes between two people');
const before = second.messages.length;
first.send(singleUpdateMessage(1, makeUpdate('shape', 'square')));

await second.waitFor(before + 1);
const relayed = second.messages[before];
check(
  'the other person is told straight away',
  relayed != null && relayed[0] === DOC && relayed[1] === SERVER_SINGLE_UPDATE,
  relayed ? `got type ${relayed[1]}` : 'nothing arrived',
);

// --- Presence

console.log('\nPresence');
const awarenessEncoder = encoding.createEncoder();
encoding.writeVarUint(awarenessEncoder, AWARENESS);
encoding.writeVarUint(awarenessEncoder, 1);
encoding.writeVarUint8Array(awarenessEncoder, new Uint8Array([1, 2, 3, 4]));

const beforeAwareness = second.messages.length;
first.send(encoding.toUint8Array(awarenessEncoder));

await second.waitFor(beforeAwareness + 1);
const presence = second.messages[beforeAwareness];
check(
  'presence is passed on',
  presence != null && presence[0] === AWARENESS,
  presence ? `got type ${presence[0]}` : 'nothing arrived',
);

// --- It is still there after everyone leaves

console.log('\nAfter everyone leaves');
first.close();
second.close();
await new Promise((r) => setTimeout(r, 1500));

const third = await connect(room, await getPass());
await third.waitFor(2);
const thirdAll = readAllUpdates(third.messages[0]);
check('the board is still there', (thirdAll?.updates.length ?? 0) >= 1);
check(
  'both changes survived',
  readKey(thirdAll?.updates ?? [], 'colour') === 'amber' &&
    readKey(thirdAll?.updates ?? [], 'shape') === 'square',
);
third.close();

// --- An empty change is harmless

console.log('\nOdd input');
const fourth = await connect(room, await getPass());
await fourth.waitFor(2);
const beforeEmpty = fourth.messages.length;
fourth.send(singleUpdateMessage(7, new Uint8Array(0)));
await fourth.waitFor(beforeEmpty + 1);
const emptyAck = fourth.messages[beforeEmpty];
check(
  'an empty change is still confirmed',
  emptyAck != null && emptyAck[1] === SERVER_ACK,
);

const beforeJunk = fourth.messages.length;
fourth.send(new Uint8Array([99, 99, 99]));
await new Promise((r) => setTimeout(r, 1000));
check('a nonsense message does not drop the connection', fourth.socket.readyState === 1);
check('a nonsense message gets no reply', fourth.messages.length === beforeJunk);
fourth.close();

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
