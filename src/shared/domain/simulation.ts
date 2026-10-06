import { analyzeGraph } from "./graph";
import { computeCriticalPaths } from "./criticalPath";
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
      criticalPath: [],
      criticalPaths: [],
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

  const concurrency =
    project.concurrencyLimit ?? Math.max(1, project.nodes.length);
  const slots = Array.from(
    { length: Math.max(1, Math.min(concurrency, project.nodes.length || 1)) },
    (_, index) => ({
      index,
      endMs: 0,
      nodeId: undefined as string | undefined,
    }),
  );
  const entries: TimelineEntry[] = [];
  const chainLengthById = new Map<string, number>();
  for (const id of analysis.order) {
    const node = byId.get(id);
    if (!node) continue;
    const slot = slots.reduce(
      (best, candidate) => (candidate.endMs < best.endMs ? candidate : best),
      slots[0]!,
    );
    const dependencyEntries = node.dependencyIds
      .map((dependencyId) =>
        entries.find((entry) => entry.nodeId === dependencyId),
      )
      .filter((entry): entry is TimelineEntry => Boolean(entry));
    const latestDependency = dependencyEntries.reduce<
      TimelineEntry | undefined
    >(
      (latest, entry) =>
        !latest || entry.endMs > latest.endMs ? entry : latest,
      undefined,
    );
    const startMs = Math.max(slot.endMs, latestDependency?.endMs ?? 0);
    const modeledDurationMs = durations.get(id) ?? 0;
    const endMs = startMs + modeledDurationMs;
    // 关键前驱只沿依赖边选择：取依赖链耗时最长者；耗时相同取节点 id
    // 字典序较小者，保证对称结构下结果稳定。资源排队的前后不进入链路。
    const criticalPredecessor = dependencyEntries.reduce<
      TimelineEntry | undefined
    >((best, entry) => {
      if (!best) return entry;
      const bestLength = chainLengthById.get(best.nodeId) ?? 0;
      const entryLength = chainLengthById.get(entry.nodeId) ?? 0;
      if (entryLength !== bestLength)
        return entryLength > bestLength ? entry : best;
      return entry.nodeId < best.nodeId ? entry : best;
    }, undefined);
    chainLengthById.set(
      id,
      (criticalPredecessor
        ? (chainLengthById.get(criticalPredecessor.nodeId) ?? 0)
        : 0) + modeledDurationMs,
    );
    entries.push({
      nodeId: id,
      startMs,
      endMs,
      modeledDurationMs,
      waitMs: Math.max(
        0,
        startMs -
          dependencyEntries.reduce(
            (end, entry) => Math.max(end, entry.endMs),
            0,
          ),
      ),
      ...(criticalPredecessor
        ? { criticalPredecessorId: criticalPredecessor.nodeId }
        : {}),
    });
    slot.endMs = endMs;
    slot.nodeId = id;
  }

  const lastEntry = entries.reduce<TimelineEntry | undefined>(
    (latest, entry) => (!latest || entry.endMs > latest.endMs ? entry : latest),
    undefined,
  );
  const criticalPaths = computeCriticalPaths(project.nodes, entries);
  const warnings = [...analysis.validation.warnings];
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
    completionMs: lastEntry?.endMs ?? 0,
    criticalPath: criticalPaths[0]?.nodeIds ?? [],
    criticalPaths,
    entries,
    warnings,
  };
}
