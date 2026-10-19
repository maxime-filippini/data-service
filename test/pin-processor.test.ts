import assert from "node:assert/strict";
import test from "node:test";

import { pinProcessorImage } from "../scripts/pin-processor";

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const config = `{
  "containers": [{ "image": "registry.cloudflare.com/acct/data-service-processor:${OLD}" }],
  "env": {
    "dev": { "containers": [{ "image": "registry.cloudflare.com/acct/data-service-processor:${OLD}" }] },
  },
}`;

test("pinProcessorImage", async (t) => {
  await t.test("pins production and dev", () => {
    const pinned = pinProcessorImage(config, NEW, false);
    assert.equal(pinned, config.replaceAll(OLD, NEW));
  });

  await t.test("pins only dev with devOnly", () => {
    const pinned = pinProcessorImage(config, NEW, true);
    const [before, after] = pinned.split('"env": {');
    assert.ok(before.includes(OLD) && !before.includes(NEW));
    assert.ok(after.includes(NEW) && !after.includes(OLD));
  });

  await t.test("rejects short or missing SHAs", () => {
    assert.throws(() => pinProcessorImage(config, "f11cfbc", false), /40-character/);
    assert.throws(() => pinProcessorImage(config, "", false), /40-character/);
  });

  await t.test("rejects a config without both pins", () => {
    const prodOnly = config.split('"env": {')[0];
    assert.throws(() => pinProcessorImage(prodOnly, NEW, false), /one processor image pin/);
  });
});
