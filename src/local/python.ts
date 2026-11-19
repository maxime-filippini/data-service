import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath, URL } from "node:url";

/** The Python service's package (the engine), run with uv. */
const ENGINE_DIRECTORY = fileURLToPath(
  new URL("../../containers/engine/", import.meta.url),
);

/** Whether `uv` can be run here. */
export const uvAvailable = () => {
  try {
    execFileSync("uv", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null
          ? resolve(address.port)
          : reject(new Error("No port")),
      );
    });
  });

/** A running local Python service. */
export interface LocalPythonService {
  /** Base URL, e.g. `http://127.0.0.1:53211`. */
  readonly url: string;
  readonly process: ChildProcess;
  /** Everything the process printed, for diagnosing a failed start. */
  readonly output: () => string;
  readonly stop: () => Promise<void>;
}

/**
 * Start the real Python service (the engine's FastAPI app) with uv on a
 * free localhost port, reading and writing run artifacts as files under
 * `artifactRoot`: the same directory the TypeScript side's local artifact
 * adapter uses. Resolves once `/health` answers.
 */
export const startPythonService = async (options: {
  readonly artifactRoot: string;
  readonly timeoutMs?: number;
}): Promise<LocalPythonService> => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(
    "uv",
    [
      "run",
      "--directory",
      ENGINE_DIRECTORY,
      "uvicorn",
      "data_service_engine.app:app",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--log-level",
      "warning",
    ],
    {
      // ARTIFACT_ROOT takes precedence over any R2 settings in a .env.
      env: { ...process.env, ARTIFACT_ROOT: options.artifactRoot },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += String(chunk)));
  child.stderr.on("data", (chunk) => (output += String(chunk)));
  let exited = false;
  child.once("exit", () => (exited = true));

  const stop = () =>
    new Promise<void>((resolve) => {
      if (exited) return resolve();
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
    });

  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  while (Date.now() < deadline) {
    if (exited)
      throw new Error(`The Python service exited during startup:\n${output}`);
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok)
        return { url, process: child, output: () => output, stop };
    } catch {
      // Not listening yet.
    }
    await new Promise((wake) => setTimeout(wake, 200));
  }
  await stop();
  throw new Error(`The Python service did not start in time:\n${output}`);
};
