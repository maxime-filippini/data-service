import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { exportJWK, generateKeyPair } from "jose";

const [envFile = ".dev.vars"] = process.argv.slice(2);
const env = parseEnv(readFileSync(envFile, "utf8"));
const r2 = {
  R2_ENDPOINT_URL: env.R2_ENDPOINT_URL,
  R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
};
const endpoint = new URL(r2.R2_ENDPOINT_URL ?? "");
if (
  endpoint.protocol !== "https:" ||
  !endpoint.hostname.endsWith(".r2.cloudflarestorage.com") ||
  !r2.R2_ACCESS_KEY_ID ||
  !r2.R2_SECRET_ACCESS_KEY
)
  throw new Error("Provide S3 credentials scoped to the two dev R2 buckets");

const directory = mkdtempSync(join(tmpdir(), "data-service-workflow-smoke."));
const suffix = randomBytes(4).toString("hex");
const resource = `data-service-workflow-smoke-${suffix}`;
const fixtureSymbolPrefix = `SMOKE-${suffix.toUpperCase()}`;
const { publicKey, privateKey } = await generateKeyPair("RS256", {
  extractable: true,
});
const secrets = {
  ...r2,
  MANAGEMENT_API_TOKEN: randomBytes(32).toString("hex"),
  SMOKE_ACCESS_JWK: JSON.stringify(await exportJWK(publicKey)),
  ACCESS_TEAM_DOMAIN: "smoke.invalid",
  ACCESS_AUD: `${resource}-app`,
  DASHBOARD_ALLOWED_EMAILS: "workflow-smoke@smoke.invalid",
};
writeFileSync(join(directory, "secrets.json"), JSON.stringify(secrets), {
  mode: 0o600,
});
writeFileSync(
  join(directory, "access-private.jwk.json"),
  JSON.stringify(await exportJWK(privateKey)),
  { mode: 0o600 },
);
writeFileSync(
  join(directory, "resources.json"),
  JSON.stringify({ resource, fixtureSymbolPrefix }),
  { mode: 0o600 },
);
console.log(JSON.stringify({ directory, resource, fixtureSymbolPrefix }));
