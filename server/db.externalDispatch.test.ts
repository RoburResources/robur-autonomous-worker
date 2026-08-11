import { describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import {
  beginClaimedExternalDispatch,
  persistClaimedExternalProviderReceipt,
} from "./db";

const fingerprint = "a".repeat(64);
const approvalRequestId = "11111111-1111-4111-8111-111111111111";
const dispatchId = "22222222-2222-4222-8222-222222222222";

function updateHarness(affectedRows: number) {
  const where = vi.fn().mockResolvedValue([{ affectedRows }]);
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  return { database: { update }, update, set, where };
}

function renderSql(value: unknown) {
  return new MySqlDialect().sqlToQuery(
    value as Parameters<MySqlDialect["sqlToQuery"]>[0]
  );
}

describe("claimed external provider dispatch fencing", () => {
  it("returns one marker only when the conditional dispatch update owns the row", async () => {
    const harness = updateHarness(1);

    const marker = await beginClaimedExternalDispatch(
      42,
      "execution-token",
      fingerprint,
      approvalRequestId,
      "twilio",
      harness.database as never
    );

    expect(marker).toMatchObject({
      dispatchId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      ),
      provider: "twilio",
      startedAt: expect.any(String),
    });
    expect(harness.update).toHaveBeenCalledTimes(1);
    expect(harness.set).toHaveBeenCalledTimes(1);
    expect(harness.where).toHaveBeenCalledTimes(1);

    const markerWrite = renderSql(
      (harness.set.mock.calls[0][0] as { metadata: unknown }).metadata
    );
    const dispatchFence = renderSql(harness.where.mock.calls[0][0]);
    expect(markerWrite.sql.toLowerCase()).toContain("json_set(coalesce(");
    expect(markerWrite.sql).toContain("$.external_dispatch_id");
    expect(markerWrite.params).toEqual(
      expect.arrayContaining(["twilio", fingerprint, approvalRequestId])
    );
    expect(dispatchFence.sql).toContain("$.execution_claim_token");
    expect(dispatchFence.sql).toContain("$.external_approval_fingerprint");
    expect(dispatchFence.sql).toContain("$.external_approval_request_id");
    expect(dispatchFence.sql).toContain("$.external_dispatch_id");
    expect(dispatchFence.sql).toContain("$.external_provider_receipt");
    expect(dispatchFence.sql).toContain(
      "$.external_outcome_reconciliation_required"
    );
    expect(dispatchFence.params).toEqual(
      expect.arrayContaining([
        42,
        "in_progress",
        "execution-token",
        fingerprint,
        approvalRequestId,
      ])
    );
  });

  it("returns null when the atomic dispatch fence affects no row", async () => {
    const harness = updateHarness(0);

    await expect(
      beginClaimedExternalDispatch(
        42,
        "execution-token",
        fingerprint,
        approvalRequestId,
        "sendgrid",
        harness.database as never
      )
    ).resolves.toBeNull();
  });

  it("rejects malformed approval inputs before touching the database", async () => {
    const harness = updateHarness(1);

    await expect(
      beginClaimedExternalDispatch(
        42,
        "execution-token",
        "not-a-fingerprint",
        approvalRequestId,
        "retell",
        harness.database as never
      )
    ).resolves.toBeNull();
    expect(harness.update).not.toHaveBeenCalled();
  });

  it("persists a provider receipt only under the active dispatch fence", async () => {
    const harness = updateHarness(1);
    const receipt = {
      provider: "twilio" as const,
      receiptId: `SM${"a".repeat(32)}`,
      acceptedAt: "2026-07-30T00:00:00.000Z",
      artifactFingerprint: fingerprint,
      approvalRequestId,
    };

    await expect(
      persistClaimedExternalProviderReceipt(
        42,
        "execution-token",
        dispatchId,
        receipt,
        harness.database as never
      )
    ).resolves.toBe(true);
    expect(harness.update).toHaveBeenCalledTimes(1);
    expect(harness.set).toHaveBeenCalledTimes(1);
    expect(harness.where).toHaveBeenCalledTimes(1);

    const receiptWrite = renderSql(
      (harness.set.mock.calls[0][0] as { metadata: unknown }).metadata
    );
    const receiptFence = renderSql(harness.where.mock.calls[0][0]);
    expect(receiptWrite.sql.toLowerCase()).toContain("json_set(coalesce(");
    expect(receiptWrite.sql.toLowerCase()).not.toContain("json_remove");
    expect(receiptWrite.sql).toContain("$.external_provider_receipt");
    expect(receiptWrite.params).toContain(JSON.stringify(receipt));
    expect(receiptFence.sql).toContain("$.execution_claim_token");
    expect(receiptFence.sql).toContain("$.external_dispatch_id");
    expect(receiptFence.sql).toContain("$.external_dispatch_provider");
    expect(receiptFence.sql).toContain(
      "$.external_dispatch_artifact_fingerprint"
    );
    expect(receiptFence.sql).toContain(
      "$.external_dispatch_approval_request_id"
    );
    expect(receiptFence.params).toEqual(
      expect.arrayContaining([
        42,
        "in_progress",
        "execution-token",
        dispatchId,
        receipt.provider,
        fingerprint,
        approvalRequestId,
      ])
    );
  });

  it("reports a lost receipt fence without retrying or writing again", async () => {
    const harness = updateHarness(0);

    await expect(
      persistClaimedExternalProviderReceipt(
        42,
        "execution-token",
        dispatchId,
        {
          provider: "retell",
          receiptId: "call_test",
          acceptedAt: "2026-07-30T00:00:00.000Z",
          artifactFingerprint: fingerprint,
          approvalRequestId,
        },
        harness.database as never
      )
    ).resolves.toBe(false);
    expect(harness.update).toHaveBeenCalledTimes(1);
    expect(harness.where).toHaveBeenCalledTimes(1);
  });
});
