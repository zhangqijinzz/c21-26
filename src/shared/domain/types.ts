export interface RequestNode {
  id: string;
  name: string;
  durationMs: number;
  jitterMs: number;
  dependencyIds: string[];
  timeoutMs: number;
  retryCount: number;
  failureRate: number;
  fallbackNodeId?: string;
}

export interface CriticalChain {
  /** 链路上的节点 id，按入口 → 末端顺序 */
  nodeIds: string[];
  /** 仅累计真实依赖边上的节点建模耗时，不含资源排队 */
  lengthMs: number;
  /** 与最长链路的耗时差，主链路为 0 */
  slackMs: number;
  /** 主链路（并列集合中字典序最小的一条）标记；其余为并列链路 */
  primary: boolean;
}

export interface ScenarioSnapshot {
  id: string;
  name: string;
  createdAt: number;
  concurrencyLimit: number | null;
  nodes: RequestNode[];
  completionMs: number;
  /** 兼容字段：主链路节点，等同 criticalChains[0].nodeIds */
  criticalPath: string[];
  /** 保存时的并列关键链路集合 */
  criticalChains: CriticalChain[];
}

export interface LatencyProject {
  id: string;
  title: string;
  nodes: RequestNode[];
  concurrencyLimit: number | null;
  scenarios: ScenarioSnapshot[];
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceDocument {
  version: 1;
  activeProjectId: string;
  projects: LatencyProject[];
}

export type SimulationMode = "low" | "expected" | "high";

export type CriticalRole = "primary" | "parallel" | "none";

export interface TimelineEntry {
  nodeId: string;
  startMs: number;
  endMs: number;
  modeledDurationMs: number;
  waitMs: number;
  /** 该节点在关键链路集合中的角色；排队等待不会让节点成为关键节点 */
  criticalRole: CriticalRole;
}

export interface SimulationResult {
  mode: SimulationMode;
  completionMs: number;
  /** 依赖图最长路径长度（不含资源排队） */
  dependencyMakespanMs: number;
  /** 资源排队使完成预算超出依赖最长路径的部分 */
  queueBottleneckMs: number;
  /** 并列关键链路集合，按字典序排列，第一条为主链路 */
  criticalChains: CriticalChain[];
  /** 枚举是否因链路过多被截断（节点并集仍完整） */
  criticalChainsTruncated: boolean;
  /** 并列判定带宽：与最长链路差距不超过该值即视为并列 */
  criticalToleranceMs: number;
  /** 兼容字段：主链路节点 */
  criticalPath: string[];
  /** 落在任一并列关键链路上的节点 id */
  criticalNodeIds: string[];
  entries: TimelineEntry[];
  warnings: string[];
}

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

export const EXAMPLE_PROJECT: LatencyProject = {
  id: "project-latency-demo",
  title: "商品详情页 · 首屏预算",
  concurrencyLimit: null,
  createdAt: 1_728_000_000_000,
  updatedAt: 1_728_000_000_000,
  scenarios: [],
  nodes: [
    {
      id: "session",
      name: "会话校验",
      durationMs: 280,
      jitterMs: 80,
      dependencyIds: [],
      timeoutMs: 800,
      retryCount: 1,
      failureRate: 1,
    },
    {
      id: "flags",
      name: "功能开关",
      durationMs: 210,
      jitterMs: 50,
      dependencyIds: [],
      timeoutMs: 700,
      retryCount: 0,
      failureRate: 0,
    },
    {
      id: "profile",
      name: "用户资料",
      durationMs: 460,
      jitterMs: 120,
      dependencyIds: ["session"],
      timeoutMs: 1200,
      retryCount: 1,
      failureRate: 3,
    },
    {
      id: "catalog",
      name: "商品目录",
      durationMs: 740,
      jitterMs: 180,
      dependencyIds: ["session"],
      timeoutMs: 1400,
      retryCount: 1,
      failureRate: 2,
    },
    {
      id: "recommend",
      name: "个性推荐",
      durationMs: 520,
      jitterMs: 220,
      dependencyIds: ["flags", "profile"],
      timeoutMs: 1500,
      retryCount: 1,
      failureRate: 5,
      fallbackNodeId: "catalog",
    },
  ],
};

export function createEmptyProject(now = Date.now()): LatencyProject {
  return {
    id: `project-${crypto.randomUUID()}`,
    title: "未命名链路",
    nodes: [],
    concurrencyLimit: null,
    scenarios: [],
    createdAt: now,
    updatedAt: now,
  };
}
