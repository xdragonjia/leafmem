import test from "node:test";
import assert from "node:assert/strict";
import { createLeafMem, InMemoryStore } from "../src/core/index.js";
import { createMemoryRuntime } from "../src/runtime/index.js";
import type { MemoryEmbeddingProvider } from "../src/retrieval/types.js";

const scope = { type: "agent" as const, id: "cancel-test" };

test("recall rejects a pre-aborted signal without reading or counting", async () => {
  let loads = 0;
  const store = new InMemoryStore();
  const original = store.load.bind(store);
  store.load = async () => { loads++; return original(); };
  const memory = createLeafMem({ store });
  const controller = new AbortController();
  controller.abort(new Error("test cancellation"));
  await assert.rejects(memory.recall({ query: "cancel me", scopes: [scope], signal: controller.signal }), /test cancellation/);
  assert.equal(loads, 0);
});

test("recall forwards cancellation to an in-flight remote embedding", async () => {
  const controller = new AbortController();
  let observedSignal: AbortSignal | undefined;
  const provider: MemoryEmbeddingProvider = {
    id: "test-remote",
    async embedQuery(_text, signal) {
      observedSignal = signal;
      await new Promise<void>((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return [];
    },
    async embedDocuments() { return []; },
  };
  const memory = createLeafMem({ store: new InMemoryStore(), retrieval: { embeddingProvider: provider } });
  await memory.remember({ scope, kind: "note", content: "Alpha apples only." });
  const baseHits = await memory.search("totally unrelated query", { scopes: [scope], minScore: 0 });
  assert.equal(memory.retrieval.usesRemoteEmbeddings, true);
  assert.ok(baseHits.length > 0, "test must reach the remote embedding stage");
  const pending = createMemoryRuntime({ memory }).buildRecallContext({
    userMessage: "totally unrelated query", scopes: [scope], signal: controller.signal,
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(observedSignal, controller.signal);
  controller.abort(new Error("stop remote recall"));
  await assert.rejects(pending, /stop remote recall/);
});

test("normal remote recall completes with the optional signal omitted", async () => {
  let documents = 0;
  const provider: MemoryEmbeddingProvider = {
    id: "test-remote",
    async embedQuery(_text, signal) {
      signal?.throwIfAborted();
      return new Array(128).fill(1);
    },
    async embedDocuments(texts) {
      documents += texts.length;
      return texts.map(() => new Array(128).fill(1));
    },
  };
  const memory = createLeafMem({ store: new InMemoryStore(), retrieval: { embeddingProvider: provider } });
  await memory.remember({ scope, kind: "note", content: "Alpha apples only." });
  const result = await createMemoryRuntime({ memory }).buildRecallContext({ userMessage: "totally unrelated query", scopes: [scope], maxChars: 4000 });
  assert.equal(typeof result.injectedContext, "string");
  assert.ok(documents > 0, "normal runtime must actually invoke the embedding provider");
});
