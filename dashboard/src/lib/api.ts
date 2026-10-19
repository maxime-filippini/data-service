import type {
  DashboardUser,
  RunPage,
  RunStatus,
  SymbolStatusView,
} from "../../../src/market-data/status/views";

import type { ScheduleRun, ScheduleView } from "../../../src/market-data/schedule/views";

export type { ScheduleRun, ScheduleRunStatus, ScheduleView } from "../../../src/market-data/schedule/views";
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

type ErrorBody = {
  error?: string;
  issues?: { message: string; path?: string[] }[];
  rejected?: { symbol: string; reason: string }[];
};

/** The server's message, with any validation issues or rejected entries. */
const errorMessage = (body: ErrorBody | undefined, status: number) => {
  const details = [
    ...(body?.issues ?? []).map((issue) => (issue.path?.length ? `${issue.path.join(".")}: ` : "") + issue.message),
    ...(body?.rejected ?? []).map((entry) => `${entry.symbol}: ${entry.reason}`),
  ];
  const message = body?.error ?? `Request failed (${status})`;
  return details.length > 0 ? `${message}: ${details.join("; ")}` : message;
};

const request = async (url: string, accept: string, init: RequestInit = {}) => {
  // An expired Access session answers with a redirect to the login page,
  // which fetch can't follow across origins. Reload so the browser does.
  const response = await fetch(url, {
    ...init,
    redirect: "manual",
    headers: { Accept: accept, ...init.headers },
  });
  if (response.type === "opaqueredirect" || response.status === 401) {
    window.location.reload();
    throw new ApiError("Your session expired. Reloading…");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as ErrorBody | undefined;
    throw new ApiError(errorMessage(body, response.status));
  }
  return response;
};

const send = async <T>(method: "POST" | "PATCH", path: string, body?: unknown): Promise<T> => {
  const init: RequestInit =
    body === undefined
      ? { method }
      : { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } };
  return (await (await request(apiUrl(path), "application/json", init)).json()) as T;
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

export type DatasetProviders = Record<string, readonly string[]>;

export const fetchOptions = () => get<{ datasetProviders: DatasetProviders }>("/options");

export type RegisterInput = {
  dataset: string;
  symbol: string;
  provider: string;
  backfillStartDate: string;
  enabled: boolean;
};

/** Add a symbol, or update one with the same dataset and symbol. */
export const registerSymbol = (input: RegisterInput) => send<{ enabled: boolean }>("POST", "/registry", input);

const identity = (dataset: string, symbol: string) =>
  `/registry/${encodeURIComponent(dataset)}/${encodeURIComponent(symbol)}`;

export const setOnSchedule = (dataset: string, symbol: string, enabled: boolean) =>
  send<{ enabled: boolean }>("POST", `${identity(dataset, symbol)}/${enabled ? "enable" : "disable"}`);

/** Queue a full-history download for each entry now. */
export const requestDownloads = (entries: { dataset: string; symbol: string }[]) =>
  send<{ queued: unknown[] }>("POST", "/ingestions", { entries });

export const fetchSchedule = () => get<ScheduleView>("/schedule");

export const updateSchedule = (patch: { hourUtc?: number; paused?: boolean }) =>
  send<ScheduleView>("PATCH", "/schedule", patch);

export const fetchScheduleRuns = (limit = 10) =>
  get<{ runs: ScheduleRun[] }>("/schedule/runs", { limit: String(limit) });

/** Queue a download for every symbol on the schedule now. */
export const runScheduleNow = () => send<{ runId: string }>("POST", "/schedule/runs");
