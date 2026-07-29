import { describe, expect, it } from "vitest";

import { normalizeTaskMetadata } from "./taskMetadata";

describe("task metadata normalization", () => {
  it("copies an existing metadata object", () => {
    const source = { roiScore: 8, dag_dependencies: [12] };
    const normalized = normalizeTaskMetadata(source);

    expect(normalized).toEqual(source);
    expect(normalized).not.toBe(source);
  });

  it("recovers an object stored as a JSON string", () => {
    expect(
      normalizeTaskMetadata(
        JSON.stringify({
          roiScore: 6,
          requiresExternalContact: false,
          dag_dependencies: [],
        })
      )
    ).toEqual({
      roiScore: 6,
      requiresExternalContact: false,
      dag_dependencies: [],
    });
  });

  it("repairs metadata already polluted by spreading a stored JSON string", () => {
    const encoded = JSON.stringify({
      roiScore: 6,
      requiresExternalContact: false,
      dag_dependencies: [],
    });
    const polluted = {
      ...Object.fromEntries(
        Array.from(encoded, (character, index) => [String(index), character])
      ),
      output_schema_valid: false,
    };

    const normalized = normalizeTaskMetadata(polluted);

    expect(normalized).toEqual({
      roiScore: 6,
      requiresExternalContact: false,
      dag_dependencies: [],
      output_schema_valid: false,
    });
    expect(Object.keys(normalized).some(key => /^\d+$/.test(key))).toBe(false);
  });

  it("preserves numeric fields that are not a recoverable spread JSON object", () => {
    const source = { "0": "x", "2": "z", category: "legacy" };

    expect(normalizeTaskMetadata(source)).toEqual(source);
  });

  it.each([
    null,
    undefined,
    42,
    ["not", "metadata"],
    "not-json",
    JSON.stringify(["not", "an", "object"]),
  ])("fails closed for an unsupported value", value => {
    expect(normalizeTaskMetadata(value)).toEqual({});
  });
});
