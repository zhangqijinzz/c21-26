import { describe, expect, it } from "vitest";
import {
  computeCriticalPaths,
  criticalPathToleranceMs,
  describeCriticalPathRule,
} from "../src/shared/domain/criticalPath";
import { simulateProject } from "../src/shared/domain/simulation";
import {
  compareScenarios,
  saveScenario,
} from "../src/features/scenarios/scenarioViewModel";
import {
  EXAMPLE_PROJECT,
  type LatencyProject,
  type RequestNode,
} from "../src/shared/domain/types";

function node(partial: Partial<RequestNode> & { id: string }): RequestNode {
  return {
    name: partial.id,
    durationMs: 0,
    jitterMs: 0,
    dependencyIds: [],
    timeoutMs: 0,
    retryCount: 0,
    failureRate: 0,
    ...partial,
  };
}

function projectOf(
  nodes: RequestNode[],
  concurrencyLimit: number | null = null,
): LatencyProject {
  return { ...EXAMPLE_PROJECT, concurrencyLimit, nodes };
}

describe("critical path set", () => {
  it("identifies parallel chains with near-equal durations", () => {
    const project = projectOf([
      node({ id: "a", durationMs: 300 }),
      node({ id: "b", durationMs: 300 }),
      node({ id: "c", durationMs: 300, dependencyIds: ["a"] }),
      node({ id: "d", durationMs: 290, dependencyIds: ["b"] }),
    ]);
    const result = simulateProject(project);
    expect(result.completionMs).toBe(600);
    expect(result.criticalPaths.map((path) => path.nodeIds)).toEqual([
      ["a", "c"],
      ["b", "d"],
    ]);
    expect(result.criticalPaths[0]?.primary).toBe(true);
    expect(result.criticalPaths[1]?.primary).toBe(false);
    expect(result.criticalPath).toEqual(["a", "c"]);
  });

  it("does not promote a short chain into the critical set via resource queuing", () => {
    const project = projectOf(
      [node({ id: "a", durationMs: 300 }), node({ id: "b", durationMs: 10 })],
      1,
    );
    const result = simulateProject(project);
    expect(result.completionMs).toBe(310);
    const queued = result.entries.find((entry) => entry.nodeId === "b");
    expect(queued?.waitMs).toBe(300);
    expect(queued?.criticalPredecessorId).toBeUndefined();
    expect(result.criticalPaths.map((path) => path.nodeIds)).toEqual([["a"]]);
  });

  it("keeps equal-length chains in the set even when queuing serializes them", () => {
    const project = projectOf(
      [node({ id: "a", durationMs: 300 }), node({ id: "b", durationMs: 300 })],
      1,
    );
    const result = simulateProject(project);
    expect(result.completionMs).toBe(600);
    expect(result.criticalPaths.map((path) => path.nodeIds)).toEqual([
      ["a"],
      ["b"],
    ]);
  });

  it("prefers the long dependency chain over a queued short chain ending at the same time", () => {
    const project = projectOf(
      [
        node({ id: "a", durationMs: 500 }),
        node({ id: "b", durationMs: 100 }),
        node({ id: "c", durationMs: 100, dependencyIds: ["a"] }),
      ],
      1,
    );
    const result = simulateProject(project);
    // 单并发下 a(0–500) → b 排队(500–600) → c(600–700)；
    // 旧逻辑会沿资源边把链拼成 [a, b, c]，现在只认依赖链 [a, c]。
    expect(result.completionMs).toBe(700);
    expect(result.criticalPaths.map((path) => path.nodeIds)).toEqual([
      ["a", "c"],
    ]);
  });

  it("produces identical sets for repeated runs and symmetric inputs", () => {
    const makeProject = () =>
      projectOf([
        node({ id: "a", durationMs: 300 }),
        node({ id: "b", durationMs: 300 }),
        node({ id: "c", durationMs: 200, dependencyIds: ["a"] }),
        node({ id: "d", durationMs: 200, dependencyIds: ["b"] }),
      ]);
    const first = simulateProject(makeProject());
    const second = simulateProject(makeProject());
    const third = simulateProject(makeProject(), "high");
    expect(second.criticalPaths).toEqual(first.criticalPaths);
    expect(third.criticalPaths).toEqual(
      simulateProject(makeProject(), "high").criticalPaths,
    );
    expect(first.criticalPaths.map((path) => path.nodeIds)).toEqual([
      ["a", "c"],
      ["b", "d"],
    ]);
    // 输入节点顺序对称交换后，链路集合的规范排序不变
    const swapped = simulateProject(
      projectOf([
        node({ id: "d", durationMs: 200, dependencyIds: ["b"] }),
        node({ id: "c", durationMs: 200, dependencyIds: ["a"] }),
        node({ id: "b", durationMs: 300 }),
        node({ id: "a", durationMs: 300 }),
      ]),
    );
    expect(swapped.criticalPaths.map((path) => path.nodeIds)).toEqual([
      ["a", "c"],
      ["b", "d"],
    ]);
  });

  it("breaks predecessor ties by node id, not by dependency listing order", () => {
    const project = projectOf([
      node({ id: "a", durationMs: 300 }),
      node({ id: "b", durationMs: 300 }),
      node({ id: "x", durationMs: 100, dependencyIds: ["b", "a"] }),
    ]);
    const result = simulateProject(project);
    const join = result.entries.find((entry) => entry.nodeId === "x");
    expect(join?.criticalPredecessorId).toBe("a");
    expect(result.criticalPaths[0]?.nodeIds).toEqual(["a", "x"]);
  });

  it("applies the documented tolerance window", () => {
    expect(criticalPathToleranceMs(1000)).toBe(50);
    expect(criticalPathToleranceMs(2000)).toBe(100);
    expect(describeCriticalPathRule()).toContain("依赖边");
    const absolute = simulateProject(
      projectOf([
        node({ id: "main", durationMs: 1000 }),
        node({ id: "near", durationMs: 951 }),
        node({ id: "far", durationMs: 949 }),
      ]),
    );
    expect(absolute.criticalPaths.map((path) => path.nodeIds)).toEqual([
      ["main"],
      ["near"],
    ]);
    const relative = simulateProject(
      projectOf([
        node({ id: "main", durationMs: 2000 }),
        node({ id: "near", durationMs: 1901 }),
        node({ id: "far", durationMs: 1899 }),
      ]),
    );
    expect(relative.criticalPaths.map((path) => path.nodeIds)).toEqual([
      ["main"],
      ["near"],
    ]);
  });

  it("keeps only real dependency edges inside every reported chain", () => {
    const result = simulateProject(EXAMPLE_PROJECT);
    const byId = new Map(EXAMPLE_PROJECT.nodes.map((item) => [item.id, item]));
    expect(result.criticalPaths.length).toBeGreaterThan(0);
    for (const path of result.criticalPaths) {
      for (let index = 1; index < path.nodeIds.length; index += 1) {
        const current = byId.get(path.nodeIds[index] ?? "");
        expect(current?.dependencyIds).toContain(path.nodeIds[index - 1]);
      }
    }
    expect(result.criticalPath).toEqual(result.criticalPaths[0]?.nodeIds);
  });

  it("returns an empty set when the graph is invalid", () => {
    const cyclic = projectOf([
      node({ id: "a", dependencyIds: ["b"] }),
      node({ id: "b", dependencyIds: ["a"] }),
    ]);
    const result = simulateProject(cyclic);
    expect(result.criticalPaths).toEqual([]);
    expect(result.criticalPath).toEqual([]);
  });
});

