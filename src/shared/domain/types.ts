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

export interface CriticalPathInfo {
  /** 链上节点，按执行顺序排列 */
  nodeIds: string[];
  /** 链上节点建模耗时之和，不含资源排队等待 */
  durationMs: number;
  /** 链尾节点的结束时间 */
  endMs: number;
  /** 是否主链路（耗时最长的依赖链） */
  primary: boolean;
}

export interface ScenarioSnapshot {
  id: string;
  name: string;
  createdAt: number;
  concurrencyLimit: number | null;
  nodes: RequestNode[];
  completionMs: number;
  criticalPath: string[];
  /** 关键链路集合（主链路 + 并列链路）；旧快照可能缺失 */
  criticalPaths?: CriticalPathInfo[];
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

export interface TimelineEntry {
  nodeId: string;
  startMs: number;
  endMs: number;
  modeledDurationMs: number;
  waitMs: number;
  /** 关键依赖前驱：仅沿依赖边回溯，资源排队的前后不构成本字段 */
  criticalPredecessorId?: string;
}

export interface SimulationResult {
  mode: SimulationMode;
  completionMs: number;
  /** 主关键链路（criticalPaths 中 primary 的一条），保留给旧调用方 */
  criticalPath: string[];
  /** 关键链路集合：主链路在前，并列链路按耗时降序、节点 id 字典序排列 */
  criticalPaths: CriticalPathInfo[];
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
