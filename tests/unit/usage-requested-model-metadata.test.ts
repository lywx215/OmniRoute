import test from "node:test";
import assert from "node:assert/strict";
import {
  clearPendingRequests,
  finalizePendingRequestById,
  getCompletedDetails,
  getPendingById,
  trackPendingRequest,
  updatePendingRequestById,
} from "../../src/lib/usage/usageHistory.ts";
import { storeCompletedDetail } from "../../src/lib/usage/completedRequestDetails.ts";
import { buildCallLogListRows, rowMatchesFilter } from "../../src/app/api/usage/call-logs/route.ts";

test.beforeEach(() => clearPendingRequests());
test.afterEach(() => clearPendingRequests());

const REQUESTED_MODEL = "gemini-2.5-pro";
const BACKEND_MODEL = "gemini-flash-lite-latest";

test("original model survives pending updates and completed-detail storage", () => {
  const id = trackPendingRequest(BACKEND_MODEL, "gemini", "conn-gemini", true, {
    requestedModel: REQUESTED_MODEL,
    correlationId: "original-model-request",
  });
  assert.ok(id);
  assert.equal(getPendingById().get(id)?.requestedModel, REQUESTED_MODEL);
  assert.equal(getPendingById().get(id)?.model, BACKEND_MODEL);

  assert.equal(updatePendingRequestById(id, { stage: "streaming" }), true);
  assert.equal(getPendingById().get(id)?.requestedModel, REQUESTED_MODEL);

  assert.equal(
    finalizePendingRequestById(id, {
      status: 200,
      providerResponse: { modelVersion: "gemini-flash-lite-latest" },
      clientResponse: { model: REQUESTED_MODEL },
    }),
    true
  );
  assert.equal(getPendingById().has(id), false);
  const completed = getCompletedDetails().get(id);
  assert.ok(completed);
  assert.equal(completed.requestedModel, REQUESTED_MODEL);
  assert.equal(completed.model, BACKEND_MODEL);

  // Artifact enrichment re-saves the entire detail after adding payload previews.
  const enriched = { ...completed, providerResponse: { enriched: true } };
  assert.equal(storeCompletedDetail(enriched), true);
  enriched.requestedModel = "mutated-after-storage";
  assert.equal(getCompletedDetails().get(id)?.requestedModel, REQUESTED_MODEL);
});

test("completion can add an original model missing from start metadata", () => {
  const id = trackPendingRequest(BACKEND_MODEL, "gemini", "conn-gemini", true);
  assert.ok(id);
  assert.equal(
    finalizePendingRequestById(id, {
      requestedModel: REQUESTED_MODEL,
      status: 200,
      providerResponse: {},
      clientResponse: {},
    }),
    true
  );
  assert.equal(getCompletedDetails().get(id)?.requestedModel, REQUESTED_MODEL);
});

test("pending original-model metadata accepts names and rejects invalid values", () => {
  for (const requestedModel of [null, "", "  ", 42, {}]) {
    const id = trackPendingRequest(BACKEND_MODEL, "gemini", "conn-gemini", true, {
      requestedModel,
    } as never);
    assert.ok(id);
    assert.equal(getPendingById().get(id)?.requestedModel, null);
    trackPendingRequest(BACKEND_MODEL, "gemini", "conn-gemini", false);
  }
});

test("pending and completed list rows retain the original model for display and filtering", () => {
  const now = 100_000;
  const rows = buildCallLogListRows({
    logs: [],
    connections: [],
    pendingDetails: [
      {
        id: "pending-original",
        model: BACKEND_MODEL,
        requestedModel: REQUESTED_MODEL,
        provider: "gemini",
        connectionId: "conn-gemini",
        startedAt: now - 100,
      },
    ],
    completedDetails: [
      {
        id: "completed-original",
        model: BACKEND_MODEL,
        requestedModel: REQUESTED_MODEL,
        provider: "gemini",
        connectionId: "conn-gemini",
        startedAt: now - 200,
        completedAt: now - 150,
      },
    ],
    now,
  });
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.model, BACKEND_MODEL);
    assert.equal(row.requestedModel, REQUESTED_MODEL);
    assert.equal(rowMatchesFilter(row, { model: REQUESTED_MODEL }), true);
    assert.equal(rowMatchesFilter(row, { search: REQUESTED_MODEL }), true);
    assert.equal(rowMatchesFilter(row, { model: BACKEND_MODEL }), true);
  }
});

test("legacy pending and completed rows do not invent an original model", () => {
  const base = {
    model: BACKEND_MODEL,
    provider: "gemini",
    connectionId: "conn-gemini",
    startedAt: 100,
  };
  const rows = buildCallLogListRows({
    logs: [],
    connections: [],
    pendingDetails: [{ ...base, id: "pending-legacy" }],
    completedDetails: [{ ...base, id: "completed-legacy", completedAt: 200 }],
    now: 300,
  });
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.requestedModel, null);
    assert.equal(rowMatchesFilter(row, { model: REQUESTED_MODEL }), false);
  }
});
