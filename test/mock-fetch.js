// Mock fetch: handler(url, init) returns {status?, body?, headers?}
export function mockFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: new URL(url), init });
    const r = await handler(new URL(url), init, calls.length);
    const status = r.status ?? 200;
    return { status, ok: status < 400, headers: new Headers(r.headers || {}), text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)) };
  };
  fn.calls = calls;
  return fn;
}
