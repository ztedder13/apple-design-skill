// Small helpers shared by every request handler. Handlers take a standard Request and return
// a standard Response, so the same code runs in Netlify Functions and in the dev server.

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

export function errorResponse(error) {
  if (error instanceof HttpError) {
    return json(error.status, { error: error.message, code: error.code, ...error.extra });
  }
  console.error(error);
  return json(500, { error: "Something went wrong on the server. Try again in a moment.", code: "SERVER_ERROR" });
}

export function requireMethod(request, ...allowed) {
  if (!allowed.includes(request.method)) {
    throw new HttpError(405, "METHOD_NOT_ALLOWED", `Use ${allowed.join(" or ")}.`);
  }
}

// Reads the body as a stream and stops once it passes the limit, so a large post can't exhaust
// memory. Content-Length is used only to refuse early; the bytes actually read are what count.
async function readBody(request, limitBytes) {
  const tooLarge = () => new HttpError(413, "TOO_LARGE", "The request is too large.");
  if (Number(request.headers.get("content-length")) > limitBytes) throw tooLarge();
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limitBytes) {
      reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readJson(request, limitBytes = 16 * 1024) {
  const text = new TextDecoder().decode(await readBody(request, limitBytes));
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "INVALID", "The request body must be JSON.");
  }
}
