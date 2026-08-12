import { randomUUID } from "node:crypto";
import type { InspectEvent, InspectEventStore, InspectEventType } from "./types.js";
import { openSqliteDatabase } from "../system/sqlite.js";

/**
 * SQLite-persisted inspect event store (2026-08-08).
 *
 * The previous in-memory ring buffer lost every event on service restart and,
 * more importantly, MCP stdio processes (where all memory writes happen) never
 * shared it with the HTTP service process — so the console event log was
 * almost always empty. This store writes events into the shared memory
 * database (WAL allows cross-process concurrency), so both MCP writes and the
 * service console observe the same durable audit trail.
 *
 * All failures are swallowed: event logging must never break the primary
 * memory operations.
 */
export class SqliteInspectEventStore implements InspectEventStore {
  constructor(private readonly storagePath: string) {}

  private withDb<T>(fn: (db: ReturnType<typeof openSqliteDatabase>) => T): T | undefined {
    try {
      using db = openSqliteDatabase(this.storagePath);
      db.exec(
        `CREATE TABLE IF NOT EXISTS inspect_events (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          context TEXT NOT NULL DEFAULT '{}',
          data TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_inspect_events_ts ON inspect_events(timestamp DESC);`,
      );
      return fn(db);
    } catch {
      return undefined;
    }
  }

  emit(event: Omit<InspectEvent, "id" | "timestamp">): InspectEvent {
    const full: InspectEvent = {
      ...event,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
    };
    this.withDb((db) => {
      db.prepare(`INSERT OR REPLACE INTO inspect_events (id, type, timestamp, context, data)
                  VALUES (?, ?, ?, ?, ?)`)
        .run(
          full.id,
          full.type,
          full.timestamp,
          JSON.stringify(full.context ?? {}),
          JSON.stringify(full.data ?? {}),
        );
      // Bounded trail: keep the newest 2000 rows.
      db.exec(`DELETE FROM inspect_events WHERE id NOT IN (
        SELECT id FROM inspect_events ORDER BY timestamp DESC LIMIT 2000);`);
    });
    return full;
  }

  recent(options?: { limit?: number; offset?: number; type?: InspectEventType }): { events: InspectEvent[]; total: number } {
    const type = options?.type;
    const limit = Math.max(1, Math.min(options?.limit ?? 200, 500));
    const offset = Math.max(0, options?.offset ?? 0);
    const rows =
      this.withDb((db) => {
        const total = (
          type
            ? db.prepare("SELECT COUNT(*) AS c FROM inspect_events WHERE type = ?").get(type)
            : db.prepare("SELECT COUNT(*) AS c FROM inspect_events").get()
        ) as { c?: number } | undefined;
        const page = (
          type
            ? db
                .prepare(
                  `SELECT id, type, timestamp, context, data FROM inspect_events
                   WHERE type = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
                )
                .all(type, limit, offset)
            : db
                .prepare(
                  `SELECT id, type, timestamp, context, data FROM inspect_events
                   ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
                )
                .all(limit, offset)
        ) as Array<Record<string, unknown>>;
        return { total: Number(total?.c ?? 0), page };
      }) ?? { total: 0, page: [] };
    return {
      total: rows.total,
      events: rows.page.map((r) => ({
        id: String(r.id),
        type: String(r.type) as InspectEventType,
        timestamp: String(r.timestamp),
        context: safeParse(r.context),
        data: safeParse(r.data),
      })),
    };
  }

  clear(): void {
    this.withDb((db) => db.exec(`DELETE FROM inspect_events`));
  }
}

function safeParse(raw: unknown): any {
  try {
    return JSON.parse(String(raw));
  } catch {
    return {};
  }
}
