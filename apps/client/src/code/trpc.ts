import {
  boardDataGet,
  boardDataSet,
  FIXED_GROUP_ID,
  FIXED_USER_ID,
  HOME_PAGE_ID,
} from './areas/board/local-data';

/**
 * The stand-in for the old request layer.
 *
 * The app used to send a request to a server for anything it could not work
 * out on its own: make me a page, what is my starting page, mark this
 * notification read, charge my card. Most of those belong to parts this build
 * does not have.
 *
 * So instead of a server there is a short list of answers below. Everything
 * the whiteboard needs is answered properly. Everything else gives nothing
 * back and writes a line to the console, which is what the app already copes
 * with when a request fails.
 *
 * Boards themselves do not come through here at all. They go straight to the
 * board server over a web socket.
 */

const moduleLogger = mainLogger.sub('trpc');

/** Which page each page was made from, so the breadcrumb can be rebuilt. */
const PARENTS_KEY = 'boardPageParents';

function loadParents(): Record<string, string> {
  try {
    return JSON.parse(internals.localStorage?.getItem(PARENTS_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function rememberParent(pageId: string, parentPageId: string): void {
  const parents = loadParents();

  parents[pageId] = parentPageId;

  try {
    internals.localStorage?.setItem(PARENTS_KEY, JSON.stringify(parents));
  } catch {
    // Storage switched off. The breadcrumb will start from the home board
    // instead of showing the full way down.
  }
}

/** Walk up from a page to the home board, newest last. */
function pathTo(pageId: string): string[] {
  const parents = loadParents();
  const path = [pageId];

  let current = pageId;

  while (parents[current] != null && !path.includes(parents[current])) {
    current = parents[current];
    path.unshift(current);
  }

  if (path[0] !== HOME_PAGE_ID) {
    path.unshift(HOME_PAGE_ID);
  }

  return path;
}

function myList(field: string): string[] {
  return (boardDataGet('user', FIXED_USER_ID, field) as string[]) ?? [];
}

function setMyList(field: string, pageIds: string[]): void {
  boardDataSet('user', FIXED_USER_ID, field, pageIds);
}

type Handler = (input: any) => unknown;

const handlers: Record<string, Handler> = {
  // --- Pages

  'pages.create': (input: {
    pageId: string;
    parentPageId: string;
    pageEncryptedRelativeTitle: Uint8Array;
    pageEncryptedAbsoluteTitle: Uint8Array;
  }) => {
    boardDataSet(
      'page',
      input.pageId,
      'encrypted-relative-title',
      input.pageEncryptedRelativeTitle,
    );
    boardDataSet(
      'page',
      input.pageId,
      'encrypted-absolute-title',
      input.pageEncryptedAbsoluteTitle,
    );

    rememberParent(input.pageId, input.parentPageId);

    // `numFreePages` only ever drove the paid-plan nag, which is gone.
    return { pageId: input.pageId, numFreePages: null };
  },

  // Used to bump a page up the recent list. The list lives in this browser.
  'pages.bump': (input: { pageId: string }) => {
    const recent = myList('recent-page-ids').filter(
      (pageId) => pageId !== input.pageId,
    );

    recent.unshift(input.pageId);

    setMyList('recent-page-ids', recent.slice(0, 50));

    return undefined;
  },

  'pages.backlinks.create': (input: {
    sourcePageId: string;
    targetPageId: string;
  }) => {
    const list =
      (boardDataGet('page-backlinks', input.targetPageId, 'list') as string[]) ??
      [];

    if (!list.includes(input.sourcePageId)) {
      boardDataSet('page-backlinks', input.targetPageId, 'list', [
        ...list,
        input.sourcePageId,
      ]);
    }

    return undefined;
  },

  'pages.backlinks.delete': (input: {
    sourcePageId: string;
    targetPageId: string;
  }) => {
    const list =
      (boardDataGet('page-backlinks', input.targetPageId, 'list') as string[]) ??
      [];

    boardDataSet(
      'page-backlinks',
      input.targetPageId,
      'list',
      list.filter((pageId) => pageId !== input.sourcePageId),
    );

    return undefined;
  },

  // Boards cannot be deleted in this build. Saying so out loud beats the old
  // behaviour, which closed the dialog as if it had worked and left the board
  // exactly where it was.
  'pages.deletion.delete': () => {
    throw new Error('Boards cannot be deleted in this build.');
  },
  'pages.deletion.restore': () => {
    throw new Error('Boards cannot be deleted in this build.');
  },
  'pages.deletion.deletePermanently': () => {
    throw new Error('Boards cannot be deleted in this build.');
  },

  // There is no page history in this build.
  'pages.snapshots.load': () => ({ encryptedSymmetricKey: null, data: null }),
  'pages.snapshots.save': () => undefined,
  'pages.snapshots.delete': () => undefined,

  // --- Where you are

  'groups.getMainPageId': () => HOME_PAGE_ID,
  'groups.getUserIds': () => [FIXED_USER_ID],
  'groups.getPages': () => ({ pageIds: [], numPages: 0 }),

  'users.pages.getStartingPageId': () => HOME_PAGE_ID,
  'users.pages.getGroupIds': () => [FIXED_GROUP_ID],
  'users.pages.getCurrentPath': (input: { initialPageId: string }) =>
    pathTo(input.initialPageId),

  // --- Your own lists

  'users.pages.addFavoritePages': (input: { pageIds: string[] }) => {
    const favorites = new Set(myList('favorite-page-ids'));

    for (const pageId of input.pageIds) {
      favorites.add(pageId);
    }

    setMyList('favorite-page-ids', [...favorites]);

    return undefined;
  },

  'users.pages.removeFavoritePages': (input: { pageIds: string[] }) => {
    setMyList(
      'favorite-page-ids',
      myList('favorite-page-ids').filter(
        (pageId) => !input.pageIds.includes(pageId),
      ),
    );

    return undefined;
  },

  'users.pages.clearFavoritePages': () => {
    setMyList('favorite-page-ids', []);

    return undefined;
  },

  'users.pages.removeRecentPages': (input: { pageIds: string[] }) => {
    setMyList(
      'recent-page-ids',
      myList('recent-page-ids').filter(
        (pageId) => !input.pageIds.includes(pageId),
      ),
    );

    return undefined;
  },

  'users.pages.clearRecentPages': () => {
    setMyList('recent-page-ids', []);

    return undefined;
  },

  // The starting note and arrow are built into this build, so there is nothing
  // to save. Accepting the call quietly keeps the settings panel working.
  'users.pages.setEncryptedDefaultNote': () => undefined,
  'users.pages.setEncryptedDefaultArrow': () => undefined,

  // --- Gone with the accounts

  'users.pages.notifications.load': () => ({
    items: [],
    hasMore: false,
    lastNotificationRead: undefined,
  }),
  'users.pages.notifications.markAsRead': () => undefined,
};

function call(path: string, input: unknown): Promise<unknown> {
  const handler = handlers[path];

  if (handler == null) {
    moduleLogger.info(`Nothing answers "${path}" in this build`);

    return Promise.resolve(undefined);
  }

  try {
    return Promise.resolve(handler(input));
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * Looks and behaves like the old client: `trpcClient.pages.create.mutate(...)`.
 * Each dot adds to the name, and `query` or `mutate` at the end runs it.
 */
function makeCaller(path: string[]): any {
  return new Proxy(() => undefined, {
    get(_target, property: string | symbol) {
      if (property === 'query' || property === 'mutate') {
        return (input: unknown) => call(path.join('.'), input);
      }

      // Without this, awaiting a half-written call by mistake makes JavaScript
      // treat the proxy as a promise and wait for ever instead of failing.
      if (typeof property === 'symbol' || property === 'then') {
        return undefined;
      }

      return makeCaller([...path, property]);
    },
  });
}

export const trpcClient: any = makeCaller([]);
