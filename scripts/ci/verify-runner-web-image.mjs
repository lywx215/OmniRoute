import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

// This is a CI tool argument, not an OmniRoute runtime environment setting.
const imageRef = process.argv[2];
const revision = process.env.GITHUB_SHA;
assert.match(imageRef || "", /^ghcr\.io\/lywx215\/omniroute:sha-[a-f0-9]{40}-web$/);
assert.match(revision || "", /^[a-f0-9]{40}$/);

function docker(args, options = {}) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 120_000,
    ...options,
  }).trim();
}

const image = JSON.parse(docker(["image", "inspect", imageRef]))[0];
assert.equal(image.Os, "linux");
assert.equal(image.Architecture, "amd64");
assert.equal(image.Config.Labels["org.opencontainers.image.revision"], revision);

const containerName = `omniroute-image-smoke-${randomBytes(8).toString("hex")}`;
const smokeEnv = {
  ...process.env,
  JWT_SECRET: randomBytes(48).toString("hex"),
  API_KEY_SECRET: randomBytes(32).toString("hex"),
  INITIAL_PASSWORD: randomBytes(24).toString("hex"),
};

try {
  docker(
    [
      "run",
      "--detach",
      "--name",
      containerName,
      "--publish",
      "127.0.0.1::20128",
      "--tmpfs",
      "/app/data:uid=1000,gid=1000,mode=0700",
      "--env",
      "JWT_SECRET",
      "--env",
      "API_KEY_SECRET",
      "--env",
      "INITIAL_PASSWORD",
      imageRef,
    ],
    { env: smokeEnv }
  );
  const port = docker(["port", containerName, "20128/tcp"]).split(":").at(-1);
  assert.match(port, /^\d+$/);
  let healthy = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    const state = JSON.parse(docker(["inspect", containerName]))[0].State;
    assert.equal(state.Running, true, "standalone server exited before becoming healthy");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) {
        healthy = true;
        break;
      }
    } catch {
      // The server can still be starting; all retries are bounded.
    }
    await delay(2000);
  }
  assert.equal(healthy, true, "standalone /healthz did not become ready");
  docker(["exec", containerName, "node", "healthcheck.mjs"]);
  docker([
    "exec",
    containerName,
    "node",
    "--input-type=module",
    "-e",
    `
      import assert from "node:assert/strict";
      import fs from "node:fs";
      import path from "node:path";
      import { createRequire } from "node:module";
      const require = createRequire("/app/package.json");
      const db = require("better-sqlite3") (":memory:");
      assert.equal(db.prepare("SELECT 1 AS ok").get().ok, 1);
      db.close();
      const playwrightEntry = require.resolve("playwright");
      assert.ok(playwrightEntry.startsWith("/app/node_modules/"));
      const coreRequire = createRequire(playwrightEntry);
      const coreEntry = coreRequire.resolve("playwright-core");
      assert.ok(coreEntry.startsWith("/app/node_modules/"));
      assert.ok(fs.existsSync(path.join(path.dirname(coreEntry), "browsers.json")));
      const { chromium } = require("playwright");
      assert.ok(fs.existsSync(chromium.executablePath()));
      const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
      try {
        const page = await browser.newPage();
        await page.setContent("<title>image-smoke-ok</title>");
        assert.equal(await page.title(), "image-smoke-ok");
      } finally {
        await browser.close();
      }
    `,
  ]);
  console.log("PASS: linux/amd64, revision, standalone boot, health, SQLite and Chromium");
} finally {
  // Remove only this invocation's uniquely named, disposable smoke container.
  docker(["rm", "--force", containerName]);
}
