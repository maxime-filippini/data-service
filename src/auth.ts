import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";

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
