import { bytesToBase64, base64ToBytes } from '@stdlib/base64';
import {
  createKeyring,
  createPrivateKeyring,
  createSymmetricKeyring,
  wrapKeyPair,
} from '@stdlib/crypto';
import { textToBytes } from '@stdlib/misc';
import sodium from 'libsodium-wrappers-sumo';
import { once } from 'lodash';

/**
 * The made-up account, group and keys this build runs on.
 *
 * The original app locks everything with keys that come from your password.
 * This build has no accounts, so there is nothing to make a key from. Rather
 * than tear the locking out of several hundred places, every lock is given the
 * same key, which is written into the app in plain sight.
 *
 * That means the locking is decoration. It is NOT security, and nothing here
 * is hidden from anybody who can open the app. What actually keeps other
 * people out is the shared password on the board server and the board link
 * being private. Never treat a board as private.
 *
 * Everything in here must be built lazily, with `once`. The app sets up its
 * cryptography after this file is first loaded, so anything built while the
 * file is being read would fail with "sodium not ready".
 */

/** The one group every board belongs to. Twenty-one characters, like a real id. */
export const FIXED_GROUP_ID = 'group0000000000000001';

/** The made-up person everybody is. */
export const FIXED_USER_ID = 'user00000000000000001';

/** The board you land on when you open the app with no board in the address. */
export const HOME_PAGE_ID = 'board0000000000000001';

/**
 * The key every lock in the app uses. All zeroes, on purpose: it is not a
 * secret and pretending otherwise would be worse.
 *
 * Thirty-two zero bytes makes a keyring the app treats as already unlocked,
 * which is what lets every page and group open without a password.
 */
const FIXED_KEY_BYTES = () => new Uint8Array(32);

export const fixedSymmetricKeyring = once(() =>
  createSymmetricKeyring(FIXED_KEY_BYTES()),
);

/** The same keyring in the form the app expects to read out of storage. */
export const fixedKeyringBytes = once(
  () => fixedSymmetricKeyring().wrappedValue,
);

/**
 * This browser's key pair.
 *
 * Only used for things this build does not have — notifications and invites —
 * so a fresh pair per browser is fine. It is kept so it does not change on
 * every reload, which would make the app think the account changed.
 */
export const fixedKeyPair = once(() => {
  const stored = internals.localStorage?.getItem('boardKeyPair');

  if (stored != null) {
    try {
      const [publicBytes, privateBytes] = stored.split('.');

      return wrapKeyPair(
        createKeyring(base64ToBytes(publicBytes)),
        createPrivateKeyring(base64ToBytes(privateBytes)),
      );
    } catch {
      // Stored in an older shape, or damaged. Make a new one.
    }
  }

  const raw = sodium.crypto_box_keypair();

  try {
    internals.localStorage?.setItem(
      'boardKeyPair',
      `${bytesToBase64(raw.publicKey)}.${bytesToBase64(raw.privateKey)}`,
    );
  } catch {
    // A browser with storage switched off still works; the pair is just new
    // every time.
  }

  return wrapKeyPair(
    createKeyring(raw.publicKey),
    createPrivateKeyring(raw.privateKey),
  );
});

/** A name, locked with the fixed key, in the shape the app reads it back in. */
export function fixedEncryptedName(
  name: string,
  associatedData: Record<string, unknown>,
): Uint8Array {
  return fixedSymmetricKeyring().encrypt(textToBytes(name), {
    padding: true,
    associatedData,
  });
}
