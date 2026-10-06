import type {
  CriticalPathInfo,
  LatencyProject,
  RequestNode,
  ScenarioSnapshot,
  SimulationResult,
} from "../../shared/domain/types";

export interface ScenarioComparison {
  deltaMs: number;
  changes: string[];
  /** 关键链路集合的变化（主链路切换、链路进出集合、数量变化） */
  criticalPathChanges: string[];
  outcome: "faster" | "slower" | "equal";
}

function describeNodeChanges(
  before: RequestNode,
  after: RequestNode,
): string[] {
  const changes: string[] = [];
  if (before.durationMs !== after.durationMs)
    changes.push(
      `${before.name} · 耗时 ${before.durationMs} → ${after.durationMs} ms`,
    );
  if (before.jitterMs !== after.jitterMs)
    changes.push(
      `${before.name} · 波动 ±${before.jitterMs} → ±${after.jitterMs} ms`,
    );
  if (before.timeoutMs !== after.timeoutMs)
    changes.push(
      `${before.name} · 超时 ${before.timeoutMs} → ${after.timeoutMs} ms`,
    );
  if (before.retryCount !== after.retryCount)
    changes.push(
      `${before.name} · 重试 ${before.retryCount} → ${after.retryCount} 次`,
    );
  if (before.failureRate !== after.failureRate)
    changes.push(
      `${before.name} · 失败率 ${before.failureRate} → ${after.failureRate}%`,
    );
  if (before.fallbackNodeId !== after.fallbackNodeId)
    changes.push(`${before.name} · 降级目标已调整`);
  if (before.dependencyIds.join("|") !== after.dependencyIds.join("|"))
    changes.push(`${before.name} · 前置依赖已调整`);
  return changes;
}

interface LabeledPath {
  label: string;
  primary: boolean;
}

function snapshotCriticalPaths(snapshot: ScenarioSnapshot): LabeledPath[] {
  const nameOf = (id: string) =>
    snapshot.nodes.find((node) => node.id === id)?.name ?? id;
  const paths: CriticalPathInfo[] =
    snapshot.criticalPaths ??
    (snapshot.criticalPath.length
      ? [
          {
            nodeIds: snapshot.criticalPath,
            durationMs: 0,
            endMs: 0,
            primary: true,
          },
        ]
      : []);
  return paths.map((path) => ({
    label: path.nodeIds.map(nameOf).join(" → "),
    primary: path.primary,
  }));
}

function describeCriticalPathChanges(
  baseline: ScenarioSnapshot,
  comparison: ScenarioSnapshot,
): string[] {
  const baselinePaths = snapshotCriticalPaths(baseline);
  const comparisonPaths = snapshotCriticalPaths(comparison);
  if (!baselinePaths.length && !comparisonPaths.length) return [];
  const changes: string[] = [];
  if (baselinePaths.length !== comparisonPaths.length)
    changes.push(
      `关键链路数量 · ${baselinePaths.length} 条 → ${comparisonPaths.length} 条`,
    );
  const baselinePrimary = baselinePaths.find((path) => path.primary)?.label;
  const comparisonPrimary = comparisonPaths.find((path) => path.primary)?.label;
  if (
    baselinePrimary &&
    comparisonPrimary &&
    baselinePrimary !== comparisonPrimary
  )
    changes.push(`主链路切换 · ${baselinePrimary} ⇒ ${comparisonPrimary}`);
  const baselineLabels = new Set(baselinePaths.map((path) => path.label));
  const comparisonLabels = new Set(comparisonPaths.map((path) => path.label));
  for (const label of comparisonPaths.map((path) => path.label))
    if (!baselineLabels.has(label)) changes.push(`进入关键集合 · ${label}`);
  for (const label of baselinePaths.map((path) => path.label))
    if (!comparisonLabels.has(label)) changes.push(`退出关键集合 · ${label}`);
  return changes;
}

export function compareScenarios(
  baseline: ScenarioSnapshot,
  comparison: ScenarioSnapshot,
): ScenarioComparison {
  const baselineNodes = new Map(baseline.nodes.map((node) => [node.id, node]));
  const comparisonNodes = new Map(
    comparison.nodes.map((node) => [node.id, node]),
  );
  const changes = [
    ...baseline.nodes.flatMap((node) => {
      const next = comparisonNodes.get(node.id);
      return next
        ? describeNodeChanges(node, next)
        : [`${node.name} · 已从对照方案移除`];
    }),
    ...comparison.nodes
      .filter((node) => !baselineNodes.has(node.id))
      .map((node) => `${node.name} · 新增请求节点`),
  ];
  if (baseline.concurrencyLimit !== comparison.concurrencyLimit)
    changes.unshift(
      `并发上限 · ${baseline.concurrencyLimit ?? "不限"} → ${comparison.concurrencyLimit ?? "不限"}`,
    );
  return {
    deltaMs: comparison.completionMs - baseline.completionMs,
    changes,
    criticalPathChanges: describeCriticalPathChanges(baseline, comparison),
    outcome:
      comparison.completionMs < baseline.completionMs
        ? "faster"
        : comparison.completionMs > baseline.completionMs
          ? "slower"
          : "equal",
  };
}

export function saveScenario(
  project: LatencyProject,
  result: SimulationResult,
  name: string,
): LatencyProject {
  if (
    result.warnings.some(
      (warning) => warning.includes("检测到循环") || warning.includes("不能"),
    )
  )
    return project;
  const snapshot: ScenarioSnapshot = {
    id: crypto.randomUUID(),
    name: name.trim() || `方案 ${project.scenarios.length + 1}`,
    createdAt: Date.now(),
    concurrencyLimit: project.concurrencyLimit,
    nodes: structuredClone(project.nodes),
    completionMs: result.completionMs,
    criticalPath: [...result.criticalPath],
    criticalPaths: result.criticalPaths.map((path) => ({
      ...path,
      nodeIds: [...path.nodeIds],
    })),
  };
  return {
    ...project,
    scenarios: [snapshot, ...project.scenarios],
    updatedAt: Date.now(),
  };
}

export function removeScenario(
  project: LatencyProject,
  scenarioId: string,
): LatencyProject {
  return {
    ...project,
    scenarios: project.scenarios.filter(
      (scenario) => scenario.id !== scenarioId,
    ),
    updatedAt: Date.now(),
  };
}

export function restoreScenario(
  project: LatencyProject,
  scenarioId: string,
): LatencyProject {
  const snapshot = project.scenarios.find(
    (scenario) => scenario.id === scenarioId,
  );
  if (!snapshot) return project;
  return {
    ...project,
    nodes: structuredClone(snapshot.nodes),
    concurrencyLimit: snapshot.concurrencyLimit,
    updatedAt: Date.now(),
  };
}
