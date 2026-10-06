import type { Env, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";

import {
  bearerTokenFromAuthorization,
  bearerTokensMatch,
} from "$/auth/bearer-token";

type ExpectedToken<Bindings> = (bindings: Bindings) => string | undefined;

const unauthorized = () =>
  new HTTPException(401, {
    res: Response.json({ error: "Unauthorized" }, { status: 401 }),
  });

/**
 * Require a Bearer token selected from a route group's bindings.
 *
 * Callers choose the binding accessor, so distinct route groups can use
 * independent secrets without duplicating parsing or comparison behavior.
 */
export const requireBearerToken = <E extends Env>(
  expectedToken: ExpectedToken<E["Bindings"]>,
): MiddlewareHandler<E> =>
  async (c, next) => {
    const expected = expectedToken(c.env);
    const provided = bearerTokenFromAuthorization(c.req.header("Authorization"));

    if (
      expected === undefined ||
      provided === undefined ||
      !(await bearerTokensMatch(provided, expected))
    ) {
      throw unauthorized();
    }

    await next();
  };
