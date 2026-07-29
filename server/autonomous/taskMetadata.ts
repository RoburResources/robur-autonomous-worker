function isMetadataRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recoverSpreadJsonRecord(
  value: Record<string, unknown>
): Record<string, unknown> | null {
  const numericKeys = Object.keys(value)
    .filter(key => /^(0|[1-9]\d*)$/.test(key))
    .sort((left, right) => Number(left) - Number(right));
  if (numericKeys.length === 0) {
    return null;
  }

  const encodedCharacters: string[] = [];
  for (let index = 0; index < numericKeys.length; index++) {
    if (numericKeys[index] !== String(index)) {
      return null;
    }
    const character = value[String(index)];
    if (typeof character !== "string" || character.length !== 1) {
      return null;
    }
    encodedCharacters.push(character);
  }

  try {
    const recovered = JSON.parse(encodedCharacters.join(""));
    if (!isMetadataRecord(recovered)) {
      return null;
    }
    const currentFields = Object.fromEntries(
      Object.entries(value).filter(([key]) => !/^(0|[1-9]\d*)$/.test(key))
    );
    return { ...recovered, ...currentFields };
  } catch {
    return null;
  }
}

/**
 * MySQL JSON columns can legitimately contain a JSON string when an older
 * writer stringifies an object before insertion. Normalise that legacy shape
 * at read boundaries so object spreads do not turn the string into numbered
 * character keys. Already-spread historical values are repaired only when
 * their contiguous character keys decode to a plain JSON object.
 */
export function normalizeTaskMetadata(value: unknown): Record<string, unknown> {
  if (isMetadataRecord(value)) {
    return recoverSpreadJsonRecord(value) ?? { ...value };
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
