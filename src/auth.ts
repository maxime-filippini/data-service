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
export interface AccessSettings {
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

export type AccessVariables = { accessEmail: string };

/** The outcome of checking a request's Cloudflare Access token. */
export type AccessCheck =
  | { readonly email: string }
  | { readonly status: 401 | 403 | 503; readonly error: string };

/**
 * Check that a request comes from a signed-in Cloudflare Access user whose
 * email is allowlisted.
 *
 * Access sits in front of the app and adds a signed JWT to each request.
 * Checking it here keeps the app closed if the Access app is removed or its
 * policy is loosened. Any missing setting denies every request.
 */
export const checkAccess = async (
  request: Request,
  settings: AccessSettings,
  keysFor: AccessKeys = remoteAccessKeys,
): Promise<AccessCheck> => {
  if (settings.DASHBOARD_LOCAL_BYPASS === "true" && LOCAL_HOSTNAMES.has(new URL(request.url).hostname)) {
    return { email: "local@localhost" };
  }

  const teamDomain = originOf(settings.ACCESS_TEAM_DOMAIN);
  const audience = settings.ACCESS_AUD;
  const allowed = (settings.DASHBOARD_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email !== "");
  if (!teamDomain || !audience || allowed.length === 0) {
    return { status: 503, error: "Dashboard access is not configured" };
  }

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return { status: 401, error: "Sign in through Cloudflare Access" };

  let email: unknown;
  try {
    const { payload } = await jwtVerify(token, keysFor(teamDomain), {
      issuer: teamDomain,
      audience,
      algorithms: ["RS256"],
    });
    email = payload.email;
  } catch {
    return { status: 401, error: "Invalid Access token" };
  }

  // Service tokens have no email, so they never pass.
  if (typeof email !== "string" || !allowed.includes(email.toLowerCase())) {
    return { status: 403, error: "Forbidden" };
  }
  return { email };
};

/** Hono middleware for `checkAccess`: sets `accessEmail`, or answers with the denial. */
export const requireAccessUser =
  (keysFor: AccessKeys = remoteAccessKeys): MiddlewareHandler<{
    Bindings: CloudflareBindings;
    Variables: AccessVariables;
  }> =>
  async (c, next) => {
    const result = await checkAccess(c.req.raw, c.env as AccessSettings, keysFor);
    if ("error" in result) {
      throw new HTTPException(result.status, {
        res: Response.json({ error: result.error }, { status: result.status }),
      });
    }
    c.set("accessEmail", result.email);
    await next();
  };
