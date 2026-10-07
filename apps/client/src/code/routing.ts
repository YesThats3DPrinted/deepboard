import type { AuthStore } from 'src/stores/auth';
import type { RouteLocationNormalized, Router } from 'vue-router';

import { HOME_PAGE_ID } from './areas/board/local-data';

const moduleLogger = mainLogger.sub('routing.universal.ts');

/**
 * There is one screen: a board.
 *
 * The original app had a home page, a sign-up page, a log-in page, pricing, a
 * list of your pages and a page per group. All of those belonged to accounts
 * and to selling the thing. Here, anything that is not a board sends you
 * straight to the home board, so opening the app puts you on a canvas.
 *
 * A board address looks like `/pages/<board id>`. Share that and the other
 * person lands on the same board.
 */

export async function redirectIfNecessary(input: {
  router: Router;
  route: RouteLocationNormalized;
  auth: AuthStore;
  cookies?: typeof Cookies;
}) {
  const redirectDest = await getRedirectDest({
    route: input.route,
    auth: input.auth,
    cookies: input.cookies,
  });

  if (redirectDest != null) {
    moduleLogger.info(
      'redirectIfNecessary redirect: %s',
      JSON.stringify(redirectDest),
    );

    await input.router.replace(redirectDest);
  }
}

/**
 * What a board id is allowed to look like.
 *
 * The board server refuses anything else, and a refused connection looks
 * exactly like a wrong password to the browser, so an address with a stray
 * character in it would ask for the password over and over instead of saying
 * what was wrong. Catching it here sends you to the home board instead.
 */
const BOARD_ID = /^[A-Za-z0-9_-]{1,64}$/;

export async function getRedirectDest(input: {
  route: RouteLocationNormalized;
  auth: AuthStore;
  cookies?: typeof Cookies;
}) {
  if (
    input.route.name === 'page' &&
    BOARD_ID.test(String(input.route.params.pageId ?? ''))
  ) {
    return;
  }

  return { name: 'page', params: { pageId: HOME_PAGE_ID } };
}
