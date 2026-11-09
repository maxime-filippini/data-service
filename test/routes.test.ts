import assert from "node:assert/strict";
import test from "node:test";

import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";

import { createRoutes } from "$/routes";
import type { Services } from "$/services";

const TEAM = "https://team.cloudflareaccess.com";
const AUD = "app-aud";
const ME = "me@example.com";
const HOST = "https://data-service.example.com";

const { publicKey, privateKey } = await generateKeyPair("RS256");
const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "key-1", alg: "RS256" }] });

const signToken = (email: string = ME) =>
  new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid: "key-1" })
    .setIssuer(TEAM)
    .setAudience(AUD)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

/** What the fake SvelteKit handler was asked for. */
const appRequests: Request[] = [];

const env = {
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD: AUD,
  DASHBOARD_ALLOWED_EMAILS: ME,
  MANAGEMENT_API_TOKEN: "management-token",
  ASSETS: {
    fetch: async (request: Request) =>
      // Responses from the assets binding have immutable headers.
      new Response(`asset ${new URL(request.url).pathname}`, { headers: new Headers() }),
  },
};

// The services aren't reached by these requests.
const routes = createRoutes({} as Services, {
  fetch: async (request) => {
    appRequests.push(request);
    return new Response(`app ${new URL(request.url).pathname}`, {
      headers: { "Content-Security-Policy": "default-src 'self'; script-src 'self' 'nonce-abc'" },
    });
  },
}, () => keys);

const request = (path: string, headers: Record<string, string> = {}) =>
  routes.request(`${HOST}${path}`, { headers }, env);

const asUser = async (path: string, headers: Record<string, string> = {}) =>
  request(path, { ...headers, "Cf-Access-Jwt-Assertion": await signToken() });

test("everything but /api needs an allowlisted Access user", async () => {
  for (const path of ["/", "/runs", "/portfolios/some-id", "/_app/immutable/app.js", "/app-api/me", "/docs/"]) {
    assert.equal((await request(path)).status, 401, path);
    const stranger = await request(path, { "Cf-Access-Jwt-Assertion": await signToken("stranger@example.com") });
    assert.equal(stranger.status, 403, path);
  }
});

test("the management API uses its token, not Access", async () => {
  // Refused for the token, not for Access, and an Access user alone doesn't get in.
  const response = await asUser("/api/symbols");
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Unauthorized" });
  assert.equal((await request("/api/unknown", { Authorization: "Bearer management-token" })).status, 404);
});

test("the app gets the Access user's email, never the client's own header", async () => {
  appRequests.length = 0;
  const response = await asUser("/calculations?x=1", { "X-Access-Email": "forged@example.com" });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "app /calculations");
  assert.equal(appRequests[0]?.headers.get("X-Access-Email"), ME);
  // SvelteKit's own CSP is kept; the other security headers are added.
  assert.match(response.headers.get("Content-Security-Policy") ?? "", /nonce-abc/u);
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
});

test("the docs are served from the assets with security headers", async () => {
  const response = await asUser("/docs/architecture/");
  assert.equal(await response.text(), "asset /docs/architecture/");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
});

test("the old dashboard URLs go to the home page", async () => {
  for (const path of ["/dashboard", "/dashboard/", "/dashboard/index.html"]) {
    const response = await request(path);
    assert.equal(response.status, 302, path);
    assert.equal(response.headers.get("Location"), "/", path);
  }
});
