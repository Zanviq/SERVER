import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import ForceGraph2D from "react-force-graph-2d";
import { Users, User, Share2 } from "lucide-react";
import { Shell } from "../components/layout/Shell";
import { api, NotesGraph, Scope } from "../lib/api";
import { toast } from "../store/toast";
import { useTheme } from "../store/theme";

function cssVar(name: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v ? `rgb(${v})` : "#888";
}

export function Graph() {
  const navigate = useNavigate();
  const mode = useTheme((t) => t.mode); // 테마 변경 시 색상 재계산 트리거
  const [scope, setScope] = useState<Scope>("me");
  const [data, setData] = useState<NotesGraph>({ nodes: [], links: [] });
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 600, h: 600 });

  useEffect(() => {
    api
      .noteGraph(scope)
      .then(setData)
      .catch((e) => toast.error(e instanceof Error ? e.message : "그래프 로드 실패"));
  }, [scope]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 색상은 현재 테마에서 계산 (mode 변경 시 재계산)
  const colors = useMemo(
    () => ({
      node: cssVar("--accent"),
      label: cssVar("--fg"),
      link: cssVar("--line-strong"),
    }),
    [mode],
  );

  const graphData = useMemo(
    () => ({ nodes: data.nodes.map((n) => ({ ...n })), links: data.links.map((l) => ({ ...l })) }),
    [data],
  );

  return (
    <Shell
      title="그래프"
      actions={
        <div className="inline-flex rounded-md border border-line bg-subtle p-0.5">
          <button onClick={() => setScope("common")}
            className={`inline-flex items-center gap-1.5 rounded-sm px-3 py-1 text-[13px] font-medium ${scope === "common" ? "bg-surface text-accent shadow-sm" : "text-fg-muted hover:text-fg"}`}>
            <Users size={14} /> 공통
          </button>
          <button onClick={() => setScope("me")}
            className={`inline-flex items-center gap-1.5 rounded-sm px-3 py-1 text-[13px] font-medium ${scope === "me" ? "bg-surface text-accent shadow-sm" : "text-fg-muted hover:text-fg"}`}>
            <User size={14} /> 내 노트
          </button>
        </div>
      }
    >
      <div ref={wrapRef} className="card relative h-[calc(100vh-9rem)] overflow-hidden">
        {data.nodes.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-fg-muted">
            <Share2 size={30} className="text-accent" />
            <span className="text-[13px]">노트와 [[링크]]를 만들면 그래프가 나타납니다</span>
          </div>
        ) : (
          <ForceGraph2D
            graphData={graphData}
            width={size.w}
            height={size.h}
            backgroundColor="rgba(0,0,0,0)"
            nodeRelSize={5}
            onNodeClick={(n: any) =>
              navigate(`/notes?open=${encodeURIComponent(n.title)}`)
            }
            linkColor={() => colors.link}
            linkWidth={1}
            nodeColor={() => colors.node}
            nodeCanvasObjectMode={() => "after"}
            nodeCanvasObject={(node: any, ctx, scale) => {
              const label = node.title as string;
              const fontSize = 12 / scale;
              ctx.font = `${fontSize}px Pretendard, sans-serif`;
              ctx.textAlign = "center";
              ctx.textBaseline = "top";
              ctx.fillStyle = colors.label;
              ctx.fillText(label, node.x, node.y + 7 / scale);
            }}
            cooldownTicks={80}
          />
        )}
      </div>
    </Shell>
  );
}
