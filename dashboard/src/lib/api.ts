import type {
  DashboardUser,
  RunPage,
  RunStatus,
  SymbolStatusView,
} from "../../../src/market-data/status/views";

export type {
  DashboardUser,
  IngestionRunView,
  JobStatus,
  ProcessingJobView,
  RunPage,
  RunStatus,
  SymbolStatusView,
} from "../../../src/market-data/status/views";

export class ApiError extends Error {}

const get = async <T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
  const url = `${import.meta.env.BASE_URL}api${path}${query.size > 0 ? `?${query}` : ""}`;

  // An expired Access session answers with a redirect to the login page,
  // which fetch can't follow across origins. Reload so the browser does.
  const response = await fetch(url, { redirect: "manual", headers: { Accept: "application/json" } });
  if (response.type === "opaqueredirect" || response.status === 401) {
    window.location.reload();
    throw new ApiError("Your session expired. Reloading…");
  }

  const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
  if (!response.ok) throw new ApiError(body?.error ?? `Request failed (${response.status})`);
  return body as T;
};

export const fetchMe = () => get<DashboardUser>("/me");

export const fetchRuns = (filter: { symbol?: string; status?: RunStatus; cursor?: string }) =>
  get<RunPage>("/runs", filter);

export const fetchSymbols = (filter: { enabled?: "true" | "false" }) =>
  get<{ symbols: SymbolStatusView[] }>("/symbols", filter);
