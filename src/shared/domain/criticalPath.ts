import type { CriticalPathInfo, RequestNode, TimelineEntry } from "./types";

/** 并列判定的绝对容差：与主链路耗时相差不超过该值即视为并列 */
export const CRITICAL_PATH_TOLERANCE_ABSOLUTE_MS = 50;
/** 并列判定的相对容差：与主链路耗时的相对差不超过该比例即视为并列 */
export const CRITICAL_PATH_TOLERANCE_RELATIVE = 0.05;

export function criticalPathToleranceMs(primaryDurationMs: number): number {
  return Math.max(
    CRITICAL_PATH_TOLERANCE_ABSOLUTE_MS,
    primaryDurationMs * CRITICAL_PATH_TOLERANCE_RELATIVE,
  );
}

export function describeCriticalPathRule(): string {
  return (
    "关键链路只沿依赖边回溯，资源排队造成的前后关系不计入链路；" +
    `链路耗时与主链路相差不超过 ${CRITICAL_PATH_TOLERANCE_ABSOLUTE_MS} ms 或 ` +
    `${CRITICAL_PATH_TOLERANCE_RELATIVE * 100}%（取较大者）的依赖链，判定为并列关键链路。`
  );
}

interface PathCandidate extends CriticalPathInfo {
  terminalId: string;
}

/**
 * 确定性排序：耗时降序 → 链尾节点 id 字典序 → 链上节点序列字典序 → 链长。
 * 耗时相同、依赖形状对称的链路因此得到稳定顺序，与输入遍历顺序无关。
 */
function compareCandidates(a: PathCandidate, b: PathCandidate): number {
  if (a.durationMs !== b.durationMs) return b.durationMs - a.durationMs;
  if (a.terminalId !== b.terminalId)
    return a.terminalId < b.terminalId ? -1 : 1;
  const shared = Math.min(a.nodeIds.length, b.nodeIds.length);
  for (let index = 0; index < shared; index += 1) {
    const left = a.nodeIds[index] ?? "";
    const right = b.nodeIds[index] ?? "";
    if (left !== right) return left < right ? -1 : 1;
  }
  return a.nodeIds.length - b.nodeIds.length;
}

/**
 * 识别关键链路集合。
 *
 * 判定规则：
 * 1. 链路只沿依赖边回溯（entries 中的 criticalPredecessorId 已是依赖前驱），
 *    资源排队造成的前后关系不会把短链路拉进关键集合；
 * 2. 每个汇点（不被任何节点依赖）产生一条候选链，链路耗时为链上节点
 *    建模耗时之和，不含排队等待；
 * 3. 耗时最长的候选链为主链路；其余候选链与主链路耗时相差不超过
 *    max(50ms, 5%) 的，判定为并列关键链路。
 *
 * 输出排序由 compareCandidates 唯一确定，同样的输入反复推演必得到同样的集合。
 */
export function computeCriticalPaths(
  nodes: RequestNode[],
  entries: TimelineEntry[],
): CriticalPathInfo[] {
  const entryById = new Map(entries.map((entry) => [entry.nodeId, entry]));
  const dependedUpon = new Set(nodes.flatMap((node) => node.dependencyIds));
  const candidates: PathCandidate[] = [];
  for (const entry of entries) {
    if (dependedUpon.has(entry.nodeId)) continue;
    const nodeIds: string[] = [];
    let durationMs = 0;
    let cursor: TimelineEntry | undefined = entry;
    while (cursor) {
      nodeIds.unshift(cursor.nodeId);
      durationMs += cursor.modeledDurationMs;
      cursor = cursor.criticalPredecessorId
        ? entryById.get(cursor.criticalPredecessorId)
        : undefined;
    }
    candidates.push({
      nodeIds,
      durationMs,
      endMs: entry.endMs,
      terminalId: entry.nodeId,
      primary: false,
    });
  }
  candidates.sort(compareCandidates);
  const primary = candidates[0];
  if (!primary) return [];
  const tolerance = criticalPathToleranceMs(primary.durationMs);
  const paths: CriticalPathInfo[] = [];
  for (const candidate of candidates) {
    const isPrimary = candidate === primary;
    if (!isPrimary && candidate.durationMs < primary.durationMs - tolerance)
      break;
    paths.push({
      nodeIds: candidate.nodeIds,
      durationMs: candidate.durationMs,
      endMs: candidate.endMs,
      primary: isPrimary,
    });
  }
  return paths;
}
