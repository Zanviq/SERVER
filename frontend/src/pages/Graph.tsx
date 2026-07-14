import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import ForceGraph2D from "react-force-graph-2d";
import { Users, User, Bot, Share2, FolderTree, Link2, ChevronRight, Home } from "lucide-react";
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
  // AI 문서: 프로젝트를 컨테이너 노드로 두고 문서는 펼칠 때만 지연 로딩
  const [aiProjects, setAiProjects] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [subgraphs, setSubgraphs] = useState<Record<string, { nodes: any[]; links: any[] }>>({});
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 600, h: 600 });
  const isAidoc = source === "aidoc";

  // 노트 그래프 로드(AI 문서는 아래 프로젝트 지연 로딩을 사용)
  useEffect(() => {
    if (isAidoc) return;
    api
      .noteGraph(source as "common" | "me", folder, mode)
      .then(setData)
      .catch((e) => toast.error(e instanceof Error ? e.message : "그래프 로드 실패"));
  }, [source, folder, mode, isAidoc]);

  // AI 문서: 프로젝트 목록만 먼저 가볍게 로드 → 프로젝트 노드로 표시(문서는 클릭 시 펼침)
  useEffect(() => {
    if (!isAidoc) return;
    setExpanded(new Set());
    api
      .aidocProjects()
      .then(setAiProjects)
      .catch((e) => toast.error(e instanceof Error ? e.message : "프로젝트 로드 실패"));
  }, [isAidoc]);

  // 소스 변경 시 루트로 복귀
  useEffect(() => {
    setFolder("");
  }, [source]);

  const PROJ_PREFIX = "__project__:";
  const toggleProject = async (name: string) => {
    const willExpand = !expanded.has(name);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
    if (willExpand && !subgraphs[name]) {
      try {
        const g = await api.aidocGraph(name);
        setSubgraphs((prev) => ({ ...prev, [name]: g }));
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "문서 로드 실패");
      }
    }
  };

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

  const notesGraphData = useMemo(
    () => ({ nodes: data.nodes.map((n) => ({ ...n })), links: data.links.map((l) => ({ ...l })) }),
    [data],
  );

  // AI 문서 그래프: 프로젝트 노드 + (펼쳐진 프로젝트의) 문서 노드/멤버 엣지
  const aidocGraphData = useMemo(() => {
    const nodes: any[] = aiProjects.map((p) => ({
      id: PROJ_PREFIX + p,
      title: p,
      name: p,
      type: "project",
      expanded: expanded.has(p),
      count: subgraphs[p]?.nodes.length,
    }));
    const links: any[] = [];
    expanded.forEach((p) => {
      const g = subgraphs[p];
      if (!g) return;
      for (const n of g.nodes) {
        nodes.push({ ...n, type: "doc" });
        links.push({ source: PROJ_PREFIX + p, target: n.id, kind: "member" }); // 프로젝트↔문서 연결
      }
      for (const l of g.links) links.push({ ...l });
    });
    return { nodes, links };
  }, [aiProjects, expanded, subgraphs]);

  const graphData = isAidoc ? aidocGraphData : notesGraphData;

  const crumbs = folder ? folder.split("/") : [];
  const crumbPath = (i: number) => crumbs.slice(0, i + 1).join("/");

  const onNodeClick = (n: any) => {
    if (isAidoc) {
      if (n.type === "project") {
        toggleProject(n.name); // 프로젝트 노드 클릭 → 문서 펼침/접기
        return;
      }
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

      {/* AI 문서 안내 (프로젝트 노드 접기/펼치기) */}
      {isAidoc && (
        <div className="mb-3 flex items-center gap-1 text-[11.5px] text-fg-subtle">
          프로젝트 노드를 클릭하면 문서가 펼쳐지고, 다시 클릭하면 접힙니다
        </div>
      )}

      <div ref={wrapRef} className="card relative h-[calc(100vh-11rem)] overflow-hidden">
        {graphData.nodes.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-fg-muted">
            <Share2 size={30} className="text-accent" />
            <span className="text-[13px]">
              {isAidoc
                ? "프로젝트를 만들면 프로젝트 노드가 나타납니다"
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
            nodeVal={(n: any) =>
              n.type === "folder" || n.type === "project" ? 4 + Math.min(6, n.count ?? 2) : 1.6
            }
            nodeCanvasObjectMode={() => "replace"}
            nodeCanvasObject={(node: any, ctx, scale) => {
              // Nodi 스타일: 소프트 글로우 헤일로 + 코어 원(밝은 채움 + 진한 테두리) + 하단 라벨
              const isProject = node.type === "project";
              const isBig = node.type === "folder" || isProject; // 컨테이너 노드(폴더·프로젝트)
              const r = isProject ? 8 : isBig ? 7 : 5;
              // 헤일로(글로우)
              ctx.beginPath();
              ctx.arc(node.x, node.y, r + 3, 0, 2 * Math.PI);
              ctx.fillStyle = colors.halo;
              ctx.fill();
              // 코어
              ctx.beginPath();
              ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
              ctx.fillStyle = isBig ? colors.coreFolder : colors.coreNote;
              ctx.fill();
              ctx.lineWidth = isProject && node.expanded ? 1.8 : 0.9; // 펼친 프로젝트는 테두리 강조
              ctx.strokeStyle = isBig ? colors.strokeFolder : colors.strokeNote;
              ctx.stroke();
              // 라벨(노드 아래) — 프로젝트는 접기/펼치기 표시 + 문서 수
              const chevron = isProject ? (node.expanded ? "▾ " : "▸ ") : "";
              const cnt = node.count ? ` (${node.count})` : "";
              const label = isBig ? `${chevron}${node.title}${cnt}` : node.title;
              const fontSize = 11 / scale;
              ctx.font = `${isBig ? "600 " : ""}${fontSize}px Pretendard, sans-serif`;
              ctx.textAlign = "center";
              ctx.textBaseline = "top";
              ctx.fillStyle = isBig ? colors.label : colors.labelMuted;
              ctx.fillText(label, node.x, node.y + r + 3 / scale);
            }}
            cooldownTicks={80}
          />
        )}
      </div>
    </Shell>
  );
}
