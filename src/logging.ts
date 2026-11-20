import { Logger } from "effect";

const errorLogger = Logger.withConsoleError(Logger.formatJson);

const workerLogger = Logger.make((options) =>
  (options.logLevel === "Error" || options.logLevel === "Fatal"
    ? errorLogger
    : Logger.consoleJson
  ).log(options),
);

export const WorkerLoggerLive = Logger.layer([
  workerLogger,
  Logger.tracerLogger,
]);
