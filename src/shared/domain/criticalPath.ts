import type { CriticalChain } from "./types";

/** 并列判定的相对带宽：与最长链路的差距不超过最长链路的 0.5% 即视为并列 */
export const CRITICAL_TIE_RATIO = 0.005;
/** 并列判定的绝对带宽下限，避免短链路上浮点误差与 1ms 级抖动导致集合抖动 */
export const CRITICAL_TIE_FLOOR_MS = 1;
/** 并列链路枚举上限，防止宽 DAG 上路径组合爆炸；超出后节点并集仍然完整 */
export const MAX_ENUMERATED_CHAINS = 32;

export interface CriticalAnalysis {
  chains: CriticalChain[];
  /** 出现在任一条并列关键链路上的节点 id */
  criticalNodeIds: string[];
  longestMs: number;
  toleranceMs: number;
  truncated: boolean;
}

interface ChainInput {
  /** 已做存在性校验的依赖边：dependencyIds 只包含图内真实节点 */
  nodes: { id: string; dependencyIds: string[] }[];
  durations: Map<string, number>;
}

const compareId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 在依赖 DAG 上按 CPM 求并列关键链路集合。
 *
 * 判定规则：
 * 1. 只沿真实依赖边做 CPM 正向最长路径计算，
 *    资源排队造成的先后关系不是图上的边，不参与判定；
 * 2. 最长路径长度 Lmax；带宽 Δ = max(1ms, Lmax × 0.5%)，
 *    任意入口→末端路径，其总长 ≥ Lmax − Δ 即为并列关键链路（精确等长必然入选）；
 * 3. 每个节点的依赖先按 id 字典序排序，枚举每一步都先选最小 id，
 *    产出的路径序列天然按节点 id 序列的字典序排列，第一条恒为主链路；
 *    判定只依赖拓扑与耗时，与节点数组顺序、调度槽编号无关，
 *    同样输入重复推演必然得到同一集合。
 */
export function analyzeCriticalChains({
  nodes,
  durations,
}: ChainInput): CriticalAnalysis {
  const ids = nodes.map((node) => node.id);
  const empty = {
    chains: [],
    criticalNodeIds: [],
    longestMs: 0,
    toleranceMs: CRITICAL_TIE_FLOOR_MS,
    truncated: false,
  };
  if (!ids.length) return empty;

  const deps = new Map(
    nodes.map((node) => [
      node.id,
      [...new Set(node.dependencyIds)].sort(compareId),
    ]),
  );
  const duration = (id: string) => durations.get(id) ?? 0;

  // Kahn 拓扑序；入度同时就绪的节点按 id 排序，保证遍历顺序确定
  const indegree = new Map(ids.map((id) => [id, 0]));
  const successors = new Map(ids.map((id) => [id, [] as string[]]));
  for (const id of ids) {
    for (const dep of deps.get(id) ?? []) {
      indegree.set(id, (indegree.get(id) ?? 0) + 1);
      successors.get(dep)?.push(id);
    }
  }
  for (const list of successors.values()) list.sort(compareId);
  const ready = ids
    .filter((id) => indegree.get(id) === 0)
    .sort(compareId);
  const topo: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    topo.push(id);
    for (const next of successors.get(id) ?? []) {
      const degree = (indegree.get(next) ?? 1) - 1;
      indegree.set(next, degree);
      if (degree === 0) {
        let index = ready.length;
        while (index > 0 && ready[index - 1]! > next) index -= 1;
        ready.splice(index, 0, next);
      }
    }
  }
  // 上游已保证无环；防御性处理
  if (topo.length !== ids.length) return empty;

  // 正向 CPM：EF(id) = duration(id) + max(EF(dep))
  const earliestFinish = new Map<string, number>();
  for (const id of topo) {
    const start = (deps.get(id) ?? []).reduce(
      (max, dep) => Math.max(max, earliestFinish.get(dep) ?? 0),
      0,
    );
    earliestFinish.set(id, start + duration(id));
  }
  const longestMs = topo.reduce(
    (max, id) => Math.max(max, earliestFinish.get(id) ?? 0),
    0,
  );
  const toleranceMs = Math.max(
    CRITICAL_TIE_FLOOR_MS,
    longestMs * CRITICAL_TIE_RATIO,
  );
  const bandFloor = longestMs - toleranceMs;

  // pre(id)：以 id 结尾的最长路径；suf(id)：以 id 开头的最长路径（均含自身耗时）。
  const prefix = new Map<string, number>();
  for (const id of topo) {
    prefix.set(
      id,
      (deps.get(id) ?? []).reduce(
        (max, dep) => Math.max(max, prefix.get(dep) ?? 0),
        0,
      ) + duration(id),
    );
  }
  const suffix = new Map<string, number>();
  for (let index = topo.length - 1; index >= 0; index -= 1) {
    const id = topo[index]!;
    const children = successors.get(id) ?? [];
    suffix.set(
      id,
      duration(id) +
        (children.length
          ? Math.max(...children.map((child) => suffix.get(child) ?? 0))
          : 0),
    );
  }

  // 节点/边属于某条带内完整路径，当且仅当“经过它的最长完整路径”仍在带宽内
  const onBandNode = (id: string) =>
    (prefix.get(id) ?? 0) + (suffix.get(id) ?? 0) - duration(id) >= bandFloor;
  const onBandEdge = (dep: string, id: string) =>
    (prefix.get(dep) ?? 0) + (suffix.get(id) ?? 0) >= bandFloor;

  // 沿带内边 DFS 枚举；后继已按 id 排序，故结果天然为字典序
  const bandRoots = topo
    .filter((id) => (deps.get(id) ?? []).length === 0 && onBandNode(id))
    .sort(compareId);
  const paths: string[][] = [];
  let truncated = false;
  const stack: string[] = [];
  const walk = (id: string) => {
    stack.push(id);
    const children = (successors.get(id) ?? []).filter(
      (child) => onBandNode(child) && onBandEdge(id, child),
    );
    if (!children.length) {
      const length = stack.reduce((sum, nodeId) => sum + duration(nodeId), 0);
      if (length >= bandFloor) {
        if (paths.length < MAX_ENUMERATED_CHAINS) paths.push([...stack]);
        else truncated = true;
      }
    } else {
      for (const child of children) walk(child);
    }
    stack.pop();
  };
  for (const root of bandRoots) walk(root);

  const chains: CriticalChain[] = paths.map((nodeIds, index) => {
    const lengthMs = nodeIds.reduce((sum, id) => sum + duration(id), 0);
    return {
      nodeIds,
      lengthMs,
      slackMs: longestMs - lengthMs,
      primary: index === 0,
    };
  });
  // 枚举被截断时，并集仍由 onBandNode 完整给出，不依赖已枚举路径
  const criticalNodeIds = topo.filter(onBandNode);

  return {
    chains,
    criticalNodeIds,
    longestMs,
    toleranceMs,
    truncated,
  };
}
