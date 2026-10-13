// Small HTTP helpers shared by the dashboard routes and the /api/v1 routes.

import { TodoError } from './store.js';

// A request that can't be served as sent. `status` and `code` are used by /api/v1;
// the dashboard's own routes answer every TodoError with 400, as they always have.
export class RequestError extends TodoError {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new RequestError(413, 'too_large', 'Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const contentType = (req) => String(req.headers['content-type'] || '').toLowerCase();

export async function readJson(req, limit = 1_000_000) {
  if (!contentType(req).startsWith('application/json')) {
    throw new RequestError(415, 'unsupported_media_type', 'Expected Content-Type: application/json');
  }
  const text = await readBody(req, limit);
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new RequestError(400, 'invalid_json', 'Invalid JSON body');
  }
}

// For endpoints that also take a bare line of text (quick capture from a script
// or an iOS Shortcut): returns { text } from a text/plain body, else parses JSON.
export async function readJsonOrText(req, limit) {
  if (contentType(req).startsWith('text/plain')) return { text: await readBody(req, limit) };
  return readJson(req, limit);
}
