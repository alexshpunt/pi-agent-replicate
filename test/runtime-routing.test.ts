import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  resolveRuntimePlan,
  RuntimeResolutionError,
  wrapPiModelRegistry,
} from "../pi-extension/subagents/runtime-routing.ts";

const parent = { provider: "fake", modelId: "parent", thinking: "high" as const };
const entries = [
  { provider: "fake", id: "parent", reasoning: true },
  { provider: "other", id: "role", reasoning: true },
  { provider: "other", id: "plain", reasoning: false },
];
const registry = wrapPiModelRegistry({
  find(provider: string, id: string) {
    return entries.find((entry) => entry.provider === provider && entry.id === id);
  },
  getAvailable: () => entries,
  hasConfiguredAuth: () => true,
});

describe("subagent runtime routing", () => {
  it("inherits model and thinking from the parent without role defaults", () => {
    assert.deepEqual(resolveRuntimePlan({}, parent, registry), {
      provider: "fake",
      modelId: "parent",
      model: "fake/parent",
      thinking: "high",
      modelSource: "parent",
      thinkingSource: "parent",
    });
  });

  it("uses exact model and thinking values from role frontmatter", () => {
    const plan = resolveRuntimePlan({ model: "other/role", thinking: "low" }, parent, registry);
    assert.equal(plan.model, "other/role");
    assert.equal(plan.thinking, "low");
    assert.equal(plan.modelSource, "agent");
    assert.equal(plan.thinkingSource, "agent");
  });

  it("resolves role fields independently", () => {
    const modelOnly = resolveRuntimePlan({ model: "other/role" }, parent, registry);
    assert.equal(modelOnly.modelSource, "agent");
    assert.equal(modelOnly.thinkingSource, "parent");
    const thinkingOnly = resolveRuntimePlan({ thinking: "low" }, parent, registry);
    assert.equal(thinkingOnly.modelSource, "parent");
    assert.equal(thinkingOnly.thinkingSource, "agent");
  });

  it("rejects fuzzy, fallback, unknown, and unauthenticated role models", () => {
    for (const model of ["role", "other/role, fake/parent", "other/missing"]) {
      assert.throws(() => resolveRuntimePlan({ model }, parent, registry), RuntimeResolutionError);
    }
    const unauthed = wrapPiModelRegistry({
      find: (provider: string, id: string) => entries.find((entry) => entry.provider === provider && entry.id === id),
      getAvailable: () => entries,
      hasConfiguredAuth: (model: { id: string }) => model.id !== "role",
    });
    assert.throws(() => resolveRuntimePlan({ model: "other/role" }, parent, unauthed), /authentication/);
  });

  it("clamps inherited thinking when the selected model cannot reason", () => {
    const plan = resolveRuntimePlan({ model: "other/plain" }, parent, registry);
    assert.equal(plan.thinking, "off");
    assert.deepEqual(plan.thinkingAdjustment, { from: "high", to: "off", reason: "non-reasoning" });
  });
});
