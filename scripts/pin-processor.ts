// Pins the processor container image in wrangler.jsonc.
// Usage: pnpm processor:pin <commit sha> [--dev]
// Without --dev, both production and env.dev are pinned; with it, only env.dev.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const IMAGE_TAG = /(data-service-processor:)([0-9a-f]{40})/g;

export const pinProcessorImage = (config: string, sha: string, devOnly: boolean): string => {
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`Expected a full 40-character commit SHA, got "${sha}".`);
  }
  const envStart = config.indexOf('"env": {');
  const pins = [...config.matchAll(IMAGE_TAG)];
  if (envStart === -1 || pins.length !== 2 || pins[0].index > envStart || pins[1].index < envStart) {
    throw new Error("Expected one processor image pin before \"env\" and one inside it.");
  }
  const start = devOnly ? envStart : 0;
  return config.slice(0, start) + config.slice(start).replace(IMAGE_TAG, `$1${sha}`);
};

const here = fileURLToPath(import.meta.url);

if (here === process.argv[1]) {
  const args = process.argv.slice(2);
  const devOnly = args.includes("--dev");
  const [sha] = args.filter((arg) => arg !== "--dev");
  const path = join(dirname(here), "..", "wrangler.jsonc");
  try {
    writeFileSync(path, pinProcessorImage(readFileSync(path, "utf8"), sha ?? "", devOnly));
    console.log(`Pinned processor ${sha} for ${devOnly ? "dev" : "production and dev"}.`);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
