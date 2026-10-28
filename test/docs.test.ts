import assert from "node:assert/strict";
import test from "node:test";

import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet } from "jose";
import { Hono } from "hono";

import { createDocsRoutes } from "$/routes/docs";

const TEAM = "https://team.cloudflareaccess.com";
const AUD = "dashboard-aud";
const ME = "me@example.com";

const { publicKey, privateKey } = await generateKeyPair("RS256");
const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "key-1", alg: "RS256" }] });

const signToken = (email: string) =>
  new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid: "key-1" })
    .setIssuer(TEAM)
    .setAudience(AUD)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

const env = {
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD: AUD,
  DASHBOARD_ALLOWED_EMAILS: ME,
  ASSETS: { fetch: async (request: Request) => new Response(`asset ${new URL(request.url).pathname}`) },
};

// Mounted as in src/index.ts.
const app = new Hono().route("/docs", createDocsRoutes(() => keys));

const request = (path: string, token?: string) =>
  app.request(path, token === undefined ? {} : { headers: { "Cf-Access-Jwt-Assertion": token } }, env);

test("an allowlisted Access user can read the docs", async () => {
  const token = await signToken(ME);
  for (const path of ["/docs", "/docs/", "/docs/architecture/", "/docs/_astro/page.js"]) {
    const response = await request(path, token);
    assert.equal(response.status, 200, path);
    assert.equal(await response.text(), `asset ${path}`);
  }
});

test("the docs are closed without an allowlisted Access user", async () => {
  for (const path of ["/docs", "/docs/", "/docs/architecture/"]) {
    assert.equal((await request(path)).status, 401, path);
    assert.equal((await request(path, await signToken("stranger@example.com"))).status, 403, path);
  }
});
