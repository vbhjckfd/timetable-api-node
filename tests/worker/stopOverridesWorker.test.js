import { describe, it, expect, beforeEach, vi } from "vitest";
import worker, {
  OVERRIDES_KEY,
  normalizeOverride,
  verifyAccessJwt,
} from "../../worker/stop-overrides/src/index.js";

const TEAM_DOMAIN = "example.cloudflareaccess.com";
const AUD = "aud-tag";
const KID = "test-kid";

function makeKv(initial = null) {
  let value = initial === null ? null : JSON.stringify(initial);
  return {
    get: vi.fn(async (key, type) => {
      if (key !== OVERRIDES_KEY || value === null) return null;
      return type === "json" ? JSON.parse(value) : value;
    }),
    put: vi.fn(async (key, next) => {
      value = next;
    }),
    stored: () => (value === null ? null : JSON.parse(value)),
  };
}

const base64Url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const encodeJson = (value) =>
  base64Url(new TextEncoder().encode(JSON.stringify(value)));

let keyPair;
let jwks;

beforeEach(async () => {
  keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );

  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  jwks = { keys: [{ ...jwk, kid: KID, alg: "RS256" }] };
});

async function makeToken(overrides = {}, signingKey) {
  const header = encodeJson({ alg: "RS256", kid: KID, ...overrides.header });
  const payload = encodeJson({
    aud: AUD,
    iss: `https://${TEAM_DOMAIN}`,
    exp: 4102444800, // 2100-01-01
    email: "editor@example.com",
    ...overrides.payload,
  });

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    signingKey ?? keyPair.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );

  return `${header}.${payload}.${base64Url(signature)}`;
}

const env = (kv) => ({
  STOP_OVERRIDES: kv,
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  ACCESS_AUD: AUD,
});

const deps = () => ({
  fetch: vi.fn(async () => new Response(JSON.stringify(jwks), { status: 200 })),
});

