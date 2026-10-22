/**
 * vector-cache.ts — 文档向量的 SQLite 持久缓存（B0.6，2026-10-22）
 *
 * 为什么需要：
 *   retrieval.searchBuiltin 原本对每次 recall 的 top-N 候选**全量重算远程 embedding**
 *   （实测单次 9.8s）。B0.5 加了进程内 Map 缓存后稳态降到 1.6s，但**重启即清空**、
 *   且随库增长（E3 后 8.2k 条）缓存命中率下降、首次查询反复回落到 4–6s。
 *   把缓存落盘后：进程重启不丢、E3 扩容不退化。
 *
 * 为什么不改现有表：
 *   `memory_items` 一行不动（expand-and-contract 纪律），新建独立表 `memory_vectors`，
 *   读不到时静默降级回内存缓存 ⇒ 旧库/旧二进制都可正常工作。
 *
 * 失效判据：`updatedAt + modelId`。updatedAt 由 update() 无条件刷新；modelId 变化
 * （换 embedding 模型/维度）自动全量失配，避免混用不同向量空间。
 */
import { openSqliteDatabase } from "../system/sqlite.js";

export type CachedVector = { updatedAt: string; modelId: string; vector: number[] };

export class SqliteVectorCache {
  private ready = false;

  constructor(private readonly filePath: string) {}

  private ensure(): void {
    if (this.ready) return;
    const db = openSqliteDatabase(this.filePath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_vectors (
        id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        dims INTEGER NOT NULL,
        vector BLOB NOT NULL
      )
    `);
    this.ready = true;
  }

  /** 批量取：返回命中的 id → 向量（未命中/失配不返回）。 */
  getMany(ids: string[], modelId: string): Map<string, CachedVector> {
    const out = new Map<string, CachedVector>();
    if (ids.length === 0) return out;
    try {
      this.ensure();
      const db = openSqliteDatabase(this.filePath);
      const CHUNK = 400;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const slice = ids.slice(i, i + CHUNK);
        const marks = slice.map(() => "?").join(",");
        const rows = db
          .prepare(`SELECT id, model_id, updated_at, dims, vector FROM memory_vectors WHERE id IN (${marks})`)
          .all(...slice) as Array<{
            id: string;
            model_id: string;
            updated_at: string;
            dims: number;
            vector: Uint8Array;
          }>;
        for (const row of rows) {
          if (row.model_id !== modelId) continue; // 模型变更 → 视为未命中
          const buf = Buffer.from(row.vector);
          const vector = new Array(row.dims);
          for (let k = 0; k < row.dims; k += 1) vector[k] = buf.readFloatLE(k * 4);
          out.set(row.id, { updatedAt: row.updated_at, modelId: row.model_id, vector });
        }
      }
    } catch {
      // fail-open：缓存坏了只影响性能，不能让 recall 挂掉
      return out;
    }
    return out;
  }

  /** 批量写（幂等 upsert）。 */
  putMany(entries: Array<{ id: string; updatedAt: string; modelId: string; vector: number[] }>): void {
    if (entries.length === 0) return;
    try {
      this.ensure();
      const db = openSqliteDatabase(this.filePath);
      const stmt = db.prepare(
        `INSERT INTO memory_vectors (id, model_id, updated_at, dims, vector)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           model_id = excluded.model_id,
           updated_at = excluded.updated_at,
           dims = excluded.dims,
           vector = excluded.vector`,
      );
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const entry of entries) {
          const buf = Buffer.alloc(entry.vector.length * 4);
          entry.vector.forEach((value, index) => buf.writeFloatLE(value, index * 4));
          stmt.run(entry.id, entry.modelId, entry.updatedAt, entry.vector.length, buf);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } catch {
      // 写失败只记录在调用方日志，不阻断检索
    }
  }

  count(): number {
    try {
      this.ensure();
      const db = openSqliteDatabase(this.filePath);
      return (db.prepare("SELECT COUNT(*) AS n FROM memory_vectors").get() as { n: number }).n;
    } catch {
      return -1;
    }
  }
}
