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

export async function getRedirectDest(input: {
  route: RouteLocationNormalized;
  auth: AuthStore;
  cookies?: typeof Cookies;
}) {
  if (input.route.name === 'page') {
    return;
  }

  return { name: 'page', params: { pageId: HOME_PAGE_ID } };
}
