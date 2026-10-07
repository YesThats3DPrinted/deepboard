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

const third = await connect(room, pass);
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
const fourth = await connect(room, pass);
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

// --- A change too big for one stored row

console.log('\nA very big change');
const bigRoom = `page:big${Math.floor(Date.now() / 1000)}`;
const bigDoc = new Y.Doc();
bigDoc.getMap('test').set('blob', 'x'.repeat(1_600_000));
const bigUpdate = Y.encodeStateAsUpdateV2(bigDoc);
check('the test change really is over one million bytes', bigUpdate.length > 1_000_000, `${bigUpdate.length} bytes`);

const bigFirst = await connect(bigRoom, pass);
await bigFirst.waitFor(2);
bigFirst.send(singleUpdateMessage(0, bigUpdate));
await bigFirst.waitFor(3);
check('the big change is confirmed', bigFirst.messages[2]?.[1] === SERVER_ACK);
bigFirst.close();

await new Promise((r) => setTimeout(r, 1500));

const bigSecond = await connect(bigRoom, pass);
await bigSecond.waitFor(2);
const bigRead = readAllUpdates(bigSecond.messages[0]);
const bigLeftOver = bigSecond.messages
  .slice(1)
  .filter((m) => m[0] === DOC && m[1] === SERVER_SINGLE_UPDATE)
  .map((m) => {
    const d = decoding.createDecoder(m);
    decoding.readVarUint(d);
    decoding.readVarUint(d);
    return decoding.readVarUint8Array(d);
  });

const bigAll = [...(bigRead?.updates ?? []), ...bigLeftOver];
check(
  'the big change comes back in one piece',
  readKey(bigAll, 'blob')?.length === 1_600_000,
  `got ${readKey(bigAll, 'blob')?.length}`,
);

// --- The board is byte-for-byte the same after a cold read

const original = new Y.Doc();
Y.applyUpdateV2(original, bigUpdate);
const rebuilt = new Y.Doc();
rebuilt.transact(() => {
  for (const u of bigAll) {
    Y.applyUpdateV2(rebuilt, u);
  }
});
check(
  'nothing is missing from the rebuilt board',
  Buffer.from(Y.encodeStateVector(original)).equals(Buffer.from(Y.encodeStateVector(rebuilt))),
);
bigSecond.close();

// --- Two people opening the same brand-new board at the same moment

console.log('\nTwo people open a new board at once');
const raceRoom = `page:race${Math.floor(Date.now() / 1000)}`;

// Both start connecting at the same moment. Exactly one of them should be told
// the board is empty; that one builds it and saves a starting point straight
// away, which is what the real app does. The other must be made to wait and
// then be given that starting point. If both were told the board was empty,
// both would build a rival board and one person's first notes would vanish.
const raceConnects = [connect(raceRoom, pass), connect(raceRoom, pass)];

const builder = await Promise.race(raceConnects);
await builder.waitFor(1);
builder.send(singleUpdateMessage(0, makeUpdate('from', 'first')));

const [raceA, raceB] = await Promise.all(raceConnects);
const waiter = builder === raceA ? raceB : raceA;

await waiter.waitFor(1, 8000);
const waiterAll = readAllUpdates(waiter.messages[0]);

check(
  'the one that waited is told what is on the board first',
  waiterAll !== null,
  `first message started ${[...(waiter.messages[0] ?? []).slice(0, 3)].join(',')}`,
);
check(
  'only one of them is told the board is empty',
  (waiterAll?.updates.length ?? 0) >= 1,
  `the one that waited was told ${waiterAll?.updates.length} stored changes`,
);
check(
  'the one that waited gets what the first one saved',
  readKey(waiterAll?.updates ?? [], 'from') === 'first',
  `got ${readKey(waiterAll?.updates ?? [], 'from')}`,
);

raceA.close();
raceB.close();

// --- Squashing a long list of changes

console.log('\nSquashing a busy board');
const busyRoom = `page:busy${Math.floor(Date.now() / 1000)}`;
const busy = await connect(busyRoom, pass);
await busy.waitFor(2);

const BUSY_CHANGES = 110;

for (let i = 0; i < BUSY_CHANGES; i++) {
  busy.send(singleUpdateMessage(i, makeUpdate(`key${i}`, `value${i}`)));
}

// Wait for the last one to be confirmed before looking.
await busy.waitFor(2 + BUSY_CHANGES, 30000);
busy.close();

await new Promise((r) => setTimeout(r, 2000));

const afterSquash = await connect(busyRoom, pass);
await afterSquash.waitFor(2);

const squashed = readAllUpdates(afterSquash.messages[0]);
const squashedExtra = afterSquash.messages
  .slice(1)
  .filter((m) => m[0] === DOC && m[1] === SERVER_SINGLE_UPDATE)
  .map((m) => {
    const d = decoding.createDecoder(m);
    decoding.readVarUint(d);
    decoding.readVarUint(d);
    return decoding.readVarUint8Array(d);
  });

const squashedAll = [...(squashed?.updates ?? []), ...squashedExtra];

check(
  'the list really was squashed',
  squashedAll.length < BUSY_CHANGES,
  `${squashedAll.length} changes stored, started with ${BUSY_CHANGES}`,
);

let everyChangeSurvived = true;
let missing = '';

for (let i = 0; i < BUSY_CHANGES; i++) {
  if (readKey(squashedAll, `key${i}`) !== `value${i}`) {
    everyChangeSurvived = false;
    missing = `key${i}`;
    break;
  }
}

check(
  'squashing lost nothing',
  everyChangeSurvived,
  missing ? `${missing} is gone` : '',
);

afterSquash.close();

// --- Guessing the password

console.log('\nGuessing the password');
let sawRateLimit = false;
for (let i = 0; i < 45; i++) {
  const response = await fetch(`${BASE}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ password: `guess-${i}` }),
  });

  if (response.status === 429) {
    sawRateLimit = true;
    break;
  }
}
check('guessing over and over gets blocked', sawRateLimit);

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
