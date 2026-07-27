import { DrizzleQueryError } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { isMysqlDuplicateKeyError } from "./db";

describe("database safety helpers", () => {
  it("recognizes a duplicate key wrapped by Drizzle", () => {
    const mysqlDuplicate = Object.assign(new Error("Duplicate entry"), {
      code: "ER_DUP_ENTRY",
      errno: 1062,
    });
    const wrapped = new DrizzleQueryError(
      "insert into system_config",
      [],
      mysqlDuplicate
    );

    expect(isMysqlDuplicateKeyError(wrapped)).toBe(true);
  });

  it("does not suppress unrelated database failures", () => {
    const mysqlFailure = Object.assign(new Error("Connection lost"), {
      code: "PROTOCOL_CONNECTION_LOST",
    });
    const wrapped = new DrizzleQueryError(
      "insert into system_config",
      [],
      mysqlFailure
    );

    expect(isMysqlDuplicateKeyError(wrapped)).toBe(false);
  });
});