const put = (code, body, token) =>
  new Request(`https://api.lad.lviv.ua/stop-overrides/admin/${code}`, {
    method: "PUT",
    headers: token
      ? { "Cf-Access-Jwt-Assertion": token, "Content-Type": "application/json" }
      : { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("normalizeOverride", () => {
  it("keeps only usable route names", () => {
    expect(normalizeOverride({ add: ["Т03", "a b"], remove: ["А57"] })).toEqual({
      add: ["Т03"],
      remove: ["А57"],
    });
  });

  it("lets remove win over add", () => {
    expect(normalizeOverride({ add: ["Т03"], remove: ["Т03"] }).add).toEqual([]);
  });
});

describe("GET /stop-overrides", () => {
  it("returns an empty map when nothing is stored", async () => {
    const kv = makeKv(null);
    const response = await worker.fetch(
      new Request("https://api.lad.lviv.ua/stop-overrides"),
      env(kv),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({});
  });

  it("returns the stored map", async () => {
    const kv = makeKv({ 62: { add: ["Т03"], remove: [] } });
    const response = await worker.fetch(
      new Request("https://api.lad.lviv.ua/stop-overrides"),
      env(kv),
    );

    await expect(response.json()).resolves.toEqual({ 62: { add: ["Т03"], remove: [] } });
  });

  // The listing it feeds is cached for 30 days; this is what makes an edit
  // show up straight away.
  it("is never cached", async () => {
    const response = await worker.fetch(
      new Request("https://api.lad.lviv.ua/stop-overrides"),
      env(makeKv(null)),
    );

    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects a write to the public path", async () => {
    const response = await worker.fetch(
      new Request("https://api.lad.lviv.ua/stop-overrides", { method: "PUT" }),
      env(makeKv(null)),
    );

    expect(response.status).toBe(405);
  });
});

describe("PUT /stop-overrides/admin/:code", () => {
  it("stores an entry for a valid token", async () => {
    const kv = makeKv(null);
    const token = await makeToken();

    const response = await worker.fetch(
      put(62, { add: ["Т03"], remove: ["А57"] }, token),
      env(kv),
      {},
      deps(),
    );

    expect(response.status).toBe(200);
    expect(kv.stored()).toEqual({ 62: { add: ["Т03"], remove: ["А57"] } });
  });

  it("drops names that are not route names before storing", async () => {
    const kv = makeKv(null);
    const token = await makeToken();

    await worker.fetch(
      put(62, { add: ["Т03", "../etc/passwd"], remove: [] }, token),
      env(kv),
      {},
      deps(),
    );

    expect(kv.stored()).toEqual({ 62: { add: ["Т03"], remove: [] } });
  });

  it("leaves other stops alone", async () => {
    const kv = makeKv({ 80: { add: ["Т02"], remove: [] } });
    const token = await makeToken();

    await worker.fetch(put(62, { add: ["Т03"], remove: [] }, token), env(kv), {}, deps());

    expect(kv.stored()).toEqual({
      80: { add: ["Т02"], remove: [] },
      62: { add: ["Т03"], remove: [] },
    });
  });

  it("deletes the entry when both lists come back empty", async () => {
    const kv = makeKv({ 62: { add: ["Т03"], remove: [] }, 80: { add: [], remove: ["А01"] } });
    const token = await makeToken();

    await worker.fetch(put(62, { add: [], remove: [] }, token), env(kv), {}, deps());

    expect(kv.stored()).toEqual({ 80: { add: [], remove: ["А01"] } });
  });

  it("rejects a stop code that is not a number", async () => {
    const token = await makeToken();
    const response = await worker.fetch(
      put("..%2Fadmin", { add: [], remove: [] }, token),
      env(makeKv(null)),
      {},
      deps(),
    );

    expect(response.status).toBe(400);
  });

  it("rejects a body that is not JSON", async () => {
    const token = await makeToken();
    const response = await worker.fetch(
      put(62, "not json", token),
      env(makeKv(null)),
      {},
      deps(),
    );

    expect(response.status).toBe(400);
  });

  it("rejects GET", async () => {
    const response = await worker.fetch(
      new Request("https://api.lad.lviv.ua/stop-overrides/admin/62"),
      env(makeKv(null)),
      {},
      deps(),
    );

    expect(response.status).toBe(405);
  });

  it("returns 404 for an unknown path", async () => {
    const response = await worker.fetch(
      new Request("https://api.lad.lviv.ua/whatever"),
      env(makeKv(null)),
    );

    expect(response.status).toBe(404);
  });
});

// Access sits in front of this path, but the Worker is reachable by anything
// that can route to it, so it verifies rather than trusts.
describe("Access enforcement", () => {
  it("refuses a request with no token", async () => {
    const kv = makeKv(null);
    const response = await worker.fetch(
      put(62, { add: ["Т03"], remove: [] }),
      env(kv),
      {},
      deps(),
    );

    expect(response.status).toBe(403);
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("refuses a token signed by another key", async () => {
    const attacker = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const token = await makeToken({}, attacker.privateKey);
    const kv = makeKv(null);

    const response = await worker.fetch(
      put(62, { add: ["Т03"], remove: [] }, token),
      env(kv),
      {},
      deps(),
    );

    expect(response.status).toBe(403);
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("refuses a token for another Access application", async () => {
    const token = await makeToken({ payload: { aud: "someone-else" } });
    const response = await worker.fetch(
      put(62, { add: ["Т03"], remove: [] }, token),
      env(makeKv(null)),
      {},
      deps(),
    );

    expect(response.status).toBe(403);
  });

  it("refuses a token from another team domain", async () => {
    const token = await makeToken({ payload: { iss: "https://evil.cloudflareaccess.com" } });
    const response = await worker.fetch(
      put(62, { add: ["Т03"], remove: [] }, token),
      env(makeKv(null)),
      {},
      deps(),
    );

    expect(response.status).toBe(403);
  });

  it("refuses an expired token", async () => {
    const token = await makeToken({ payload: { exp: 1 } });
    const response = await worker.fetch(
      put(62, { add: ["Т03"], remove: [] }, token),
      env(makeKv(null)),
      {},
      deps(),
    );

    expect(response.status).toBe(403);
  });

  // "alg": "none" is the classic way to hand a verifier a token it will
  // happily believe.
  it("refuses a token that asks for an algorithm we do not verify", async () => {
    const token = await makeToken({ header: { alg: "none" } });
    const response = await worker.fetch(
      put(62, { add: ["Т03"], remove: [] }, token),
      env(makeKv(null)),
      {},
      deps(),
    );

    expect(response.status).toBe(403);
  });

  it("refuses when no published key matches the token's kid", async () => {
    const token = await makeToken({ header: { kid: "other-kid" } });
    const response = await worker.fetch(
      put(62, { add: ["Т03"], remove: [] }, token),
      env(makeKv(null)),
      {},
      deps(),
    );

    expect(response.status).toBe(403);
  });

  it("accepts a valid token", async () => {
    const token = await makeToken();
    const payload = await verifyAccessJwt(token, {
      ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
      ACCESS_AUD: AUD,
    }, deps());

    expect(payload.email).toBe("editor@example.com");
  });
});
