import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = fs.readFileSync(
  path.join(repoRoot, ".github/workflows/zeabur-production.yml"),
  "utf8"
);
const zeaburEnv = fs.readFileSync(path.join(repoRoot, "contrib/zeabur/.env.example"), "utf8");
const zeaburTemplate = fs.readFileSync(
  path.join(repoRoot, "contrib/zeabur/template.example.yaml"),
  "utf8"
);
const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");

test("fork production workflow publishes one immutable runner-base image", () => {
  assert.match(workflow, /branches:\s*\n\s*- production/);
  assert.match(workflow, /IMAGE_NAME: ghcr\.io\/\$\{\{ github\.repository_owner \}\}\/omniroute/);
  assert.match(workflow, /IMAGE_TAG: sha-\$\{\{ github\.sha \}\}/);
  assert.match(workflow, /target: runner-base/);
  assert.match(workflow, /platforms: linux\/amd64/);
  assert.doesNotMatch(workflow, /(?:tags|IMAGE_TAG):[^\n]*latest/);
});

test("plain source builds finish on the production-safe runner-base flavor", () => {
  const stages = [...dockerfile.matchAll(/^FROM\s+([^\s]+)(?:\s+AS\s+([^\s]+))?/gim)];
  const lastStage = stages.at(-1);

  assert.ok(lastStage);
  assert.equal(lastStage[1], "runner-base");
  assert.equal(lastStage[2], "runner-base-default");
});

test("Zeabur deploy is optional and only changes the existing service tag", () => {
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/production'/);
  assert.match(workflow, /ZEABUR_TOKEN: \$\{\{ secrets\.ZEABUR_TOKEN \}\}/);
  assert.match(workflow, /ZEABUR_SERVICE_ID: \$\{\{ secrets\.ZEABUR_SERVICE_ID \}\}/);
  assert.match(workflow, /auth login -i=false/);
  assert.match(workflow, /service update tag/);
  assert.match(workflow, /-t "\$IMAGE_TAG"/);
  assert.match(workflow, /-y\s*\\\s*\n\s*-i=false/);
  assert.match(workflow, /deployment was skipped/);
  assert.doesNotMatch(workflow, /service (?:delete|create)/);
});

test("Zeabur runtime defaults preserve data and fail closed", () => {
  assert.match(zeaburEnv, /^PORT=20128$/m);
  assert.match(zeaburEnv, /^DATA_DIR=\/app\/data$/m);
  assert.match(zeaburEnv, /^REQUIRE_API_KEY=true$/m);
  assert.match(zeaburEnv, /^AUTH_COOKIE_SECURE=true$/m);
  assert.match(zeaburEnv, /^LIVE_WS_HOST=127\.0\.0\.1$/m);
  assert.match(zeaburEnv, /^OMNIROUTE_BROWSER_POOL=off$/m);
  assert.match(zeaburEnv, /^PROXY_AUTO_SELECT_ENABLED=false$/m);
  assert.match(zeaburEnv, /^JWT_SECRET=$/m);
  assert.match(zeaburEnv, /^API_KEY_SECRET=$/m);
  assert.match(zeaburEnv, /^STORAGE_ENCRYPTION_KEY=$/m);
  assert.match(zeaburEnv, /^INITIAL_PASSWORD=$/m);
});

test("Zeabur bootstrap template declares the single-service runtime contract", () => {
  assert.match(zeaburTemplate, /template: PREBUILT_V2/);
  assert.match(
    zeaburTemplate,
    /image: ghcr\.io\/lywx215\/omniroute:sha-REPLACE_WITH_FULL_40_CHARACTER_GIT_SHA/
  );
  assert.doesNotMatch(zeaburTemplate, /image:[^\n]*\$\{IMAGE_TAG\}/);
  assert.match(zeaburTemplate, /port: 20128/);
  assert.match(zeaburTemplate, /dir: \/app\/data/);
  assert.match(zeaburTemplate, /path: \/healthz/);
  assert.match(zeaburTemplate, /REQUIRE_API_KEY:\s*\n\s*default: "true"/);
  assert.match(zeaburTemplate, /AUTH_COOKIE_SECURE:\s*\n\s*default: "true"/);
});
