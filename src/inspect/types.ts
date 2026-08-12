import type { MemoryContext } from "../platform/types.js";

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export type InspectEventType =
  | "memory_written"
  | "memory_updated"
  | "memory_deleted"
  | "recall_built"
  | "projection_synced";

export type InspectEvent = {
  id: string;
  type: InspectEventType;
  timestamp: string;
  context: MemoryContext;
  data?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Event store interface
// ---------------------------------------------------------------------------

export interface InspectEventStore {
  /**
   * Emit a new event. The store assigns `id` and `timestamp` automatically.
   */
  emit(event: Omit<InspectEvent, "id" | "timestamp">): InspectEvent;

  /**
   * Retrieve recent events, newest first.
   */
  // 2026-08-12 pagination: offset + total so the console events page can page
  // through the full 2000-event audit log, not just the newest slice.
  recent(options?: { limit?: number; offset?: number; type?: InspectEventType }): { events: InspectEvent[]; total: number };

  /**
   * Clear all stored events.
   */
  clear(): void;
}
