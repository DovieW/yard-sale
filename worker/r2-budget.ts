// Persistent reservations happen before R2 calls. Failed uploads and deleted
// images still consume the lifetime allowance, so retries cannot evade the cap.
export const R2_UPLOADS_PER_DAY = 200;
export const R2_READS_PER_DAY = 10_000;
export const R2_LIFETIME_BYTES = 1_000_000_000;

export class R2BudgetError extends Error {}

export const RESERVE_R2_SQL = `UPDATE r2_budget SET
  day = ?1,
  uploads = CASE WHEN day = ?1 THEN uploads ELSE 0 END + ?2,
  reads = CASE WHEN day = ?1 THEN reads ELSE 0 END + ?3,
  reserved_bytes = reserved_bytes + ?4
WHERE id = 1
  AND (CASE WHEN day = ?1 THEN uploads ELSE 0 END) + ?2 <= ?5
  AND (CASE WHEN day = ?1 THEN reads ELSE 0 END) + ?3 <= ?6
  AND reserved_bytes + ?4 <= ?7
RETURNING id`;

export async function reserveR2(db: D1Database, operation: "upload" | "read", bytes = 0): Promise<void> {
  const reserved = await db.prepare(RESERVE_R2_SQL).bind(
    new Date().toISOString().slice(0, 10),
    operation === "upload" ? 1 : 0,
    operation === "read" ? 1 : 0,
    bytes,
    R2_UPLOADS_PER_DAY,
    R2_READS_PER_DAY,
    R2_LIFETIME_BYTES,
  ).first();
  if (!reserved) {
    throw new R2BudgetError(operation === "upload"
      ? "Image upload limit reached (200 per UTC day or 1 GB lifetime). Scanning is paused."
      : "Image read limit reached (10,000 per UTC day). Try again tomorrow.");
  }
}
