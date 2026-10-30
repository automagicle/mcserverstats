// Verifies the JWT that Cloudflare Access attaches to every request it lets through.
// Fails closed: if Access isn't configured yet, nobody gets data.

let keyCache = null;
let keyCacheAt = 0;

function b64urlBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function b64urlJson(s) {
  return JSON.parse(new TextDecoder().decode(b64urlBytes(s)));
}

async function loadKeys(teamDomain, force) {
  if (keyCache && !force && Date.now() - keyCacheAt < 3600_000) return keyCache;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs fetch failed: ${res.status}`);
  const { keys } = await res.json();
  const map = new Map();
  for (const jwk of keys) {
    const key = await crypto.subtle.importKey(
      'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
    );
    map.set(jwk.kid, key);
  }
  keyCache = map;
  keyCacheAt = Date.now();
  return map;
}

export async function isAuthorized(request, env, url) {
  // Local development only: .dev.vars is never uploaded by `wrangler deploy`.
  if (env.DEV_NO_AUTH === '1' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
    return true;
  }

  const team = env.ACCESS_TEAM_DOMAIN;
  const aud = env.ACCESS_AUD;
  if (!team || !aud) return false;

  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return false;

  try {
    const [h, p, s] = token.split('.');
    const header = b64urlJson(h);
    const payload = b64urlJson(p);
    if (header.alg !== 'RS256') return false;

    let keys = await loadKeys(team, false);
    if (!keys.has(header.kid)) keys = await loadKeys(team, true);
    const key = keys.get(header.kid);
    if (!key) return false;

    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5', key, b64urlBytes(s), new TextEncoder().encode(`${h}.${p}`)
    );
    if (!valid) return false;

    const now = Math.floor(Date.now() / 1000);
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!(auds.includes(aud) && payload.iss === `https://${team}` && payload.exp > now)) return false;
    // A service token (the chat mod's way past Access) may only post chat, not read the dashboard.
    return !(payload.common_name && !payload.email);
  } catch (err) {
    console.error('Access token check failed:', err.message);
    return false;
  }
}
