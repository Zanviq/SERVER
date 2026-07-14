import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import ForceGraph2D from "react-force-graph-2d";
import { Users, User, Bot, Share2, FolderTree, Link2, ChevronRight, Home, Loader2 } from "lucide-react";
import { Shell } from "../components/layout/Shell";
import { api } from "../lib/api";
import { toast } from "../store/toast";
import { useTheme } from "../store/theme";

type Source = "common" | "me" | "aidoc";

function tok(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function rgb(name: string, a = 1): string {
  const v = tok(name);
  return v ? `rgb(${v} / ${a})` : "#888";
}

type Mode = "links" | "folders";

export function Graph() {
  const navigate = useNavigate();
  const themeMode = useTheme((t) => t.mode); // 테마 변경 시 색상 재계산 트리거
  const [source, setSource] = useState<Source>("me");
  const [mode, setMode] = useState<Mode>("links");
  const [folder, setFolder] = useState(""); // 현재 폴더(상대경로)
  const [data, setData] = useState<{ nodes: any[]; links: any[] }>({ nodes: [], links: [] });
  const [loading, setLoading] = useState(false); // 소스 전환 시 로딩 오버레이
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 600, h: 600 });
  const isAidoc = source === "aidoc";

  useEffect(() => {
    let cancelled = false; // 빠른 연속 전환 시 이전 요청 결과 무시
    setLoading(true);
    const p = isAidoc
      ? api.aidocGraph()
      : api.noteGraph(source as "common" | "me", folder, mode);
    p.then((d) => {
      if (!cancelled) setData(d);
    })
      .catch((e) => {
        if (!cancelled) toast.error(e instanceof Error ? e.message : "그래프 로드 실패");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [source, folder, mode, isAidoc]);

  // 소스 변경 시 루트로 복귀
  useEffect(() => {
    setFolder("");
  }, [source]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const colors = useMemo(
    () => ({
      coreNote: rgb("--accent-muted"),
      coreFolder: rgb("--accent"),
      strokeNote: rgb("--accent"),
      strokeFolder: rgb("--accent-fg"),
      halo: rgb("--accent", 0.18),
      label: rgb("--fg"),
      labelMuted: rgb("--fg-muted"),
      link: rgb("--line-strong", 0.85),
    }),
    [themeMode],
  );

  const graphData = useMemo(
    () => ({ nodes: data.nodes.map((n) => ({ ...n })), links: data.links.map((l) => ({ ...l })) }),
    [data],
  );

  const crumbs = folder ? folder.split("/") : [];
  const crumbPath = (i: number) => crumbs.slice(0, i + 1).join("/");

  const onNodeClick = (n: any) => {
    if (isAidoc) {
      navigate(`/notes?aidoc=${encodeURIComponent(n.id)}`); // AI 문서 편집기로
    } else if (n.type === "folder") {
      setFolder(n.path); // 폴더로 진입(드릴다운)
    } else {
      navigate(`/notes?open=${encodeURIComponent(n.title)}`);
    }
  };

  const sourceToggle = (
    <div className="inline-flex rounded-md border border-line bg-subtle p-0.5">
      <button onClick={() => setSource("common")}
        className={`inline-flex items-center gap-1.5 rounded-sm px-3 py-1 text-[13px] font-medium ${source === "common" ? "bg-surface text-accent shadow-sm" : "text-fg-muted hover:text-fg"}`}>
        <Users size={14} /> 공통
      </button>
      <button onClick={() => setSource("me")}
        className={`inline-flex items-center gap-1.5 rounded-sm px-3 py-1 text-[13px] font-medium ${source === "me" ? "bg-surface text-accent shadow-sm" : "text-fg-muted hover:text-fg"}`}>
        <User size={14} /> 내 노트
      </button>
      <button onClick={() => setSource("aidoc")}
        className={`inline-flex items-center gap-1.5 rounded-sm px-3 py-1 text-[13px] font-medium ${source === "aidoc" ? "bg-surface text-accent shadow-sm" : "text-fg-muted hover:text-fg"}`}>
        <Bot size={14} /> AI 문서
      </button>
    </div>
  );

  const modeToggle = (
    <div className="inline-flex rounded-md border border-line bg-subtle p-0.5">
      <button onClick={() => setMode("links")}
        className={`inline-flex items-center gap-1.5 rounded-sm px-3 py-1 text-[13px] font-medium ${mode === "links" ? "bg-surface text-accent shadow-sm" : "text-fg-muted hover:text-fg"}`}>
        <Link2 size={14} /> 링크
      </button>
      <button onClick={() => setMode("folders")}
        className={`inline-flex items-center gap-1.5 rounded-sm px-3 py-1 text-[13px] font-medium ${mode === "folders" ? "bg-surface text-accent shadow-sm" : "text-fg-muted hover:text-fg"}`}>
        <FolderTree size={14} /> 폴더 구조
      </button>
    </div>
  );

  return (
    <Shell
      title="그래프"
      actions={<div className="flex items-center gap-2">{!isAidoc && modeToggle}{sourceToggle}</div>}
    >
      {/* 브레드크럼 (노트 폴더 진입 시) — AI 문서는 미사용 */}
      <div className={`mb-3 flex items-center gap-1 text-[13px] ${isAidoc ? "hidden" : ""}`}>
        <button onClick={() => setFolder("")}
          className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 ${folder ? "text-fg-muted hover:text-accent" : "font-semibold text-accent"}`}>
          <Home size={13} /> 루트
        </button>
        {crumbs.map((c, i) => (
          <span key={i} className="inline-flex items-center gap-1">
            <ChevronRight size={13} className="text-fg-subtle" />
            <button onClick={() => setFolder(crumbPath(i))}
              className={`rounded px-1.5 py-0.5 ${i === crumbs.length - 1 ? "font-semibold text-accent" : "text-fg-muted hover:text-accent"}`}>
              {c}
            </button>
          </span>
        ))}
        {mode === "folders" && (
          <span className="ml-2 text-[11.5px] text-fg-subtle">폴더 노드를 클릭하면 안으로 들어갑니다</span>
        )}
      </div>

      <div ref={wrapRef} className="card relative h-[calc(100vh-11rem)] overflow-hidden">
        {/* 소스 전환 로딩 오버레이 — 이전 그래프가 남아 혼란을 주지 않도록 덮는다 */}
        {loading && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-surface/70 text-fg-muted backdrop-blur-sm">
            <Loader2 size={26} className="animate-spin text-accent" />
            <span className="text-[13px]">
              {isAidoc ? "AI 문서 그래프 불러오는 중…" : "그래프 불러오는 중…"}
            </span>
          </div>
        )}
        {data.nodes.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-fg-muted">
            <Share2 size={30} className="text-accent" />
            <span className="text-[13px]">
              {isAidoc
                ? "AI 문서를 만들면 임베딩 유사도로 연결된 그래프가 나타납니다"
                : mode === "folders" ? "하위 폴더가 없습니다" : "노트와 [[링크]]를 만들면 그래프가 나타납니다"}
            </span>
          </div>
        ) : (
          <ForceGraph2D
            graphData={graphData}
            width={size.w}
            height={size.h}
            backgroundColor="rgba(0,0,0,0)"
            nodeRelSize={5}
            onNodeClick={onNodeClick}
            linkColor={(l: any) => (l.kind === "link" ? colors.strokeNote : colors.link)}
            linkWidth={(l: any) => (l.kind === "similar" ? Math.max(0.6, (l.weight ?? 0.7) * 1.6) : 1)}
            nodeVal={(n: any) => (n.type === "folder" ? 4 + Math.min(6, n.count ?? 0) : 1.6)}
            nodeCanvasObjectMode={() => "replace"}
            nodeCanvasObject={(node: any, ctx, scale) => {
              // Nodi 스타일: 소프트 글로우 헤일로 + 코어 원(밝은 채움 + 진한 테두리) + 하단 라벨
              const isFolder = node.type === "folder";
              const r = isFolder ? 7 : 5;
              // 헤일로(글로우)
              ctx.beginPath();
              ctx.arc(node.x, node.y, r + 3, 0, 2 * Math.PI);
              ctx.fillStyle = colors.halo;
              ctx.fill();
              // 코어
              ctx.beginPath();
              ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
              ctx.fillStyle = isFolder ? colors.coreFolder : colors.coreNote;
              ctx.fill();
              ctx.lineWidth = 0.9;
              ctx.strokeStyle = isFolder ? colors.strokeFolder : colors.strokeNote;
              ctx.stroke();
              // 라벨(노드 아래) — 너무 축소하면 숨김(폴더는 조금 더 오래 보이도록)
              // scale=화면 확대율(작을수록 축소). 일반 노드 0.9, 폴더 0.35 미만이면 라벨 생략.
              const labelMinScale = isFolder ? 0.35 : 0.9;
              if (scale >= labelMinScale) {
                const label = isFolder ? `${node.title}${node.count ? ` (${node.count})` : ""}` : node.title;
                const fontSize = 11 / scale;
                ctx.font = `${isFolder ? "600 " : ""}${fontSize}px Pretendard, sans-serif`;
                ctx.textAlign = "center";
                ctx.textBaseline = "top";
                ctx.fillStyle = isFolder ? colors.label : colors.labelMuted;
                ctx.fillText(label, node.x, node.y + r + 3 / scale);
              }
            }}
            cooldownTicks={80}
          />
        )}
      </div>
    </Shell>
  );
}
