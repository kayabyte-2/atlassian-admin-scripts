// Minimal Atlassian Cloud REST client: basic auth, 429 retry, clear errors.
import { pathToFileURL } from 'node:url';

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export function configFromEnv(env = process.env) {
  const missing = ['ATLASSIAN_SITE', 'ATLASSIAN_EMAIL', 'ATLASSIAN_API_TOKEN'].filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`Missing environment variable(s): ${missing.join(', ')}. See README, "Setup".`);
  }
  const site = env.ATLASSIAN_SITE.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return { site, email: env.ATLASSIAN_EMAIL, token: env.ATLASSIAN_API_TOKEN };
}

export function createClient(config, { fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxRetries = 6 } = {}) {
  const auth = 'Basic ' + Buffer.from(`${config.email}:${config.token}`).toString('base64');

  async function request(method, path, { query, body, headers = {} } = {}) {
    const url = new URL(`https://${config.site}${path}`);
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const init = {
      method,
      headers: { Authorization: auth, Accept: 'application/json', ...headers },
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers['Content-Type'] = 'application/json';
    }
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url, init);
      if (res.status === 429 && attempt < maxRetries) {
        const ra = Number(res.headers.get('Retry-After'));
        const wait = (Number.isFinite(ra) && ra > 0 ? ra : 2 ** attempt) * 1000;
        console.error(`Rate limited (429), retrying in ${Math.round(wait / 1000)}s...`);
        await sleep(wait);
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw new ApiError(describe(method, path, res.status, text), res.status, text);
      if (!text) return null;
      try { return JSON.parse(text); } catch { return text; }
    }
  }
  return { request, get: (p, o) => request('GET', p, o), post: (p, o) => request('POST', p, o) };
}

function describe(method, path, status, text) {
  const hints = {
    401: 'Check ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN.',
    403: 'The account lacks the permission this call needs (see README, "Permissions").',
    404: 'Not found: check the site name and the key, id or group.',
  };
  let detail = text.slice(0, 300).replace(/\s+/g, ' ');
  return `${method} ${path} failed with HTTP ${status}. ${hints[status] || ''} ${detail}`.trim();
}

// Tiny argv parser: --flag, --key value, --key=value, repeated keys collect into arrays when listed in `multi`.
export function parseArgs(argv, { booleans = [], multi = [] } = {}) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    let [k, v] = a.slice(2).split(/=(.*)/s);
    if (booleans.includes(k)) { out[k] = true; continue; }
    if (v === undefined) {
      v = argv[++i];
      if (v === undefined) throw new Error(`Option --${k} needs a value.`);
    }
    if (multi.includes(k)) (out[k] ||= []).push(v); else out[k] = v;
  }
  return out;
}

export const isMain = (metaUrl) => process.argv[1] && metaUrl === pathToFileURL(process.argv[1]).href;

export function run(main) {
  main().catch((e) => {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  });
}
