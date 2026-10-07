import { issuePass, passIsValid, secretsMatch } from './auth';

export { BoardRoom } from './board-room';

// A room name is `page:<id>` for a board, or `index:<id>` for the small shared
// list of board names and which board sits inside which. Anything else is
// refused, so a stray address cannot quietly create junk rooms.
const ROOM_NAME = /^(page|index):[A-Za-z0-9_-]{1,64}$/;

function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');
}

function originIsAllowed(env: Env, origin: string | null): boolean {
  const allowed = allowedOrigins(env);

  // With nothing configured, only same-origin requests work, which is what
  // happens when the app and this server share a domain.
  if (allowed.length === 0) {
    return origin === null;
  }

  return origin !== null && allowed.includes(origin);
}

function corsHeaders(env: Env, origin: string | null): HeadersInit {
  if (origin === null || !originIsAllowed(env, origin)) {
    return {};
  }

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(
  body: unknown,
  status: number,
  headers: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

async function handleAuth(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('Origin');
  const cors = corsHeaders(env, origin);

  if (!originIsAllowed(env, origin)) {
    return json({ error: 'Not allowed.' }, 403);
  }

  if (env.BOARD_PASSWORD == null || env.BOARD_PASSWORD === '') {
    return json({ error: 'Server is not set up.' }, 500, cors);
  }

  let password: unknown;

  try {
    // Cap the body so a huge POST cannot be used to chew through memory.
    const body = await request.text();

    if (body.length > 4096) {
      return json({ error: 'Wrong password.' }, 401, cors);
    }

    password = (JSON.parse(body) as { password?: unknown }).password;
  } catch {
    return json({ error: 'Wrong password.' }, 401, cors);
  }

  if (typeof password !== 'string' || password === '') {
    return json({ error: 'Wrong password.' }, 401, cors);
  }

  if (!(await secretsMatch(password, env.BOARD_PASSWORD))) {
    return json({ error: 'Wrong password.' }, 401, cors);
  }

  return json(
    { pass: await issuePass(env.PASS_SECRET, Date.now()) },
    200,
    cors,
  );
}

async function handleRoom(
  request: Request,
  env: Env,
  roomName: string,
): Promise<Response> {
  if (!ROOM_NAME.test(roomName)) {
    return new Response('No such board.', { status: 404 });
  }

  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('Expected a web socket.', { status: 426 });
  }

  if (!originIsAllowed(env, request.headers.get('Origin'))) {
    return new Response('Not allowed.', { status: 403 });
  }

  // A browser cannot set a header on a web socket, so the pass travels as the
  // sub-protocol. Close with 1008 rather than refusing the upgrade, so the app
  // can tell "wrong pass" apart from "server down" and ask for the password
  // again.
  const pass = request.headers.get('Sec-WebSocket-Protocol') ?? '';

  if (!(await passIsValid(env.PASS_SECRET, pass, Date.now()))) {
    return new Response('Wrong pass.', { status: 401 });
  }

  const response = await env.BOARD_ROOM.getByName(roomName).fetch(request);

  if (response.status !== 101 || response.webSocket == null) {
    return response;
  }

  // The sub-protocol must be echoed back or the browser drops the connection.
  const headers = new Headers(response.headers);
  headers.set('Sec-WebSocket-Protocol', pass);

  return new Response(null, {
    status: 101,
    webSocket: response.webSocket,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.slice(1);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(env, request.headers.get('Origin')),
      });
    }

    if (path === 'health') {
      return new Response('ok');
    }

    if (path === 'auth' && request.method === 'POST') {
      return await handleAuth(request, env);
    }

    if (request.method === 'GET') {
      return await handleRoom(request, env, path);
    }

    return new Response('Not found.', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
