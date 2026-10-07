import { Dialog } from 'quasar';
import { Resolvable } from '@stdlib/misc';

/**
 * The shared password, and the pass it is traded for.
 *
 * Nobody signs in. The first time this browser needs a board it asks for the
 * one shared password, swaps it with the board server for a pass, and keeps
 * the pass. From then on it never asks again, until the pass runs out.
 *
 * The pass is what actually opens a board. It runs out after a while, so a
 * copy of it that ends up in a log somewhere is worth nothing later.
 */

const STORAGE_KEY = 'boardPass';

const moduleLogger = mainLogger.sub('board/pass');

/** Where the board server is, worked out from the address boards connect to. */
export function boardServerUrl(): string {
  return (process.env.COLLAB_SERVER_URL ?? '').replace(/^ws/, 'http');
}

let asking: Resolvable<string | undefined> | undefined;

function storedPass(): string | undefined {
  try {
    return internals.localStorage?.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function storePass(pass: string): void {
  try {
    internals.localStorage?.setItem(STORAGE_KEY, pass);
  } catch {
    // Storage switched off. The password will be asked for again next visit.
  }
}

/** Forget the pass, so the next board asks for the password again. */
export function forgetBoardPass(): void {
  try {
    internals.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to forget.
  }
}

async function swapPasswordForPass(password: string): Promise<string | null> {
  const response = await fetch(`${boardServerUrl()}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });

  if (response.status === 429) {
    throw new Error('Too many tries. Wait a minute and try again.');
  }

  if (!response.ok) {
    return null;
  }

  return (await response.json()).pass ?? null;
}

function askForPassword(message?: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    Dialog.create({
      title: 'Password',
      message: message ?? 'Enter the password for these boards.',

      prompt: { model: '', type: 'password', outlined: true },

      persistent: true,
      cancel: false,

      ok: { label: 'Open', flat: true, color: 'primary' },
    }).onOk((password: string) => resolve(password));
  });
}

/**
 * The pass for this browser, asking for the password if there is not one yet.
 *
 * Several boards open at once, so this makes sure only one question is ever on
 * screen: everybody else waits for the same answer.
 */
export async function getBoardPass(): Promise<string | undefined> {
  const existing = storedPass();

  if (existing != null) {
    return existing;
  }

  if (asking != null) {
    return await asking;
  }

  asking = new Resolvable<string | undefined>();

  let message: string | undefined;

  try {
    for (;;) {
      const password = await askForPassword(message);

      if (password == null || password === '') {
        message = 'Enter the password for these boards.';
        continue;
      }

      let pass: string | null;

      try {
        pass = await swapPasswordForPass(password);
      } catch (error) {
        message = (error as Error).message;
        continue;
      }

      if (pass == null) {
        message = 'That password is wrong. Try again.';
        continue;
      }

      storePass(pass);

      moduleLogger.info('Got a pass');

      asking.resolve(pass);

      return pass;
    }
  } finally {
    asking = undefined;
  }
}

/**
 * Called when the board server refuses a pass. Throws the old one away and
 * asks again, so a pass that has run out fixes itself.
 */
export async function renewBoardPass(): Promise<string | undefined> {
  forgetBoardPass();

  return await getBoardPass();
}
