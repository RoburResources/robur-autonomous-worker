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
