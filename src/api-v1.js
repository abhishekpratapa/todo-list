// The versioned API for other clients: /api/v1. Only served while remote access
// is on, and every route except health and sign-in needs a session (see admit()
// in server.js). Errors are always { "error": { "code", "message" } }.

import { clearedCookie, sessionCookie } from './auth.js';
import { RequestError, json, readJson } from './http.js';
import { ConflictError, NotFoundError, TodoError } from './store.js';

const error = (res, status, code, message, extra = {}) => json(res, status, { error: { code, message, ...extra } });

export function createV1({ remote, openStream }) {
  async function v1(req, res, ctx, url) {
    const p = url.pathname.slice('/api/v1'.length);
    const { method } = req;

    // Reveals nothing: whether a server is here is already visible from the connection itself.
    if (p === '/health' && method === 'GET') return json(res, 200, { status: 'ok' });

    if (p === '/session') {
      // Sign in: exchange the access token for a session cookie.
      if (method === 'POST') {
        const { token } = await readJson(req, ctx.bodyLimit);
        if (typeof token !== 'string' || !remote.checkToken(token.trim())) return ctx.refuseBadToken();
        res.setHeader('Set-Cookie', sessionCookie(remote.issueSession(), { secure: ctx.secure }));
        return json(res, 200, { ok: true });
      }
      if (method === 'GET') return json(res, 200, { kind: ctx.session.kind });
      if (method === 'DELETE') {
        res.setHeader('Set-Cookie', clearedCookie({ secure: ctx.secure }));
        return json(res, 200, { ok: true });
      }
    }

    if (p === '/events' && method === 'GET') return openStream(req, res, ctx);

    return error(res, 404, 'not_found', 'No such endpoint.');
  }

  // Turns a thrown error into a response.
  v1.fail = (res, e) => {
    if (e instanceof ConflictError) return error(res, 409, 'conflict', e.message, { current: e.current });
    if (e instanceof NotFoundError) return error(res, 404, 'not_found', e.message);
    if (e instanceof RequestError) return error(res, e.status, e.code, e.message);
    if (e instanceof TodoError) return error(res, 400, 'invalid', e.message);
    console.error(e);
    return error(res, 500, 'internal', 'Internal error');
  };

  return v1;
}
