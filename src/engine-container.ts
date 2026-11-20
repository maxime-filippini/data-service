import { Container } from "@cloudflare/containers";

/**
 * The Python service: calculations and workflow operations (such as price
 * normalization). Only the Worker calls it, through `CALCULATION_ENGINE`. It
 * needs internet access to reach R2 through the S3 API. Calculations read and
 * write the processed bucket; operations read and write run artifacts under
 * `runs/` in the raw bucket (`ARTIFACT_BUCKET`).
 */
export class CalculationEngine extends Container<CloudflareBindings> {
  defaultPort = 8080;
  sleepAfter = "5m";
  enableInternet = true;
  envVars = {
    R2_ENDPOINT_URL: this.env.R2_ENDPOINT_URL,
    R2_ACCESS_KEY_ID: this.env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: this.env.R2_SECRET_ACCESS_KEY,
    PROCESSED_BUCKET: this.env.PROCESSED_BUCKET_NAME,
    ARTIFACT_BUCKET: this.env.RAW_BUCKET_NAME,
  };

  override async fetch(request: Request): Promise<Response> {
    // Keep the container awake while a calculation runs longer than sleepAfter.
    const heartbeat = setInterval(() => this.renewActivityTimeout(), 60_000);
    try {
      return await this.containerFetch(request);
    } finally {
      clearInterval(heartbeat);
    }
  }
}