describe("critical path computation edge cases", () => {
  it("handles entries without predecessors and empty input", () => {
    expect(computeCriticalPaths([], [])).toEqual([]);
    const paths = computeCriticalPaths(
      [node({ id: "a" })],
      [
        {
          nodeId: "a",
          startMs: 0,
          endMs: 40,
          modeledDurationMs: 40,
          waitMs: 0,
        },
      ],
    );
    expect(paths).toEqual([
      { nodeIds: ["a"], durationMs: 40, endMs: 40, primary: true },
    ]);
  });
});

describe("scenario comparison of critical path sets", () => {
  const named = (
    partial: Partial<RequestNode> & { id: string; name: string },
  ): RequestNode => node(partial);

  function savedPair() {
    const baselineProject = projectOf([
      named({ id: "a", name: "链A头", durationMs: 300 }),
      named({ id: "b", name: "链B头", durationMs: 300 }),
      named({ id: "c", name: "链A尾", durationMs: 300, dependencyIds: ["a"] }),
      named({ id: "d", name: "链B尾", durationMs: 290, dependencyIds: ["b"] }),
    ]);
    const baseline = saveScenario(
      baselineProject,
      simulateProject(baselineProject),
      "基准",
    ).scenarios[0];
    const changedProject = projectOf([
      named({ id: "a", name: "链A头", durationMs: 100 }),
      named({ id: "b", name: "链B头", durationMs: 300 }),
      named({ id: "c", name: "链A尾", durationMs: 100, dependencyIds: ["a"] }),
      named({ id: "d", name: "链B尾", durationMs: 290, dependencyIds: ["b"] }),
    ]);
    const comparison = saveScenario(
      changedProject,
      simulateProject(changedProject),
      "对照",
    ).scenarios[0];
    if (!baseline || !comparison)
      throw new Error("Scenario fixtures should be saved");
    return { baseline, comparison };
  }

  it("persists the path set in snapshots and reports set changes", () => {
    const { baseline, comparison } = savedPair();
    expect(baseline.criticalPaths).toHaveLength(2);
    expect(comparison.criticalPaths).toHaveLength(1);
    const result = compareScenarios(baseline, comparison);
    const report = result.criticalPathChanges.join("\n");
    expect(report).toContain("关键链路数量 · 2 条 → 1 条");
    expect(report).toContain("主链路切换 · 链A头 → 链A尾 ⇒ 链B头 → 链B尾");
    expect(report).toContain("退出关键集合 · 链A头 → 链A尾");
    expect(report).not.toContain("进入关键集合");
  });

  it("reports nothing when both snapshots share the same path set", () => {
    const { baseline } = savedPair();
    const result = compareScenarios(baseline, baseline);
    expect(result.criticalPathChanges).toEqual([]);
  });

  it("falls back to the legacy single path for old snapshots", () => {
    const { baseline, comparison } = savedPair();
    const legacyBaseline = { ...baseline, criticalPaths: undefined };
    const legacyComparison = { ...comparison, criticalPaths: undefined };
    const result = compareScenarios(legacyBaseline, legacyComparison);
    const report = result.criticalPathChanges.join("\n");
    expect(report).toContain("主链路切换 · 链A头 → 链A尾 ⇒ 链B头 → 链B尾");
    expect(report).not.toContain("关键链路数量");
  });
});
