import {
  Activity,
  ArrowDownUp,
  CircleHelp,
  Gauge,
  Play,
  ShieldAlert,
} from "lucide-react";
import type {
  LatencyProject,
  SimulationMode,
  SimulationResult,
} from "../../shared/domain/types";
import Timeline from "./Timeline";

interface Props {
  project: LatencyProject;
  result: SimulationResult;
  mode: SimulationMode;
  onMode: (mode: SimulationMode) => void;
  onConcurrency: (limit: number | null) => void;
  onRun: () => void;
}

const modes: { id: SimulationMode; label: string; sub: string }[] = [
  { id: "low", label: "乐观", sub: "低波动" },
  { id: "expected", label: "预期", sub: "中位估算" },
  { id: "high", label: "保守", sub: "高波动" },
];

function durationLabel(value: number): string {
  return value < 1000
    ? `${Math.round(value)} ms`
    : `${(value / 1000).toFixed(2)} s`;
}

export default function SimulationPanel({
  project,
  result,
  mode,
  onMode,
  onConcurrency,
  onRun,
}: Props) {
  const primaryChain =
    result.criticalChains.find((chain) => chain.primary) ??
    result.criticalChains[0];
  const criticalNames = (primaryChain?.nodeIds ?? result.criticalPath)
    .map((id) => project.nodes.find((node) => node.id === id)?.name)
    .filter(Boolean);
  const parallelCount = Math.max(0, result.criticalChains.length - 1);
  return (
    <section className="module-page simulation-page">
      <div className="module-heading">
        <div>
          <span className="eyebrow">03 / SIMULATION</span>
          <h1>时序推演</h1>
          <p>估算请求完成时间，找出预算被消耗在了哪里。</p>
        </div>
        <button className="button button-primary" onClick={onRun}>
          <Play size={15} fill="currentColor" /> 运行推演
        </button>
      </div>
      <div className="simulation-toolbar">
        <div className="mode-control">
          <span className="toolbar-label">预算假设</span>
          <div className="segmented-control">
            {modes.map((item) => (
              <button
                key={item.id}
                className={mode === item.id ? "selected" : ""}
                onClick={() => onMode(item.id)}
              >
                <b>{item.label}</b>
                <small>{item.sub}</small>
              </button>
            ))}
          </div>
        </div>
        <label className="concurrency-control">
          <span className="toolbar-label">最大并发</span>
          <span className="select-wrap">
            <ArrowDownUp size={14} />
            <select
              value={project.concurrencyLimit ?? "all"}
              onChange={(event) =>
                onConcurrency(
                  event.target.value === "all"
                    ? null
                    : Number(event.target.value),
                )
              }
            >
              <option value="all">不限</option>
              {[1, 2, 3, 4, 5, 8].map((value) => (
                <option key={value} value={value}>
                  {value} 路并发
                </option>
              ))}
            </select>
          </span>
        </label>
        <div className="model-note">
          <CircleHelp size={14} /> 确定性估算，不发送真实请求
        </div>
      </div>
      <div className="metric-grid">
        <article className="metric-card metric-primary">
          <span>
            页面完成预算 <Activity size={16} />
          </span>
          <strong>{durationLabel(result.completionMs)}</strong>
          <small>
            {mode === "low"
              ? "低波动情境"
              : mode === "high"
                ? "高波动情境"
                : "预期情境"}{" "}
            · {project.nodes.length} 个请求
          </small>
          <div className="metric-spark">
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
          </div>
        </article>
        <article className="metric-card">
          <span>
            关键链路 <Gauge size={16} />
          </span>
          <strong>
            {result.criticalChains.length} <small>条并列</small>
          </strong>
          <div className="critical-chips">
            {criticalNames.length ? (
              <>
                {criticalNames.map((name) => (
                  <em key={name} className="chip-primary">
                    {name}
                  </em>
                ))}
                {parallelCount > 0 && (
                  <em className="chip-parallel">
                    另有 {parallelCount} 条并列链路（见下方时间线）
                  </em>
                )}
              </>
            ) : (
              <span>等待输入节点</span>
            )}
          </div>
        </article>
        <article className="metric-card">
          <span>
            风险提示 <ShieldAlert size={16} />
          </span>
          <strong>
            {result.warnings.length} <small>items</small>
          </strong>
          <div className="risk-copy">
            {result.warnings[0] ?? "当前参数范围内未发现明显风险"}
          </div>
        </article>
      </div>
      <Timeline project={project} result={result} />
      <div className="model-footnote">
        耗时 = 截断后的请求耗时 × 失败重试概率 +
        指数退避；降级开销按最终失败概率加权。关键链路只沿真实依赖边判定（带宽{" "}
        {Math.max(
          1,
          Math.round(result.dependencyMakespanMs * 0.005),
        )}{" "}
        ms 内视为并列），资源排队单独计入等待：纯依赖最长路径{" "}
        {durationLabel(result.dependencyMakespanMs)}
        {result.queueBottleneckMs > 0
          ? `，排队额外瓶颈 ${durationLabel(result.queueBottleneckMs)}`
          : ""}
        。
      </div>
    </section>
  );
}
