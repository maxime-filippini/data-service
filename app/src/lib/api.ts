import type { DashboardUser } from "../../../src/pages/views";
import type {
  HoldingView,
  Portfolio,
  PortfolioSummary,
  Snapshot,
} from "../../../src/portfolios/views";
import type { SubjectView } from "../../../src/workflows/views";

export type { Asset } from "../../../src/assets/views";

export type { PublicationView } from "../../../src/datasets/views";

export type { DashboardUser } from "../../../src/pages/views";

export type {
  HoldingView,
  Portfolio,
  PortfolioSummary,
  Snapshot,
} from "../../../src/portfolios/views";

export type {
  StepOutcome,
  StepOutcomeStatus,
  WorkflowRunDetail,
  WorkflowRunStatus,
  WorkflowRunSummary,
} from "../../../src/workflows/runs/views";

export type {
  InputSource,
  InspectedStep,
  SubjectView,
  WorkflowAssignment,
  WorkflowDefault,
  WorkflowInspection,
  WorkflowSummary,
} from "../../../src/workflows/views";

/**
 * Subset of Worker JSON error responses used to build a readable form error.
 */
type ErrorBody = {
  error?: string;
  issues?: { message: string; path?: string[] }[];
};

/**
 * Browser submission of a complete holdings set effective on one date. Used
 * by portfolio creation and add-snapshot actions; weights are already numeric
 * here, while editable `HoldingRow` values can still contain unfinished text.
 */
export type NewSnapshot = { holdingsDate: string; holdings: HoldingView[] };

/**
 * User-facing failure from an app JSON/data request. Forms display its message;
 * the request helper also reloads the page when the Access session has expired.
 */
export class ApiError extends Error {}

export const apiUrl = (
  path: string,
  params: Record<string, string | undefined> = {},
) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value) query.set(key, value);
  return `/app-api${path}${query.size > 0 ? `?${query}` : ""}`;
};

/** The server's message, with any validation issues. */
const errorMessage = (body: ErrorBody | undefined, status: number) => {
  const details = (body?.issues ?? []).map(
    (issue) =>
      (issue.path?.length ? `${issue.path.join(".")}: ` : "") + issue.message,
  );
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
    const body = (await response.json().catch(() => undefined)) as
      ErrorBody | undefined;
    throw new ApiError(errorMessage(body, response.status));
  }
  return response;
};

const send = async <T>(
  method: "POST" | "PATCH",
  path: string,
  body?: unknown,
): Promise<T> => {
  const init: RequestInit =
    body === undefined
      ? { method }
      : {
          method,
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        };
  return (await (
    await request(apiUrl(path), "application/json", init)
  ).json()) as T;
};

const remove = async (path: string) => {
  await request(apiUrl(path), "application/json", { method: "DELETE" });
};

const get = async <T>(
  path: string,
  params: Record<string, string | undefined> = {},
): Promise<T> =>
  (await (await request(apiUrl(path, params), "application/json")).json()) as T;

/** A published dataset's current data (Parquet), by dataset and subject. */
export const publicationDataUrl = (dataset: string, subject: SubjectView) =>
  apiUrl(
    `/publications/${encodeURIComponent(dataset)}/${subject.kind}/${encodeURIComponent(
      subject.kind === "asset" ? subject.symbol : subject.id,
    )}/data`,
  );

/** Fetch a published dataset's current Parquet bytes. Revalidated by ETag. */
export const fetchPublicationData = async (
  dataset: string,
  subject: SubjectView,
) =>
  (
    await request(
      publicationDataUrl(dataset, subject),
      "application/vnd.apache.parquet",
    )
  ).arrayBuffer();

export const fetchMe = () => get<DashboardUser>("/me");

const portfolioPath = (id: string) => `/portfolios/${encodeURIComponent(id)}`;

export const fetchPortfolios = () =>
  get<{ portfolios: PortfolioSummary[] }>("/portfolios");

export const fetchPortfolio = (id: string) => get<Portfolio>(portfolioPath(id));

export const createPortfolio = (input: {
  name: string;
  snapshot?: NewSnapshot;
}) => send<Portfolio>("POST", "/portfolios", input);

export const renamePortfolio = (id: string, name: string) =>
  send<Portfolio>("PATCH", portfolioPath(id), { name });

/** Fails with 409 if an active workflow run uses the portfolio. */
export const deletePortfolio = (id: string) => remove(portfolioPath(id));

export const addSnapshot = (id: string, snapshot: NewSnapshot) =>
  send<Snapshot>("POST", `${portfolioPath(id)}/snapshots`, snapshot);

export const deleteSnapshot = (id: string, holdingsDate: string) =>
  remove(`${portfolioPath(id)}/snapshots/${encodeURIComponent(holdingsDate)}`);
