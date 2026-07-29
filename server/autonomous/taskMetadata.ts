function isMetadataRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * MySQL JSON columns can legitimately contain a JSON string when an older
 * writer stringifies an object before insertion. Normalise that legacy shape
 * at read boundaries so object spreads do not turn the string into numbered
 * character keys.
 */
export function normalizeTaskMetadata(value: unknown): Record<string, unknown> {
  if (isMetadataRecord(value)) {
    return { ...value };
  }

  if (typeof value !== "string") {
    return {};
  }

  try {
    const parsed = JSON.parse(value);
    return isMetadataRecord(parsed) ? { ...parsed } : {};
  } catch {
    return {};
  }
}
