import test from "node:test";
import assert from "node:assert/strict";
import { createLeafMem, InMemoryStore } from "../src/core/index.js";

function makeMemory() {
  return createLeafMem({ store: new InMemoryStore(), inferencer: async () => ({ ok: false, text: "" }) });
}

test("host-driven distillation (principle with reflectedAt) refreshes lastReflectAt", async () => {
  const memory = makeMemory();
  const scope = { type: "agent" as const, id: "workbuddy" };
  const stamp = "2026-08-16T12:00:00.000Z";
  await memory.remember({
    scope, kind: "principle", content: "# Distilled by host skill",
    source: "skill", tags: ["principle", "reflected"],
    metadata: { reflectedAt: stamp, supports: [] },
  });
  const doc = await memory.active.read("context", scope);
  assert.equal((doc?.metadata as Record<string, unknown>)?.lastReflectAt, stamp);
});

test("ordinary memories and principle writes without reflectedAt do NOT touch the marker", async () => {
  const memory = makeMemory();
  const scope = { type: "agent" as const, id: "workbuddy" };
  await memory.remember({ scope, kind: "lesson", content: "plain lesson", source: "manual" });
  await memory.remember({ scope, kind: "principle", content: "# manual principle", source: "manual" });
  const doc = await memory.active.read("context", scope);
  assert.equal((doc?.metadata as Record<string, unknown>)?.lastReflectAt, undefined);
});
