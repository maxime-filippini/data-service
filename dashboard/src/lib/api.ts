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

export const apiUrl = (path: string, params: Record<string, string | undefined> = {}) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
  return `${import.meta.env.BASE_URL}api${path}${query.size > 0 ? `?${query}` : ""}`;
};

const request = async (url: string, accept: string) => {
  // An expired Access session answers with a redirect to the login page,
  // which fetch can't follow across origins. Reload so the browser does.
  const response = await fetch(url, { redirect: "manual", headers: { Accept: accept } });
  if (response.type === "opaqueredirect" || response.status === 401) {
    window.location.reload();
    throw new ApiError("Your session expired. Reloading…");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
    throw new ApiError(body?.error ?? `Request failed (${response.status})`);
  }
  return response;
};

const get = async <T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> =>
  (await (await request(apiUrl(path, params), "application/json")).json()) as T;

export const datasetUrl = (dataset: string, symbol: string) =>
  apiUrl(`/datasets/${encodeURIComponent(dataset)}/${encodeURIComponent(symbol)}`);

/** The symbol's Parquet file. The browser revalidates its cached copy by ETag. */
export const fetchDatasetFile = async (dataset: string, symbol: string) =>
  (await request(datasetUrl(dataset, symbol), "application/vnd.apache.parquet")).arrayBuffer();

export const fetchMe = () => get<DashboardUser>("/me");

export const fetchRuns = (filter: { symbol?: string; status?: RunStatus; cursor?: string }) =>
  get<RunPage>("/runs", filter);

export const fetchSymbols = (filter: { enabled?: "true" | "false" }) =>
  get<{ symbols: SymbolStatusView[] }>("/symbols", filter);
