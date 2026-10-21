import type {
  DashboardUser,
  RunPage,
  RunStatus,
  SymbolStatusView,
} from "../../../src/market-data/status/views";

import type { ScheduleRun, ScheduleView } from "../../../src/market-data/schedule/views";
import type {
  Calculation,
  CalculationParams,
  CalculationRun,
  CalculationTypeInfo,
} from "../../../src/calculations/views";
import type { HoldingView, Portfolio, PortfolioSummary, Snapshot } from "../../../src/portfolios/views";

export type {
  Calculation,
  CalculationParams,
  CalculationRun,
  CalculationRunStatus,
  CalculationTypeInfo,
  PortfolioOutcome,
} from "../../../src/calculations/views";
export type { HoldingView, Portfolio, PortfolioSummary, Snapshot } from "../../../src/portfolios/views";

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
  /** The engine's detail: for invalid params, Pydantic's errors. */
  detail?: unknown;
};

type EngineIssue = { loc?: (string | number)[]; msg?: string };

/** Pydantic's errors as "window: Input should be greater than or equal to 2". */
const engineIssues = (detail: unknown) =>
  Array.isArray(detail)
    ? (detail as EngineIssue[])
        .filter((issue) => typeof issue?.msg === "string")
        .map((issue) => (issue.loc?.length ? `${issue.loc.join(".")}: ` : "") + issue.msg)
    : [];

/** The server's message, with any validation issues or rejected entries. */
const errorMessage = (body: ErrorBody | undefined, status: number) => {
  const details = [
    ...(body?.issues ?? []).map((issue) => (issue.path?.length ? `${issue.path.join(".")}: ` : "") + issue.message),
    ...(body?.rejected ?? []).map((entry) => `${entry.symbol}: ${entry.reason}`),
    ...engineIssues(body?.detail),
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

const remove = async (path: string) => {
  await request(apiUrl(path), "application/json", { method: "DELETE" });
};

const get = async <T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> =>
  (await (await request(apiUrl(path, params), "application/json")).json()) as T;

export const datasetUrl = (dataset: string, symbol: string) =>
  apiUrl(`/datasets/${encodeURIComponent(dataset)}/${encodeURIComponent(symbol)}`);

/** The symbol's Parquet file. The browser revalidates its cached copy by ETag. */
export const fetchDatasetFile = async (dataset: string, symbol: string) =>
  (await request(datasetUrl(dataset, symbol), "application/vnd.apache.parquet")).arrayBuffer();

export const calculationResultsUrl = (id: string) => apiUrl(`/calculations/${encodeURIComponent(id)}/results`);

/** A calculation's results file, `calculation=<id>/data.parquet`. Revalidated by ETag. */
export const fetchCalculationResults = async (id: string) =>
  (await request(calculationResultsUrl(id), "application/vnd.apache.parquet")).arrayBuffer();

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

const portfolioPath = (id: string) => `/portfolios/${encodeURIComponent(id)}`;

export const fetchPortfolios = () => get<{ portfolios: PortfolioSummary[] }>("/portfolios");

export const fetchPortfolio = (id: string) => get<Portfolio>(portfolioPath(id));

export type NewSnapshot = { holdingsDate: string; holdings: HoldingView[] };

export const createPortfolio = (input: { name: string; snapshot?: NewSnapshot }) =>
  send<Portfolio>("POST", "/portfolios", input);

export const renamePortfolio = (id: string, name: string) => send<Portfolio>("PATCH", portfolioPath(id), { name });

/** Fails with the calculations using it if any do. */
export const deletePortfolio = (id: string) => remove(portfolioPath(id));

export const addSnapshot = (id: string, snapshot: NewSnapshot) =>
  send<Snapshot>("POST", `${portfolioPath(id)}/snapshots`, snapshot);

export const deleteSnapshot = (id: string, holdingsDate: string) =>
  remove(`${portfolioPath(id)}/snapshots/${encodeURIComponent(holdingsDate)}`);

const calculationPath = (id: string) => `/calculations/${encodeURIComponent(id)}`;

export const fetchCalculationTypes = () => get<{ types: CalculationTypeInfo[] }>("/calculation-types");

export const fetchCalculations = () => get<{ calculations: Calculation[] }>("/calculations");

export const fetchCalculation = (id: string) => get<Calculation>(calculationPath(id));

export type CalculationInput = {
  name: string;
  type: string;
  params: CalculationParams;
  portfolioIds: string[];
  cron: string;
  enabled: boolean;
};

/** The engine checks the params; the saved calculation has defaults filled in. */
export const createCalculation = (input: CalculationInput) => send<Calculation>("POST", "/calculations", input);

/** Omitted fields are kept. The type can't change. */
export const updateCalculation = (id: string, patch: Partial<Omit<CalculationInput, "type">>) =>
  send<Calculation>("PATCH", calculationPath(id), patch);

/** Deletes the calculation and its runs. Its results stay in R2. */
export const deleteCalculation = (id: string) => remove(calculationPath(id));

export const fetchCalculationRuns = (id: string, limit = 20) =>
  get<{ runs: CalculationRun[] }>(`${calculationPath(id)}/runs`, { limit: String(limit) });

/** Run now, as of `asOf` (default: the previous UTC day). `skipped` if a run is already going. */
export const startCalculationRun = (id: string, asOf?: string) =>
  send<{ runId: string; status: "running" | "skipped" }>(
    "POST",
    `${calculationPath(id)}/runs`,
    asOf ? { asOf } : {},
  );
