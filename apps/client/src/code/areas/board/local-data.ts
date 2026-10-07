import { base64ToBytes, bytesToBase64 } from '@stdlib/base64';
import { getFullKey, splitStr } from '@stdlib/misc';

import {
  FIXED_GROUP_ID,
  FIXED_USER_ID,
  HOME_PAGE_ID,
  fixedEncryptedName,
  fixedKeyPair,
  fixedKeyringBytes,
} from './fixed-keys';

/**
 * The stand-in for the old live server.
 *
 * The original app kept a pile of small facts on a server: who you are, what
 * you are allowed to do, what each page is called, which pages you looked at
 * recently. Hundreds of places in the app ask for those facts by name.
 *
 * This build has no such server, so the facts come from here instead. They
 * fall into three kinds:
 *
 *  - **Settled.** There is one person, one group, and everybody owns
 *    everything, so the answer never changes. Worked out from the fixed keys.
 *  - **Saved in this browser.** Which pages you looked at recently, which you
 *    starred. Yours alone, so it belongs in this browser and nowhere else.
 *  - **Shared.** Page names and the links between pages. Everybody must see
 *    the same ones, so these are kept on the board server, in a board of their
 *    own that holds nothing but this list.
 *
 * Asking for a fact that is not here gives nothing back, which is what the app
 * expects for anything missing. Nothing throws.
 */

/** Facts that are the same for everybody and never change. */
function settledValue(
  prefix: string,
  suffix: string,
  field: string,
): unknown | undefined {
  switch (`${prefix}>${field}`) {
    // Every board belongs to the one group, and its lock opens with the
    // built-in key. Without these two the app decides the board does not
    // exist and shows an error instead of a canvas.
    case 'page>group-id':
      return FIXED_GROUP_ID;
    case 'page>encrypted-symmetric-keyring':
      return fixedKeyringBytes();
    case 'page>exists':
      return true;
    case 'page>free':
      return true;
    case 'page>permanent-deletion-date':
      return undefined;

    case 'group>encrypted-content-keyring':
      return fixedKeyringBytes();
    case 'group>exists':
      return true;
    // Open to anybody who gets this far. This is what makes the app treat
    // everyone as a guest with no name of their own, which is exactly right
    // for a board with no accounts.
    case 'group>is-public':
      return true;
    case 'group>is-personal':
      return true;
    case 'group>is-password-protected':
      return false;
    case 'group>are-join-requests-allowed':
      return false;
    case 'group>permanent-deletion-date':
      return undefined;
    case 'group>main-page-id':
      return HOME_PAGE_ID;
    case 'group>encrypted-name':
      return fixedEncryptedName('Boards', {
        context: 'GroupName',
        groupId: suffix,
      });

    // Everybody is the owner, so nothing is ever read-only.
    case 'group-member>role':
      return 'owner';
    case 'group-member>exists':
      return true;

    // No invitations and no join requests exist in this build.
    case 'group-join-invitation>exists':
      return false;
    case 'group-join-request>exists':
      return false;
    case 'group-join-request>rejected':
      return false;

    // "pro" is what stops the app refusing to open a page.
    case 'user>plan':
      return 'pro';
    case 'user>public-keyring':
      return (fixedKeyPair().publicKey as unknown as { wrappedValue: Uint8Array })
        .wrappedValue;
    case 'user>two-factor-auth-enabled':
      return false;
    case 'user>email':
      return '';
    case 'user>encrypted-name':
      return fixedEncryptedName('You', {
        context: 'UserName',
        userId: suffix,
      });

    // No snapshots: the board server keeps the board, not its history.
    case 'page-snapshots>infos':
      return [];

    default:
      return undefined;
  }
}

/** Facts that belong to whoever is sitting at this browser. */
const MINE = new Set([
  'user>recent-page-ids',
  'user>favorite-page-ids',
  'user>recent-group-ids',
  'user>new',
]);

/** Facts everybody must agree on, kept on the board server. */
const SHARED = new Set([
  'page>encrypted-relative-title',
  'page>encrypted-absolute-title',
  'page-backlinks>list',
]);

