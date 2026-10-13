import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "./index";

let sqlite: DatabaseSync;
let env: Env;
beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  const migrations = new NodeURL("../migrations/", import.meta.url);
  for (const file of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(new NodeURL(file, migrations), "utf8"));
  }
  sqlite.exec(`INSERT INTO scan_sessions (id, source_type, started_at) VALUES ('session', 'image', '2026-10-13T10:00:00Z');
    INSERT INTO items (id, scan_session_id, fingerprint, name, category, description, condition, confidence, value_summary, thumbnail_key, raw_json, first_seen_at, last_seen_at)
    VALUES ('chair', 'session', 'chair', 'Chair', 'Furniture', 'Visible chair', 'Used', 0.9, '', 'frames/chair.jpg', '{}', '2026-10-13T10:00:00Z', '2026-10-13T10:00:00Z');
    INSERT INTO frame_runs (id, scan_session_id, thumbnail_key, captured_at, latency_ms, item_count, model_calls, searches_performed, model, status)
    VALUES ('older', 'session', 'frames/chair.jpg', '2026-10-13T10:00:00Z', 10000, 1, 1, 1, 'gpt-6-luna', 'completed'),
      ('latest', 'session', 'frames/chair.jpg', '2026-10-13T11:00:00Z', 76685, 1, 2, 4, 'gpt-6-luna', 'completed'),
      ('unrelated', 'session', 'frames/another.jpg', '2026-10-13T12:00:00Z', 99999, 1, 2, 4, 'gpt-6-luna', 'completed');`);
  const db = { prepare: (sql: string) => ({ bind: (...params: unknown[]) => ({
    raw: async () => { const statement = sqlite.prepare(sql); statement.setReturnArrays(true); return statement.all(...params as string[]); },
  }) }) };
  env = { DB: db } as unknown as Env;
});
afterEach(() => sqlite.close());

describe("run duration summaries", () => {
  it("returns only the latest matching frame's timing, even for older records without an audit", async () => {
    const response = await worker.fetch(new Request("https://example.com/api/agent-runs/by-item/chair?summary=true"), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ frameId: "latest", latencyMs: 76685, model: "gpt-6-luna", status: "completed", error: null });
  });

  it("preserves full activity retrieval when the lightweight summary is not requested", async () => {
    sqlite.exec("UPDATE frame_runs SET instructions = 'Saved instructions', events_json = '[]', output_json = '{}' WHERE id = 'latest'");
    const response = await worker.fetch(new Request("https://example.com/api/agent-runs/by-item/chair"), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ frameId: "latest", latencyMs: 76685, instructions: "Saved instructions", events: [], output: {} });
  });
});
