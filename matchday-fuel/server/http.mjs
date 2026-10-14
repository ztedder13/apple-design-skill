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

// Reads a JSON body without trusting Content-Length, capped so a large post can't exhaust memory.
export async function readJson(request, limitBytes = 16 * 1024) {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > limitBytes) {
    throw new HttpError(413, "TOO_LARGE", "The request is too large.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "INVALID", "The request body must be JSON.");
  }
}
