// The one shared password, and the short-lived pass it is traded for.
//
// Why a pass instead of sending the password every time: a browser cannot put
// a header on a web socket connection, so the only things it can carry are the
// address and the sub-protocol. Addresses end up in logs. A pass is short
// lived, so a leaked one stops working, and the password itself is only ever
// sent once, in the body of a POST.

const encoder = new TextEncoder();

// How long a pass lasts, in milliseconds. The browser asks for a new one when
// the old one is refused, so this only decides how long a stolen pass is worth
// anything.
const PASS_LIFETIME_MS = 12 * 60 * 60 * 1000;

async function sha256(value: string): Promise<ArrayBuffer> {
  return await crypto.subtle.digest('SHA-256', encoder.encode(value));
}

/**
 * Compare two secrets without leaking, through how long it takes, how much of
 * the start matched. Both are hashed first so they are always the same length,
 * which timingSafeEqual requires.
 */
export async function secretsMatch(a: string, b: string): Promise<boolean> {
  const [hashA, hashB] = await Promise.all([sha256(a), sha256(b)]);

  return crypto.subtle.timingSafeEqual(hashA, hashB);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let str = '';

  for (const byte of bytes) {
    str += String.fromCharCode(byte);
  }

  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const str = atob(padded);
  const bytes = new Uint8Array(str.length);

  for (let i = 0; i < str.length; i++) {
    bytes[i] = str.charCodeAt(i);
  }

  return bytes;
}

async function signingKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/**
 * Make a pass that says "this browser typed the right password", good until
 * PASS_LIFETIME_MS from now. The shape is `<expiry>.<signature>`, which is
 * safe to use as a web socket sub-protocol: no commas, spaces or slashes.
 */
export async function issuePass(secret: string, now: number): Promise<string> {
  const payload = String(now + PASS_LIFETIME_MS);

  const signature = await crypto.subtle.sign(
    'HMAC',
    await signingKey(secret),
    encoder.encode(payload),
  );

  return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * Check a pass. Returns false for anything wrong: wrong shape, wrong
 * signature, or out of date. Never says which.
 */
export async function passIsValid(
  secret: string,
  pass: string,
  now: number,
): Promise<boolean> {
  const separator = pass.indexOf('.');

  if (separator <= 0) {
    return false;
  }

  const payload = pass.slice(0, separator);
  const signature = pass.slice(separator + 1);

  if (!/^\d{1,15}$/.test(payload) || !/^[A-Za-z0-9_-]{1,120}$/.test(signature)) {
    return false;
  }

  let signatureBytes: Uint8Array;

  try {
    signatureBytes = base64UrlDecode(signature);
  } catch {
    return false;
  }

  const signatureIsGood = await crypto.subtle.verify(
    'HMAC',
    await signingKey(secret),
    signatureBytes,
    encoder.encode(payload),
  );

  if (!signatureIsGood) {
    return false;
  }

  return Number(payload) > now;
}
