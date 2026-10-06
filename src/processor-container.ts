import { Container } from "@cloudflare/containers";

/** Private container entrypoint; only the queue consumer invokes execution. */
export class MarketDataProcessor extends Container<CloudflareBindings> {
  defaultPort = 8080;
  sleepAfter = "5m";
  enableInternet = true;
  envVars = {
    PROCESSING_API_URL: this.env.PROCESSING_API_URL,
    PROCESSING_API_TOKEN: this.env.PROCESSING_API_TOKEN,
    PROCESSOR_API_TOKEN: this.env.PROCESSOR_API_TOKEN,
    R2_ENDPOINT_URL: this.env.R2_ENDPOINT_URL,
    R2_ACCESS_KEY_ID: this.env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: this.env.R2_SECRET_ACCESS_KEY,
  };

  override async fetch(request: Request): Promise<Response> {
    // Keep synchronous processing alive even when it exceeds sleepAfter.
    const heartbeat = setInterval(() => this.renewActivityTimeout(), 60_000);
    try {
      return await this.containerFetch(request);
    } finally {
      clearInterval(heartbeat);
    }
  }
}
