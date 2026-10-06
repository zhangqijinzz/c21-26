import { analyzeGraph } from "./graph";
import { analyzeCriticalChains, MAX_ENUMERATED_CHAINS } from "./criticalPath";
import type {
  LatencyProject,
  RequestNode,
  SimulationMode,
  SimulationResult,
  TimelineEntry,
} from "./types";

function expectedAttempts(node: RequestNode, mode: SimulationMode): number {
  const jitterFactor = mode === "low" ? 0 : mode === "high" ? 1 : 0.5;
  const serviceMs = Math.min(
    node.durationMs + node.jitterMs * jitterFactor,
    node.timeoutMs || Number.POSITIVE_INFINITY,
  );
  const failure = node.failureRate / 100;
  let elapsed = 0;
  let priorFailures = 1;
  for (let attempt = 0; attempt <= node.retryCount; attempt += 1) {
    elapsed += priorFailures * serviceMs;
    priorFailures *= failure;
    if (attempt < node.retryCount)
      elapsed += priorFailures * Math.min(200 * 2 ** attempt, 2_000);
  }
  return elapsed;
}

export function simulateProject(
  project: LatencyProject,
  mode: SimulationMode = "expected",
): SimulationResult {
  const analysis = analyzeGraph(project);
  if (analysis.validation.errors.length) {
    return {
      mode,
      completionMs: 0,
      dependencyMakespanMs: 0,
      queueBottleneckMs: 0,
      criticalChains: [],
      criticalChainsTruncated: false,
      criticalToleranceMs: 1,
      criticalPath: [],
      criticalNodeIds: [],
      entries: [],
      warnings: analysis.validation.errors,
    };
  }

  const byId = new Map(project.nodes.map((node) => [node.id, node]));
  const baseDurations = new Map(
    project.nodes.map((node) => [node.id, expectedAttempts(node, mode)]),
  );
  const durations = new Map(baseDurations);
  for (const node of project.nodes) {
    const fallback = node.fallbackNodeId
      ? byId.get(node.fallbackNodeId)
      : undefined;
    if (fallback) {
      const terminalFailure = (node.failureRate / 100) ** (node.retryCount + 1);
      durations.set(
        node.id,
        (durations.get(node.id) ?? 0) +
          (baseDurations.get(fallback.id) ?? 0) * terminalFailure,
      );
    }
  }

  // 资源排队只决定每条请求在时间线上的起点与等待时长。
  // 槽位先后不是依赖关系，绝不参与关键链路判定。
  const concurrency =
    project.concurrencyLimit ?? Math.max(1, project.nodes.length);
  const slots = Array.from(
    { length: Math.max(1, Math.min(concurrency, project.nodes.length || 1)) },
    (_, index) => ({ index, endMs: 0 }),
  );
  const entries: TimelineEntry[] = [];
  for (const id of analysis.order) {
    const node = byId.get(id);
    if (!node) continue;
    const slot = slots.reduce(
      (best, candidate) =>
        candidate.endMs < best.endMs ||
        (candidate.endMs === best.endMs && candidate.index < best.index)
          ? candidate
          : best,
      slots[0]!,
    );
    const dependencyEndMs = node.dependencyIds
      .map((dependencyId) => entries.find((entry) => entry.nodeId === dependencyId)?.endMs ?? 0)
      .reduce((max, endMs) => Math.max(max, endMs), 0);
    const startMs = Math.max(slot.endMs, dependencyEndMs);
    const modeledDurationMs = durations.get(id) ?? 0;
    const endMs = startMs + modeledDurationMs;
    entries.push({
      nodeId: id,
      startMs,
      endMs,
      modeledDurationMs,
      waitMs: Math.max(0, slot.endMs - dependencyEndMs),
      criticalRole: "none",
    });
    slot.endMs = endMs;
  }

  const completionMs = entries.reduce(
    (max, entry) => Math.max(max, entry.endMs),
    0,
  );

  // 关键链路集合：仅在真实依赖 DAG 上判定，耗时取同一套建模预算。
  const critical = analyzeCriticalChains({
    nodes: project.nodes.map((node) => ({
      id: node.id,
      dependencyIds: node.dependencyIds.filter((dep) => byId.has(dep)),
    })),
    durations,
  });
  const primarySet = new Set(critical.chains[0]?.nodeIds ?? []);
  const criticalSet = new Set(critical.criticalNodeIds);
  for (const entry of entries) {
    entry.criticalRole = primarySet.has(entry.nodeId)
      ? "primary"
      : criticalSet.has(entry.nodeId)
        ? "parallel"
        : "none";
  }

  // 资源瓶颈：实际完成预算相对“纯依赖最长路径”的增量。
  // 增量显著说明瓶颈在并发额度而非任何一条依赖链路，优化单条链路无效。
  const queueBottleneckMs = Math.max(
    0,
    completionMs - critical.longestMs,
  );
  const warnings = [...analysis.validation.warnings];
  if (
    queueBottleneckMs >
    Math.max(1, completionMs * 0.01)
  ) {
    warnings.push(
      `完成预算比依赖最长路径多出 ${Math.round(queueBottleneckMs)} ms，瓶颈来自并发排队而非关键链路；加并发或拆分资源竞争才能缩短预算`,
    );
  }
  if (critical.truncated) {
    warnings.push(
      `并列关键链路超过 ${MAX_ENUMERATED_CHAINS} 条展示上限，仅列出前 ${critical.chains.length} 条；时间线仍高亮全部关键节点，判定带宽 ${Math.round(critical.toleranceMs)} ms`,
    );
  }
  if (
    project.nodes.some(
      (node) =>
        node.timeoutMs > 0 &&
        node.durationMs +
          node.jitterMs *
            (mode === "high" ? 1 : mode === "expected" ? 0.5 : 0) >
          node.timeoutMs,
    )
  ) {
    warnings.push("部分节点会触发超时截断，已计入重试与退避预算");
  }
  return {
    mode,
    completionMs,
    dependencyMakespanMs: critical.longestMs,
    queueBottleneckMs,
    criticalChains: critical.chains,
    criticalChainsTruncated: critical.truncated,
    criticalToleranceMs: critical.toleranceMs,
    criticalPath: critical.chains[0]?.nodeIds ?? [],
    criticalNodeIds: critical.criticalNodeIds,
    entries,
    warnings,
  };
}
