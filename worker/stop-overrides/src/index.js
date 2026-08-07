/**
 * Per-stop route override store.
 *
 * GET  /stop-overrides            → the whole map, public, never cached
 * PUT  /stop-overrides/admin/:code → replace one stop's entry, behind Access
 *
 * The whole map lives under a single KV key. The /stops listing renders ~1000
 * rows and reads this once per page load; a key per stop would be a thousand
 * reads for the same few kilobytes.
 */

export const OVERRIDES_KEY = "overrides";
export const MAX_ROUTES_PER_LIST = 40;

const ROUTE_NAME = /^[\p{L}\p{N}]{1,16}$/u;
const STOP_CODE = /^\d{1,10}$/;

const json = (body, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // The point of fetching this separately from the cached listing is that
      // an edit shows up immediately.
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });

/** Drops anything that is not a usable route name, dedupes, caps the length. */
export function normalizeOverride(entry) {
  const clean = (list) =>
    Array.from(new Set(Array.isArray(list) ? list : []))
      .filter((name) => typeof name === "string" && ROUTE_NAME.test(name))
      .slice(0, MAX_ROUTES_PER_LIST);

  const remove = clean(entry?.remove);
  const add = clean(entry?.add).filter((name) => !remove.includes(name));

  return { add, remove };
}

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function base64UrlToJson(value) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)));
}

/**
 * Verifies a Cloudflare Access JWT against the team's public keys.
 *
 * Access sits in front of this route, so an unverified request should not
 * arrive — but the Worker is reachable by anything that can route to it, and
 * "the proxy checked it" is only true while the route config says so.
 */
export async function verifyAccessJwt(token, env, deps = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  if (typeof token !== "string") throw new Error("missing Access token");

  const [rawHeader, rawPayload, rawSignature] = token.split(".");
  if (!rawHeader || !rawPayload || !rawSignature) {
    throw new Error("malformed Access token");
  }

  const header = base64UrlToJson(rawHeader);
  if (header.alg !== "RS256") throw new Error(`unexpected alg ${header.alg}`);

  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  const certs = await fetchImpl(`${issuer}/cdn-cgi/access/certs`);
  if (!certs.ok) throw new Error("could not read Access certs");

  const { keys } = await certs.json();
  const jwk = (keys ?? []).find((key) => key.kid === header.kid);
  if (!jwk) throw new Error("no Access key for kid");

  const key = await crypto.subtle.importKey(
    "jwk",
    { ...jwk, alg: "RS256", key_ops: ["verify"], ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );

  const signed = new TextEncoder().encode(`${rawHeader}.${rawPayload}`);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlToBytes(rawSignature),
    signed,
  );
  if (!valid) throw new Error("bad Access signature");

  const payload = base64UrlToJson(rawPayload);
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];

  if (!audiences.includes(env.ACCESS_AUD)) throw new Error("wrong Access aud");
  if (payload.iss !== issuer) throw new Error("wrong Access iss");
  if (!payload.exp || payload.exp <= now()) throw new Error("expired Access token");

  return payload;
}

async function readOverrides(env) {
  return (await env.STOP_OVERRIDES.get(OVERRIDES_KEY, "json")) ?? {};
}

export default {
  async fetch(request, env, ctx, deps = {}) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/stop-overrides") {
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
      return json(await readOverrides(env));
    }

    const admin = path.match(/^\/stop-overrides\/admin\/([^/]+)$/);
    if (admin) {
      if (request.method !== "PUT") return json({ error: "Method not allowed" }, 405);

      const code = decodeURIComponent(admin[1]);
      if (!STOP_CODE.test(code)) return json({ error: "Bad stop code" }, 400);

      try {
        await verifyAccessJwt(
          request.headers.get("Cf-Access-Jwt-Assertion"),
          env,
          deps,
        );
      } catch (error) {
        return json({ error: "Forbidden", detail: error.message }, 403);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Bad JSON" }, 400);
      }

      const entry = normalizeOverride(body);
      const overrides = await readOverrides(env);

      // An empty entry is a deletion, so a stop returned to its upstream route
      // list stops taking up room in the map.
      if (entry.add.length === 0 && entry.remove.length === 0) {
        delete overrides[code];
      } else {
        overrides[code] = entry;
      }

      await env.STOP_OVERRIDES.put(OVERRIDES_KEY, JSON.stringify(overrides));

      return json({ code, override: overrides[code] ?? null });
    }

    return json({ error: "Not found" }, 404);
  },
};
