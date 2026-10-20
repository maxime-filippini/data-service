import { EngineLive } from "$/calculations/engine";

export interface EngineCall {
  readonly method: string;
  readonly path: string;
  readonly accept: string | null;
  readonly body: unknown;
}

export const exAnteVol = {
  name: "ex_ante_vol",
  description: "Ex-ante volatility.",
  takesPortfolio: true,
  paramsSchema: { type: "object", properties: { window: { type: "integer", default: 252 } } },
  output: { value: "Float64" },
};

/**
 * A stand-in for the engine container. Records each call and answers with
 * `respond`, which defaults to a type list and a one-row JSON result.
 */
export const makeFakeEngine = (respond?: (call: EngineCall) => Response | Promise<Response>) => {
  const calls: EngineCall[] = [];
  const fetcher = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const text = await request.text();
      const call = {
        method: request.method,
        path: new URL(request.url).pathname,
        accept: request.headers.get("Accept"),
        body: text === "" ? undefined : JSON.parse(text),
      };
      calls.push(call);
      if (respond !== undefined) return respond(call);
      if (call.path === "/types") return Response.json([exAnteVol]);
      return Response.json({ rows: [{ as_of: "2026-10-16", portfolio_id: null, value: 0.2 }] });
    },
  } as Pick<Fetcher, "fetch">;
  return { calls, layer: EngineLive(fetcher) };
};
