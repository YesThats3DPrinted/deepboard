import { boot } from 'quasar/wrappers';
import {
  FIXED_GROUP_ID,
  FIXED_USER_ID,
  fixedKeyPair,
  fixedSymmetricKeyring,
} from 'src/code/areas/board/fixed-keys';

const _moduleLogger = mainLogger.sub('boot/auth.client.ts');

/**
 * There is no signing in.
 *
 * The app is built so that almost everything checks "am I signed in, and as
 * whom". Rather than cut those checks out of hundreds of files, everyone is
 * simply always signed in, as the same made-up person, in the same single
 * group. Nothing is sent anywhere and no password is involved.
 *
 * The one real password is on the board server, and the app only asks for it
 * when it connects to a board. See `areas/board/pass.ts`.
 */
export default boot(async ({ store }) => {
  _moduleLogger.info('Signing in as the one built-in user');

  authStore(store).loggedIn = true;
  authStore(store).userId = FIXED_USER_ID;
  authStore(store).sessionId = FIXED_USER_ID;

  // The original app filled these in after a real sign-in. Plenty of code
  // reads them and would fail on undefined, so they are set here instead.
  internals.personalGroupId = FIXED_GROUP_ID;
  internals.keyPair = fixedKeyPair();
  internals.symmetricKeyring = fixedSymmetricKeyring();

  internals.realtime.connect();
});
