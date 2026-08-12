import { randomUUID } from "node:crypto";
import type { InspectEvent, InspectEventStore, InspectEventType } from "./types.js";

const DEFAULT_CAPACITY = 500;

/**
 * In-memory ring-buffer implementation of InspectEventStore.
 * Retains the most recent `capacity` events.
 */
export class InMemoryInspectEventStore implements InspectEventStore {
  private readonly buffer: InspectEvent[] = [];
  private readonly capacity: number;

  constructor(capacity = DEFAULT_CAPACITY) {
    this.capacity = Math.max(1, capacity);
  }

  emit(event: Omit<InspectEvent, "id" | "timestamp">): InspectEvent {
    const full: InspectEvent = {
      ...event,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
    };
    this.buffer.push(full);
    if (this.buffer.length > this.capacity) {
      this.buffer.splice(0, this.buffer.length - this.capacity);
    }
    return full;
  }

  recent(options?: { limit?: number; offset?: number; type?: InspectEventType }): { events: InspectEvent[]; total: number } {
    let events = [...this.buffer].reverse();
    if (options?.type) events = events.filter((e) => e.type === options.type);
    const total = events.length;
    const offset = Math.max(0, options?.offset ?? 0);
    const limit = Math.max(1, Math.min(options?.limit ?? 200, 500));
    return { total, events: events.slice(offset, offset + limit) };
  }

  clear(): void {
    this.buffer.length = 0;
  }
}
