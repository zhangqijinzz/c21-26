import type {
  CriticalChain,
  LatencyProject,
  RequestNode,
  ScenarioSnapshot,
  SimulationResult,
} from "../../shared/domain/types";

export interface CriticalChainChange {
  kind: "unchanged" | "shifted" | "added" | "removed";
  /** 基准侧节点名称序列 */
  baselineNames: string[];
  /** 对照侧节点名称序列 */
  comparisonNames: string[];
  /** 主链路 / 并列链路 */
  primary: boolean;
}

export interface ScenarioComparison {
  deltaMs: number;
  changes: string[];
  outcome: "faster" | "slower" | "equal";
  /** 关键链路集合的逐条变化（主链路排第一） */
  criticalChanges: CriticalChainChange[];
  baselineChainCount: number;
  comparisonChainCount: number;
}

function chainKey(chain: CriticalChain): string {
  return chain.nodeIds.join(">");
}

function chainNames(
  chain: CriticalChain | undefined,
  names: Map<string, string>,
): string[] {
  return (chain?.nodeIds ?? []).map((id) => names.get(id) ?? id);
}

/** 对比两份快照的并列关键链路集合，输出稳定、可解释的逐条变化 */
export function diffCriticalChains(
  baseline: ScenarioSnapshot,
  comparison: ScenarioSnapshot,
): CriticalChainChange[] {
  const baselineNames = new Map(
    baseline.nodes.map((node) => [node.id, node.name]),
  );
  const comparisonNames = new Map(
    comparison.nodes.map((node) => [node.id, node.name]),
  );
  // 旧快照可能没有链路集合，回退为单条 criticalPath
  const baselineChains: CriticalChain[] = baseline.criticalChains?.length
    ? baseline.criticalChains
    : baseline.criticalPath.length
      ? [
          {
            nodeIds: baseline.criticalPath,
            lengthMs: baseline.completionMs,
            slackMs: 0,
            primary: true,
          },
        ]
      : [];
  const comparisonChains: CriticalChain[] = comparison.criticalChains?.length
    ? comparison.criticalChains
    : comparison.criticalPath.length
      ? [
          {
            nodeIds: comparison.criticalPath,
            lengthMs: comparison.completionMs,
            slackMs: 0,
            primary: true,
          },
        ]
      : [];

  const comparisonByKey = new Map(
    comparisonChains.map((chain) => [chainKey(chain), chain]),
  );
  const seen = new Set<string>();
  const result: CriticalChainChange[] = [];

  // 以对照侧的顺序为主序：主链路永远排第一，并列链路按稳定字典序跟随
  for (const chain of comparisonChains) {
    const key = chainKey(chain);
    seen.add(key);
    const before = baselineChains.find((item) => chainKey(item) === key);
    result.push({
      kind: before ? "unchanged" : "added",
      baselineNames: before ? chainNames(before, baselineNames) : [],
      comparisonNames: chainNames(chain, comparisonNames),
      primary: chain.primary,
    });
  }
  for (const chain of baselineChains) {
    const key = chainKey(chain);
    if (seen.has(key)) continue;
    result.push({
      kind: "removed",
      baselineNames: chainNames(chain, baselineNames),
      comparisonNames: [],
      primary: chain.primary,
    });
  }
  result.sort((a, b) => (a.primary === b.primary ? 0 : a.primary ? -1 : 1));
  return result;
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
  const criticalChanges = diffCriticalChains(baseline, comparison);
  return {
    deltaMs: comparison.completionMs - baseline.completionMs,
    changes,
    criticalChanges,
    baselineChainCount:
      baseline.criticalChains?.length ?? (baseline.criticalPath.length ? 1 : 0),
    comparisonChainCount:
      comparison.criticalChains?.length ??
      (comparison.criticalPath.length ? 1 : 0),
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
    criticalChains: structuredClone(result.criticalChains),
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
