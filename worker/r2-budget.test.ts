import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RESERVE_R2_SQL, R2_LIFETIME_BYTES, R2_READS_PER_DAY, R2_UPLOADS_PER_DAY } from "./r2-budget";

let db: DatabaseSync;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new NodeURL("../migrations/0004_r2_budget.sql", import.meta.url), "utf8"));
});
afterEach(() => db.close());
function reserve(day: string, upload: number, read: number, bytes = 0) {
  return db.prepare(RESERVE_R2_SQL).get(day, upload, read, bytes,
    R2_UPLOADS_PER_DAY, R2_READS_PER_DAY, R2_LIFETIME_BYTES);
}
describe("R2 persistent reservations", () => {
  it("rejects the first upload beyond the daily allowance without incrementing bytes", () => {
    for (let i = 0; i < R2_UPLOADS_PER_DAY; i++) expect(reserve("2026-10-07", 1, 0, 5)).toBeDefined();
    expect(reserve("2026-10-07", 1, 0, 5)).toBeUndefined();
    expect(db.prepare("SELECT reserved_bytes FROM r2_budget").get()?.reserved_bytes).toBe(1000);
  });
  it("resets daily counters while retaining the lifetime storage reservation", () => {
    expect(reserve("2026-10-07", 1, 0, R2_LIFETIME_BYTES)).toBeDefined();
    expect(reserve("2026-10-08", 1, 0, 1)).toBeUndefined();
    expect(reserve("2026-10-08", 0, 1)).toBeDefined();
    const row = db.prepare("SELECT * FROM r2_budget").get();
    expect(row?.uploads).toBe(0);
    expect(row?.reads).toBe(1);
    expect(row?.reserved_bytes).toBe(R2_LIFETIME_BYTES);
  });
  it("rejects reads at their boundary and permits uploads independently", () => {
    db.prepare("UPDATE r2_budget SET day = ?, reads = ?").run("2026-10-07", R2_READS_PER_DAY);
    expect(reserve("2026-10-07", 0, 1)).toBeUndefined();
    expect(reserve("2026-10-07", 1, 0, 10)).toBeDefined();
    expect(reserve("2026-10-08", 0, 1)).toBeDefined();
  });
  it("fails closed if the budget record is missing", () => {
    db.exec("DELETE FROM r2_budget");
    expect(reserve("2026-10-07", 1, 0, 10)).toBeUndefined();
  });
});
