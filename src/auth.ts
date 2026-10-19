import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";

type CloudflareSubtleCrypto = SubtleCrypto & {
  timingSafeEqual?: (a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView) => boolean;
};

const subtle = crypto.subtle as CloudflareSubtleCrypto;

/** Compare two tokens without disclosing where they differ. */
const tokensMatch = async (provided: string, expected: string) => {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    subtle.digest("SHA-256", encoder.encode(provided)),
    subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  if (typeof subtle.timingSafeEqual === "function") return subtle.timingSafeEqual(a, b);

  // Node (used by the tests) lacks Cloudflare's timingSafeEqual. Both inputs
  // are fixed-size digests, so this loop has no early exit.
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
};

/** Require `Authorization: Bearer <MANAGEMENT_API_TOKEN>`. */
export const requireManagementToken: MiddlewareHandler<{ Bindings: CloudflareBindings }> = async (c, next) => {
  const expected = c.env.MANAGEMENT_API_TOKEN;
  const [scheme, token, ...rest] = c.req.header("Authorization")?.split(" ") ?? [];
  const provided = scheme === "Bearer" && rest.length === 0 ? token : undefined;

  if (!expected || !provided || !(await tokensMatch(provided, expected))) {
    throw new HTTPException(401, {
      res: Response.json({ error: "Unauthorized" }, { status: 401 }),
    });
  }
  await next();
};

/** Settings for the dashboard's Cloudflare Access check. */
interface AccessSettings {
  /** `https://<team>.cloudflareaccess.com` */
  readonly ACCESS_TEAM_DOMAIN?: string;
  /** The Access application's audience (AUD) tag. */
  readonly ACCESS_AUD?: string;
  /** Comma-separated emails allowed in, even if the Access policy is wider. */
  readonly DASHBOARD_ALLOWED_EMAILS?: string;
  /** "true" skips the check, but only for requests to localhost (wrangler dev). */
  readonly DASHBOARD_LOCAL_BYPASS?: string;
}

export type AccessKeys = (teamDomain: string) => JWTVerifyGetKey;

// One key set per team domain, so jose's key cache survives between requests.
const remoteKeySets = new Map<string, JWTVerifyGetKey>();

/** Access's public signing keys, fetched and cached by jose. */
export const remoteAccessKeys: AccessKeys = (teamDomain) => {
  let keys = remoteKeySets.get(teamDomain);
  if (keys === undefined) {
    keys = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", teamDomain));
    remoteKeySets.set(teamDomain, keys);
  }
  return keys;
};

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** `https://team.cloudflareaccess.com/` and `team.cloudflareaccess.com` both become the issuer form. */
const originOf = (domain: string | undefined) => {
  if (!domain) return undefined;
  try {
    return new URL(domain.includes("://") ? domain : `https://${domain}`).origin;
  } catch {
    return undefined;
  }
};

const deny = (status: 401 | 403 | 503, error: string) =>
  new HTTPException(status, { res: Response.json({ error }, { status }) });

export type AccessVariables = { accessEmail: string };

/**
 * Require a signed-in user from Cloudflare Access whose email is allowlisted.
 *
 * Access sits in front of the dashboard and adds a signed JWT to each request.
 * Checking it here keeps the dashboard closed if the Access app is removed or
 * its policy is loosened. Any missing setting denies every request.
 */
export const requireAccessUser =
  (keysFor: AccessKeys = remoteAccessKeys): MiddlewareHandler<{
    Bindings: CloudflareBindings;
    Variables: AccessVariables;
  }> =>
  async (c, next) => {
    const settings = c.env as AccessSettings;

    if (settings.DASHBOARD_LOCAL_BYPASS === "true" && LOCAL_HOSTNAMES.has(new URL(c.req.url).hostname)) {
      c.set("accessEmail", "local@localhost");
      return next();
    }

    const teamDomain = originOf(settings.ACCESS_TEAM_DOMAIN);
    const audience = settings.ACCESS_AUD;
    const allowed = (settings.DASHBOARD_ALLOWED_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email !== "");
    if (!teamDomain || !audience || allowed.length === 0) {
      throw deny(503, "Dashboard access is not configured");
    }

    const token = c.req.header("Cf-Access-Jwt-Assertion");
    if (!token) throw deny(401, "Sign in through Cloudflare Access");

    let email: unknown;
    try {
      const { payload } = await jwtVerify(token, keysFor(teamDomain), {
        issuer: teamDomain,
        audience,
        algorithms: ["RS256"],
      });
      email = payload.email;
    } catch {
      throw deny(401, "Invalid Access token");
    }

    // Service tokens have no email, so they never pass.
    if (typeof email !== "string" || !allowed.includes(email.toLowerCase())) {
      throw deny(403, "Forbidden");
    }
    c.set("accessEmail", email);
    await next();
  };
