import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

const workflow = parse(
  fs.readFileSync(new URL("../../.github/workflows/ghcr-runner-web.yml", import.meta.url), "utf8")
);

test("fork GHCR workflow has only the authorized automatic push trigger", () => {
  assert.deepEqual(Object.keys(workflow.on), ["push"]);
  assert.deepEqual(workflow.on.push.branches, ["main", "codex/sync-upstream-20261010"]);
  assert.deepEqual(Object.keys(workflow.jobs), ["build"]);
  assert.equal(workflow.jobs.build.strategy, undefined);
  assert.equal(workflow.jobs.build.if, "github.repository == 'lywx215/OmniRoute'");
});

test("new upstream workflows cannot auto-trigger before API registration and disabling", () => {
  for (const file of [
    "claude.yml",
    "mutation-redundancy.yml",
    "nightly-compat.yml",
    "nightly-mutation.yml",
    "nightly-property.yml",
    "opencode-provider-ci.yml",
    "test-quarantine.yml",
  ]) {
    const disabled = parse(
      fs.readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), "utf8")
    );
    assert.deepEqual(Object.keys(disabled.on), ["workflow_dispatch"], file);
  }
});

test("exactly one linux/amd64 runner-web image is validated before GHCR publication", () => {
  const steps = workflow.jobs.build.steps;
  const builds = steps.filter((step: { uses?: string }) =>
    step.uses?.startsWith("docker/build-push-action@")
  );
  assert.equal(builds.length, 1);
  assert.equal(builds[0].with.target, "runner-web");
  assert.equal(builds[0].with.platforms, "linux/amd64");
  assert.equal(builds[0].with.load, true);
  assert.equal(builds[0].with.push, false);
  const verification = steps.findIndex((step: { run?: string }) =>
    step.run?.includes("verify-runner-web-image.mjs")
  );
  const publication = steps.findIndex((step: { run?: string }) =>
    step.run?.includes("docker push")
  );
  assert.ok(verification >= 0 && publication > verification);
  assert.equal(steps[verification].run, 'node scripts/ci/verify-runner-web-image.mjs "$IMAGE_REF"');
  const verifier = fs.readFileSync(
    new URL("../../scripts/ci/verify-runner-web-image.mjs", import.meta.url),
    "utf8"
  );
  assert.match(verifier, /const imageRef = process\.argv\[2\]/);
  assert.ok(!verifier.includes("process.env.IMAGE_REF"));
  assert.match(workflow.jobs.build.env.IMAGE_REF, /^ghcr\.io\/lywx215\/omniroute:/);
  assert.equal(workflow.jobs.build.permissions.packages, "write");
  assert.ok(!JSON.stringify(workflow).includes("ZEABUR_TOKEN"));
});
