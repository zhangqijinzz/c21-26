import { GitBranch, Scale } from "lucide-react";
import type {
  LatencyProject,
  SimulationResult,
} from "../../shared/domain/types";

interface Props {
  project: LatencyProject;
  result: SimulationResult;
}

function formatTime(value: number): string {
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(2)} s`;
}

export default function Timeline({ project, result }: Props) {
  const max = Math.max(1, result.completionMs);
  const primary = new Set(
    result.criticalChains.find((chain) => chain.primary)?.nodeIds ??
      result.criticalPath,
  );
  const parallel = new Set(
    result.criticalNodeIds.filter((id) => !primary.has(id)),
  );
  const chainNames = (nodeIds: string[]) =>
    nodeIds
      .map(
        (id) => project.nodes.find((node) => node.id === id)?.name ?? id,
      )
      .join(" → ");
  const marks = [0, 0.25, 0.5, 0.75, 1];
  return (
    <div className="timeline-card">
      <div className="timeline-head">
        <div>
          <span className="section-label">执行时序</span>
          <span className="timeline-caption">
            按依赖与并发预算排布；排队只影响起点，不计入关键链路
          </span>
        </div>
        <div className="timeline-legend">
          <span>
            <i className="legend-normal" /> 请求耗时
          </span>
          <span>
            <i className="legend-critical" /> 主关键链路
          </span>
          <span>
            <i className="legend-parallel" /> 并列关键链路
          </span>
          <span>
            <i className="legend-wait" /> 等待
          </span>
        </div>
      </div>
      {result.criticalChains.length > 0 && (
        <div className="critical-chain-panel">
          <div className="critical-chain-title">
            <GitBranch size={13} />
            <span>
              并列关键链路 · {result.criticalChains.length} 条
              {result.criticalChainsTruncated ? "（已截断展示）" : ""}
            </span>
            <small className="critical-rule">
              <Scale size={11} />
              判定：仅沿真实依赖边求最长路径；与最长链路差距 ≤{" "}
              {formatTime(result.criticalToleranceMs)} 即为并列，主链路为字典序第一条
            </small>
          </div>
          <ol className="critical-chain-list">
            {result.criticalChains.map((chain) => (
              <li
                key={chain.nodeIds.join(">")}
                className={chain.primary ? "is-primary" : "is-parallel"}
              >
                <em>{chain.primary ? "主链路" : `并列 +${Math.round(chain.slackMs)}ms`}</em>
                <span>{chainNames(chain.nodeIds)}</span>
                <b>{formatTime(chain.lengthMs)}</b>
              </li>
            ))}
          </ol>
        </div>
      )}
      <div className="timeline-axis">
        <div className="axis-label">REQUEST</div>
        <div className="axis-track">
          {marks.map((mark) => (
            <span key={mark} style={{ left: `${mark * 100}%` }}>
              {formatTime(max * mark)}
            </span>
          ))}
        </div>
        <div className="axis-end">DURATION</div>
      </div>
      {result.entries.map((entry, index) => {
        const node = project.nodes.find((item) => item.id === entry.nodeId);
        if (!node) return null;
        const start = (entry.startMs / max) * 100;
        const width = Math.max(1.2, (entry.modeledDurationMs / max) * 100);
        const criticalClass =
          entry.criticalRole === "primary"
            ? "is-critical"
            : entry.criticalRole === "parallel"
              ? "is-parallel-critical"
              : "";
        return (
          <div className="timeline-row" key={entry.nodeId}>
            <div className="timeline-name">
              <span className={`timeline-icon tone-${index % 4}`}>
                {node.name.slice(0, 1)}
              </span>
              <span>
                <b>{node.name}</b>
                <small>
                  {entry.waitMs > 0
                    ? `资源排队 ${formatTime(entry.waitMs)}（非关键依赖）`
                    : primary.has(entry.nodeId)
                      ? "主关键链路上"
                      : parallel.has(entry.nodeId)
                        ? "并列关键链路上"
                        : "就绪后启动"}
                </small>
              </span>
            </div>
            <div className="timeline-track">
              <div className="timeline-grid" />
              {entry.waitMs > 0 && (
                <div
                  className="wait-bar"
                  style={{
                    left: `${Math.max(0, ((entry.startMs - entry.waitMs) / max) * 100)}%`,
                    width: `${(entry.waitMs / max) * 100}%`,
                  }}
                />
              )}
              <div
                className={`duration-bar ${criticalClass} tone-${index % 4}`}
                style={{
                  left: `${start}%`,
                  width: `${Math.min(width, 100 - start)}%`,
                }}
              >
                <span>{formatTime(entry.modeledDurationMs)}</span>
              </div>
            </div>
            <div className="timeline-end">{formatTime(entry.endMs)}</div>
          </div>
        );
      })}
      {!result.entries.length && (
        <div className="timeline-empty">修复链路配置后即可生成时序预览。</div>
      )}
    </div>
  );
}
