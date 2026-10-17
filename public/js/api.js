/** A failed request. status 0 means the server could not be reached at all. */
export class ApiError extends Error {
  constructor(status, message, data = null) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

export async function api(method, url, body, { timeout = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let res;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch {
    throw new ApiError(0, navigator.onLine === false ? "You're offline." : "Can't reach the server right now.");
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* some responses have no JSON body */
  }
  if (!res.ok) {
    // A proxy in front of the app (or a tunnel that is down) answers with its own error page.
    const message = data?.error || (res.status >= 500 ? "The server isn't responding right now." : `Request failed (${res.status}).`);
    if (res.status === 401 && !url.startsWith('/api/login')) onUnauthorized();
    throw new ApiError(res.status, message, data);
  }
  return data;
}