function kindOf(prefix: string, field: string): 'mine' | 'shared' | 'settled' {
  const name = `${prefix}>${field}`;

  if (MINE.has(name)) {
    return 'mine';
  }

  if (SHARED.has(name)) {
    return 'shared';
  }

  return 'settled';
}

// --- Saved in this browser

const MY_STORAGE_KEY = 'boardMine';

let mine: Record<string, unknown> | undefined;

function loadMine(): Record<string, unknown> {
  if (mine != null) {
    return mine;
  }

  try {
    mine = JSON.parse(internals.localStorage?.getItem(MY_STORAGE_KEY) ?? '{}');
  } catch {
    mine = {};
  }

  return mine!;
}

function saveMine(): void {
  try {
    internals.localStorage?.setItem(MY_STORAGE_KEY, JSON.stringify(mine ?? {}));
  } catch {
    // Storage switched off. The app still works; nothing is remembered
    // between visits.
  }
}

// --- Shared, on the board server

/**
 * Page names and links, as a plain table that the shared-list connection keeps
 * in step with everybody else. Byte values are kept as text so they can travel
 * and be stored.
 */
const shared = new Map<string, unknown>();

let publishShared: ((fullKey: string, value: unknown) => void) | undefined;
let onSharedChange: ((fullKey: string, value: unknown) => void) | undefined;

/**
 * Hand over the two halves of the shared list: a way to send a change to
 * everybody, and a way to be told about theirs. Called once the connection to
 * the board server is up.
 */
export function useSharedList(params: {
  publish: (fullKey: string, value: unknown) => void;
  existing: Iterable<[string, unknown]>;
  onChange: (notify: (fullKey: string, value: unknown) => void) => void;
}): void {
  publishShared = params.publish;

  for (const [fullKey, value] of params.existing) {
    shared.set(fullKey, decodeBytes(value));
  }

  params.onChange((fullKey, value) => {
    shared.set(fullKey, decodeBytes(value));
    onSharedChange?.(fullKey, shared.get(fullKey));
  });
}

/** Be told whenever a shared fact changes, so the screen can be refreshed. */
export function whenSharedChanges(
  notify: (fullKey: string, value: unknown) => void,
): void {
  onSharedChange = notify;
}

/** Byte values travel as text, because that is all the shared list can hold. */
function encodeBytes(value: unknown): unknown {
  return value instanceof Uint8Array
    ? { bytes: bytesToBase64(value) }
    : value;
}

function decodeBytes(value: unknown): unknown {
  if (
    value != null &&
    typeof value === 'object' &&
    typeof (value as { bytes?: unknown }).bytes === 'string'
  ) {
    return base64ToBytes((value as { bytes: string }).bytes);
  }

  return value;
}

// --- What the rest of the app calls

export function boardDataGet(
  prefix: string,
  suffix: string,
  field: string,
): unknown {
  const fullKey = getFullKey(prefix, suffix, field);

  switch (kindOf(prefix, field)) {
    case 'mine':
      return loadMine()[fullKey];
    case 'shared':
      return shared.get(fullKey);
    default:
      return settledValue(prefix, suffix, field);
  }
}

export function boardDataSet(
  prefix: string,
  suffix: string,
  field: string,
  value: unknown,
): void {
  const fullKey = getFullKey(prefix, suffix, field);

  switch (kindOf(prefix, field)) {
    case 'mine':
      loadMine()[fullKey] = value;
      saveMine();
      break;
    case 'shared':
      shared.set(fullKey, value);
      publishShared?.(fullKey, encodeBytes(value));
      break;
    default:
      // Settled facts cannot be changed. The app sometimes writes them back
      // out of habit; quietly ignoring that is correct.
      break;
  }
}

/** Split `page:abc>group-id` back into its three parts. */
export function splitFullKey(
  fullKey: string,
): [prefix: string, suffix: string, field: string] {
  const [key, field] = splitStr(fullKey, '>', 2);
  const [prefix, suffix] = splitStr(key, ':', 2);

  return [prefix, suffix, field];
}

export { FIXED_GROUP_ID, FIXED_USER_ID, HOME_PAGE_ID };
