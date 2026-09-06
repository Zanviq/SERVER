import { PointerEvent as ReactPointerEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask, TextLayer as TextLayerT } from "pdfjs-dist";
import {
  BoxSelect, ChevronDown, ChevronUp, Eraser, ExternalLink, Loader2, MessageSquarePlus,
  Minus, Plus, ScanSearch, Sparkles, TextCursor, BookMarked,
} from "lucide-react";
import { loadPdfJs, PdfJs } from "../../lib/pdfjs";

export type PdfTool = "text" | "region";

/** 배율 1 기준(=PDF 쪽 좌표)의 사각형. 배율이 바뀌어도 같은 자리를 가리킨다. */
export interface PdfRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
/**
 * AI 입력에 얹어 둔 선택의 자국. 칩 하나에 자국 하나(id 가 같다).
 * 이게 없으면 "AI에 넣기"를 누른 순간 브라우저 선택이 사라져서 지금 어디를
 * 골라 뒀는지 볼 수 없다.
 */
export interface PdfMark {
  id: string;
  page: number;
  kind: "text" | "region";
  rects: PdfRect[];
}

interface Props {
  paperId: string;
  fileUrl: string;
  /** 마지막으로 읽던 쪽 — 열 때 거기로 간다 */
  initialPage?: number;
  onPageChange?: (page: number, total: number) => void;
  /** 드래그로 고른 글을 AI 입력에 얹는다 */
  onAddText: (text: string, page: number, rects: PdfRect[]) => void;
  /** 고른 글을 얹고 바로 묻는다 */
  onAskText: (text: string, page: number, prompt: string, rects: PdfRect[]) => void;
  /** 영역 도구로 오린 그림(PNG data URL) */
  onAddRegion: (dataUrl: string, page: number, rect: PdfRect) => void;
  /** 지금 얹혀 있는 선택의 자국(쪽 위에 그린다) */
  marks?: PdfMark[];
  /** 지금 AI 입력에 얹힌 첨부·선택 수 — "선택 모두 지우기" 버튼 */
  contextCount: number;
  onClearContext: () => void;
}

const GAP = 16;
const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 2.5, 3];
const MAX_REGION_PX = 1600;
/** 자국 하나가 담는 줄 수 상한(아주 긴 선택에서 div 가 수백 개 생기지 않게) */
const MAX_MARK_RECTS = 60;

/** 고른 글이 더 안 바뀌기를 기다리는 시간. 손잡이를 끄는 동안 말풍선이 따라다니지 않게. */
const SELECT_SETTLE_MS = 250;

type Size = { w: number; h: number };

/**
 * 선택 범위가 덮은 줄들을 그 쪽 기준 좌표(배율 1)로 바꾼다.
 * 여러 쪽에 걸친 선택은 시작 쪽에 걸린 부분만 남는다 — 자국은 "여기를 골랐다"는
 * 표시일 뿐이고, AI 로 가는 글은 선택 전체가 그대로 간다.
 */
function rectsIn(range: Range, pageEl: HTMLElement | null, scale: number): PdfRect[] {
  if (!pageEl || scale <= 0) return [];
  const base = pageEl.getBoundingClientRect();
  const out: PdfRect[] = [];
  for (const r of Array.from(range.getClientRects())) {
    if (r.width < 1 || r.height < 1) continue;
    const x = (r.left - base.left) / scale;
    const y = (r.top - base.top) / scale;
    const w = r.width / scale, h = r.height / scale;
    // 다른 쪽에 그려질 줄은 버린다(시작 쪽 밖)
    if (y + h < 0 || y > base.height / scale) continue;
    const last = out[out.length - 1];
    // pdf.js 텍스트 레이어는 한 줄을 여러 조각으로 준다 — 같은 줄은 이어 붙인다
    if (last && Math.abs(last.y - y) < 2 && Math.abs(last.h - h) < 2 && x - (last.x + last.w) < 6) {
      last.w = Math.max(last.w, x + w - last.x);
      continue;
    }
    out.push({ x, y, w, h });
    if (out.length >= MAX_MARK_RECTS) break;
  }
  return out;
}

/**
 * 연속 스크롤 PDF 뷰어(pdf.js). 보이는 쪽만 그린다.
 * 도구: 텍스트 선택(드래그 → "AI에 넣기" 말풍선) · 영역 선택(드래그 → 그림으로 오려 AI 첨부).
 */
export function PdfViewer({
  paperId, fileUrl, initialPage = 1, onPageChange, onAddText, onAskText, onAddRegion,
  marks = [], contextCount, onClearContext,
}: Props) {
  const [pdfjs, setPdfjs] = useState<PdfJs | null>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<Size[]>([]);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);   // '다시 시도' 가 문서 열기를 다시 돌린다
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [tool, setTool] = useState<PdfTool>("text");
  const [containerW, setContainerW] = useState(0);
  const [range, setRange] = useState<[number, number]>([0, 1]);
  const [current, setCurrent] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [pop, setPop] = useState<
    { x: number; y: number; text: string; page: number; rects: PdfRect[] } | null
  >(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolledTo = useRef<string>("");

  // ── 문서 열기 ──
  useEffect(() => {
    let alive = true;
    let doc: PDFDocumentProxy | null = null;
    setPdf(null); setSizes([]); setError(""); setCurrent(1); setPageInput("1"); setPop(null);
    scrolledTo.current = "";
    loadPdfJs().then(async (lib) => {
      if (!alive) return;
      setPdfjs(lib);
      doc = await lib.getDocument({ url: fileUrl, withCredentials: true }).promise;
      if (!alive) { void doc.loadingTask.destroy(); return; }
      const out: Size[] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const p = await doc.getPage(i);
        const v = p.getViewport({ scale: 1 });
        out.push({ w: v.width, h: v.height });
        if (!alive) return;
      }
      setSizes(out);
      setPdf(doc);
    }).catch((e) => {
      if (alive) setError(e instanceof Error ? e.message : "PDF를 열지 못했습니다");
    });
    return () => {
      alive = false;
      // 문서(워커·네트워크)를 정리한다 — 논문을 바꿀 때마다 워커가 쌓이면 안 된다
      void doc?.loadingTask.destroy();
    };
  }, [fileUrl, paperId, reload]);

  // ── 폭 감시(맞춤 배율) ──
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setContainerW(entries[0].contentRect.width));
    ro.observe(el);
    setContainerW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const maxW = useMemo(() => sizes.reduce((m, s) => Math.max(m, s.w), 0), [sizes]);
  const scale = useMemo(() => {
    if (zoom !== "fit") return zoom;
    if (!maxW || !containerW) return 1;
    return Math.max(0.3, (containerW - GAP * 2) / maxW);
  }, [zoom, maxW, containerW]);
  // 선택 자국은 배율 1 좌표로 저장한다. 선택을 잡는 곳이 이벤트 리스너 안이라
  // 그때의 배율을 ref 로 읽는다(리스너를 배율마다 다시 달지 않으려고).
  const scaleRef = useRef(scale);
  //: 지금 손가락·마우스가 눌려 있는가. 끄는 중에는 말풍선을 띄우지 않는다.
  const dragging = useRef(false);
  scaleRef.current = scale;

  // 각 쪽의 위 좌표(스크롤 컨테이너 기준). 크기를 다 알아서 보이는 쪽을 계산으로 고른다.
  const tops = useMemo(() => {
    const t: number[] = [];
    let y = GAP;
    for (const s of sizes) { t.push(y); y += s.h * scale + GAP; }
    return t;
  }, [sizes, scale]);
  const totalH = sizes.length ? tops[tops.length - 1] + sizes[sizes.length - 1].h * scale + GAP : 0;

  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el || tops.length === 0) return;
    const top = el.scrollTop, bottom = top + el.clientHeight;
    let a = tops.findIndex((t, i) => t + sizes[i].h * scale >= top - 800);
    if (a < 0) a = 0;
    let b = tops.findIndex((t) => t > bottom + 800);
    if (b < 0) b = tops.length;
    setRange((r) => (r[0] === a && r[1] === b ? r : [a, b]));
    // 화면의 1/3 지점이 걸친 쪽을 "지금 쪽"으로
    const probe = top + el.clientHeight / 3;
    let cur = 0;
    for (let i = 0; i < tops.length; i++) if (tops[i] <= probe) cur = i;
    setCurrent((c) => (c === cur + 1 ? c : cur + 1));
  }, [tops, sizes, scale]);

  useEffect(() => { measure(); }, [measure]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      setPop(null);
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; measure(); });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => { el.removeEventListener("scroll", onScroll); if (raf) cancelAnimationFrame(raf); };
  }, [measure]);

  useEffect(() => { setPageInput(String(current)); }, [current]);
  useEffect(() => { if (sizes.length) onPageChange?.(current, sizes.length); }, [current, sizes.length, onPageChange]);

  const scrollToPage = useCallback((page: number, behavior: ScrollBehavior = "smooth") => {
    const el = scrollRef.current;
    const i = Math.min(Math.max(page, 1), tops.length) - 1;
    if (!el || i < 0 || tops[i] == null) return;
    el.scrollTo({ top: tops[i] - 8, behavior });
  }, [tops]);

  // 처음 열 때 읽던 쪽으로(배율이 정해진 뒤 한 번만)
  useEffect(() => {
    if (!pdf || tops.length === 0 || !containerW) return;
    const key = `${paperId}`;
    if (scrolledTo.current === key) return;
    scrolledTo.current = key;
    if (initialPage > 1) scrollToPage(initialPage, "auto");
  }, [pdf, tops, containerW, paperId, initialPage, scrollToPage]);

  // ── 배율을 바꿔도 보던 쪽을 유지 ──
  const keepPage = useRef<number | null>(null);
  const changeZoom = (next: number | "fit") => {
    keepPage.current = current;
    setZoom(next);
  };
  useEffect(() => {
    if (keepPage.current != null) {
      scrollToPage(keepPage.current, "auto");
      keepPage.current = null;
    }
  }, [tops, scrollToPage]);

  // ── 텍스트 선택 → 말풍선 ──
  /** 지금 골라 둔 글을 보고 말풍선을 띄운다. 고른 것이 없거나 뷰어 밖이면 아무 일도 안 한다. */
  const showFromSelection = useCallback(() => {
    const el = scrollRef.current;
    if (!el || tool !== "text") return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const anchor = range.commonAncestorContainer;
    const node = anchor.nodeType === 1 ? (anchor as HTMLElement) : anchor.parentElement;
    if (!node || !el.contains(node)) return;
    const text = sel.toString().replace(/\s+/g, " ").trim();
    if (!text) return;
    const start = range.startContainer.nodeType === 1 ? (range.startContainer as HTMLElement) : range.startContainer.parentElement;
    const pageEl = start?.closest<HTMLElement>("[data-page]") ?? null;
    const page = Number(pageEl?.dataset.page ?? current);
    const r = range.getBoundingClientRect();
    setPop({ x: r.left + r.width / 2, y: r.bottom + 8, text, page, rects: rectsIn(range, pageEl, scaleRef.current) });
  }, [tool, current]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onDown = (e: PointerEvent) => {
      setPop(null);
      dragging.current = true;
      const layer = (e.target as HTMLElement).closest?.(".textLayer");
      if (layer) el.querySelectorAll(".textLayer").forEach((l) => l.classList.add("selecting"));
    };
    const onUp = () => {
      dragging.current = false;
      el.querySelectorAll(".textLayer").forEach((l) => l.classList.remove("selecting"));
      setTimeout(showFromSelection, 0);
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    // 손가락으로 길게 눌러 글을 고르면 **브라우저가 그 제스처를 가져간다.** 그때는
    // pointerup 대신 pointercancel 만 온다(편집기가 같은 것에 데였다 — LiveEditor).
    el.addEventListener("pointercancel", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
  }, [showFromSelection]);

  // 고른 글이 바뀌는 것 자체를 본다. 휴대폰에서 **글을 고르는 두 가지 방법**이
  // 둘 다 여기로만 온다 — 길게 눌러 고르기(제스처를 뺏겨 pointerup 이 없다)와
  // 선택 손잡이 끌어 늘리기(손잡이는 뷰어 밖에 있어 pointerup 이 안 온다).
  // 실측: 이 둘로는 말풍선이 영영 안 떴다. 마우스로 끄는 중에는 건드리지 않는다
  // (끄는 내내 말풍선이 따라다니면 성가시고, 놓는 순간 위에서 띄운다).
  useEffect(() => {
    let timer = 0;
    const onChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        setPop(null);
        return;
      }
      if (dragging.current) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(showFromSelection, SELECT_SETTLE_MS);
    };
    document.addEventListener("selectionchange", onChange);
    return () => { document.removeEventListener("selectionchange", onChange); window.clearTimeout(timer); };
  }, [showFromSelection]);

  // 말풍선을 쓰면 브라우저 선택은 사라진다(다른 곳을 누르는 순간 어차피 풀린다).
  // 대신 그 자리를 자국으로 남겨 지금 무엇을 얹어 뒀는지 계속 보이게 한다.
  const usePop = (fn: (text: string, page: number, rects: PdfRect[]) => void) => {
    if (!pop) return;
    fn(pop.text, pop.page, pop.rects);
    setPop(null);
    window.getSelection()?.removeAllRanges();
  };

  const zoomIdx = zoom === "fit" ? -1 : ZOOMS.indexOf(zoom);
  const zoomOut = () => {
    const i = zoom === "fit" ? ZOOMS.findIndex((z) => z >= scale) : zoomIdx;
    changeZoom(ZOOMS[Math.max(0, (i < 0 ? ZOOMS.length : i) - 1)]);
  };
  const zoomIn = () => {
    const i = zoom === "fit" ? ZOOMS.findIndex((z) => z > scale) : zoomIdx + 1;
    changeZoom(ZOOMS[Math.min(ZOOMS.length - 1, i < 0 ? ZOOMS.length - 1 : i)]);
  };

  const total = sizes.length;

  return (
    <div className="card flex flex-col overflow-hidden">
      {/* 도구 줄 */}
      <div className="flex flex-wrap items-center gap-1 border-b border-line px-2 py-1.5">
        <div className="flex rounded-md border border-line p-0.5" role="radiogroup" aria-label="도구">
          <ToolBtn on={tool === "text"} onClick={() => setTool("text")} title="텍스트 선택 — 드래그한 글을 AI에 넣는다"><TextCursor size={14} /><span className="hidden xl:inline">텍스트</span></ToolBtn>
          <ToolBtn on={tool === "region"} onClick={() => setTool("region")} title="영역 선택 — 드래그한 부분을 그림으로 오려 AI에 넣는다"><BoxSelect size={14} /><span className="hidden xl:inline">영역</span></ToolBtn>
        </div>
        <span className="mx-1 h-5 w-px bg-line" />
        <button type="button" onClick={zoomOut} className="btn btn-ghost h-7 px-1.5" title="축소" aria-label="축소"><Minus size={14} /></button>
        <button type="button" onClick={() => changeZoom("fit")} className={`btn btn-ghost h-7 min-w-[3.5rem] px-1.5 text-[12px] tabular-nums ${zoom === "fit" ? "text-accent" : ""}`} title="폭 맞춤">
          {Math.round(scale * 100)}%
        </button>
        <button type="button" onClick={zoomIn} className="btn btn-ghost h-7 px-1.5" title="확대" aria-label="확대"><Plus size={14} /></button>
        <span className="mx-1 h-5 w-px bg-line" />
        <button type="button" onClick={() => scrollToPage(current - 1)} disabled={current <= 1} className="btn btn-ghost h-7 px-1.5" aria-label="이전 쪽"><ChevronUp size={14} /></button>
        <form className="flex items-center gap-1 text-[12px] tabular-nums" onSubmit={(e) => { e.preventDefault(); scrollToPage(Number(pageInput) || 1); }}>
          <input value={pageInput} onChange={(e) => setPageInput(e.target.value)} aria-label="쪽"
            className="input h-7 w-11 px-1 text-center text-[12px]" inputMode="numeric" />
          <span className="text-fg-muted">/ {total || "–"}</span>
        </form>
        <button type="button" onClick={() => scrollToPage(current + 1)} disabled={current >= total} className="btn btn-ghost h-7 px-1.5" aria-label="다음 쪽"><ChevronDown size={14} /></button>
        <span className="flex-1" />
        <button type="button" onClick={onClearContext} disabled={contextCount === 0}
          className="btn btn-ghost h-7 gap-1 px-2 text-[12px]" title="AI 입력에 얹힌 선택·영역을 모두 지운다">
          <Eraser size={14} /> 선택 지우기{contextCount > 0 && <span className="badge badge-accent px-1.5">{contextCount}</span>}
        </button>
        <a href={fileUrl} target="_blank" rel="noreferrer" className="btn btn-ghost h-7 px-1.5" title="새 탭에서 열기" aria-label="새 탭에서 열기"><ExternalLink size={14} /></a>
      </div>

      {/* 쪽들 */}
      <div ref={scrollRef} className={`relative flex-1 overflow-auto bg-subtle ${tool === "region" ? "select-none" : ""}`}>
        {error ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-[13px] text-fg-muted">
            <p>PDF를 열지 못했습니다.</p>
            <p className="text-[12px] text-fg-subtle">{error}</p>
            {/* 뷰어 부품(1MB 남짓)을 받다 실패한 것이면 다시 받으면 열린다.
                배포로 파일이 교체되는 몇 초에 걸린 경우가 그렇다. */}
            {/worker|dynamically imported|fetch/i.test(error) && (
              <p className="text-[12px] text-fg-subtle">
                뷰어 부품을 받지 못했습니다. 다시 시도하거나, 계속 그러면 새로고침(Ctrl+Shift+R) 해 주세요.
              </p>
            )}
            <div className="mt-2 flex gap-2">
              <button type="button" className="btn btn-secondary h-8" onClick={() => setReload((n) => n + 1)}>
                다시 시도
              </button>
              <a href={fileUrl} target="_blank" rel="noreferrer" className="btn btn-ghost h-8">새 탭에서 열기</a>
            </div>
          </div>
        ) : !pdf || !pdfjs ? (
          <div className="flex h-full items-center justify-center"><Loader2 size={22} className="animate-spin text-fg-muted" /></div>
        ) : (
          <div className="relative mx-auto" style={{ height: totalH, width: Math.max(maxW * scale + GAP * 2, containerW) }}>
            {sizes.map((s, i) => {
              const visible = i >= range[0] && i < range[1];
              return (
                <PageView key={i} pdf={pdf} pdfjs={pdfjs} num={i + 1} scale={scale} size={s} visible={visible}
                  top={tops[i]} left={(Math.max(maxW * scale + GAP * 2, containerW) - s.w * scale) / 2}
                  tool={tool} onRegion={onAddRegion} marks={marks.filter((m) => m.page === i + 1)} />
              );
            })}
          </div>
        )}
      </div>

      {/* 선택한 글 위의 말풍선 */}
      {pop && (
        <div role="toolbar" className="card fixed z-40 flex -translate-x-1/2 items-center gap-0.5 p-1 shadow-lg animate-in"
          style={{ left: Math.min(Math.max(pop.x, 120), window.innerWidth - 120), top: Math.min(pop.y, window.innerHeight - 48) }}
          onPointerDown={(e) => e.stopPropagation()}>
          <button type="button" className="btn btn-ghost h-7 gap-1 px-2 text-[12px]" onClick={() => usePop(onAddText)} title="AI 입력에 얹어 두고 이어서 쓴다">
            <MessageSquarePlus size={13} /> AI에 넣기
          </button>
          <button type="button" className="btn btn-ghost h-7 gap-1 px-2 text-[12px]" onClick={() => usePop((t, p, r) => onAskText(t, p, "이 부분을 쉽게 설명해줘. 핵심 주장과 이 논문에서의 역할을 짚어줘.", r))} title="바로 설명을 묻는다">
            <Sparkles size={13} /> 설명
          </button>
          <button type="button" className="btn btn-ghost h-7 gap-1 px-2 text-[12px]" onClick={() => usePop((t, p, r) => onAskText(t, p, "이 문장을 해석하고 문장 구조를 설명해줘. 어려운 단어와 전문 용어는 단어장 후보로 제안해줘.", r))} title="해석·문법 + 단어장 후보">
            <BookMarked size={13} /> 영어
          </button>
        </div>
      )}
      {tool === "region" && !error && pdf && (
        <div className="pointer-events-none absolute bottom-3 left-1/2 z-30 -translate-x-1/2 rounded-full border border-line bg-surface/95 px-3 py-1 text-[11.5px] text-fg-muted shadow-sm">
          <ScanSearch size={12} className="mr-1 inline" /> 드래그해서 그림·표·수식 영역을 오립니다
        </div>
      )}
    </div>
  );
}

function ToolBtn({ on, onClick, title, children }: { on: boolean; onClick: () => void; title: string; children: ReactNode }) {
  return (
    <button type="button" role="radio" aria-checked={on} onClick={onClick} title={title}
      className={`inline-flex h-6 items-center gap-1 rounded-sm px-1.5 text-[12px] ${on ? "bg-accent-muted text-accent-fg" : "text-fg-muted hover:bg-hovered hover:text-fg"}`}>
      {children}
    </button>
  );
}

// ── 한 쪽 ──
interface PageProps {
  pdf: PDFDocumentProxy;
  pdfjs: PdfJs;
  num: number;
  scale: number;
  size: Size;
  visible: boolean;
  top: number;
  left: number;
  tool: PdfTool;
  onRegion: (dataUrl: string, page: number, rect: PdfRect) => void;
  /** 이 쪽에 남길 선택 자국 */
  marks: PdfMark[];
}

function PageView({ pdf, pdfjs, num, scale, size, visible, top, left, tool, onRegion, marks }: PageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState(false);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const w = size.w * scale, h = size.h * scale;

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    let text: TextLayerT | null = null;
    setRendered(false);
    (async () => {
      const page = await pdf.getPage(num);
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      const textDiv = textRef.current;
      if (!canvas || !textDiv) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      task = page.render({ canvas, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
      await task.promise;
      if (cancelled) return;
      setRendered(true);
      textDiv.replaceChildren();
      text = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: textDiv, viewport });
      await text.render();
      if (cancelled) return;
      // 글 바깥에서 시작한 드래그도 선택되게(pdf.js 뷰어와 같은 장치)
      const end = document.createElement("div");
      end.className = "endOfContent";
      textDiv.append(end);
    })().catch((e) => {
      // 우리가 **일부러** 끊은 것들은 오류가 아니다. 폭을 바꾸거나 패널을 접으면
      // 보이던 쪽이 다시 그려지면서 매번 난다 — 콘솔에 쌓이면 진짜 오류가 묻힌다.
      // 렌더는 RenderingCancelledException, 글 레이어는 AbortException 으로 온다.
      const name = (e as { name?: string })?.name ?? "";
      if (e instanceof pdfjs.RenderingCancelledException
          || name === "RenderingCancelledException" || name === "AbortException") return;
      console.error(e);
    });
    return () => {
      cancelled = true;
      task?.cancel();
      text?.cancel();
    };
  }, [pdf, pdfjs, num, scale, visible]);

  // 안 보이는 쪽은 비운다(메모리). 다시 보이면 다시 그린다.
  useEffect(() => {
    if (visible) return;
    const c = canvasRef.current;
    if (c) { c.width = 0; c.height = 0; }
    textRef.current?.replaceChildren();
    setRendered(false);
  }, [visible]);

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.setPointerCapture(e.pointerId);
    const x = e.clientX - r.left, y = e.clientY - r.top;
    setDrag({ x0: x, y0: y, x1: x, y1: y });
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const r = e.currentTarget.getBoundingClientRect();
    setDrag({ ...drag, x1: Math.min(Math.max(e.clientX - r.left, 0), w), y1: Math.min(Math.max(e.clientY - r.top, 0), h) });
  };
  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* 이미 풀림 */ }
    const x = Math.min(drag.x0, drag.x1), y = Math.min(drag.y0, drag.y1);
    const rw = Math.abs(drag.x1 - drag.x0), rh = Math.abs(drag.y1 - drag.y0);
    setDrag(null);
    const canvas = canvasRef.current;
    if (!canvas || !canvas.width || rw < 8 || rh < 8) return;
    const sx = canvas.width / w, sy = canvas.height / h;
    const cw = Math.round(rw * sx), ch = Math.round(rh * sy);
    const k = Math.min(1, MAX_REGION_PX / Math.max(cw, ch));
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(cw * k));
    out.height = Math.max(1, Math.round(ch * k));
    const ctx = out.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(canvas, Math.round(x * sx), Math.round(y * sy), cw, ch, 0, 0, out.width, out.height);
    onRegion(out.toDataURL("image/png"), num, { x: x / scale, y: y / scale, w: rw / scale, h: rh / scale });
  };

  const rect = drag ? {
    left: Math.min(drag.x0, drag.x1), top: Math.min(drag.y0, drag.y1),
    width: Math.abs(drag.x1 - drag.x0), height: Math.abs(drag.y1 - drag.y0),
  } : null;

  return (
    <div data-page={num} className="pdfPage absolute bg-white shadow-md"
      style={{ top, left, width: w, height: h, ["--scale-factor" as string]: String(scale) }}>
      <canvas ref={canvasRef} className="block h-full w-full" />
      <div ref={textRef} className="textLayer" />
      {/* AI 입력에 얹어 둔 선택의 자국. 칩을 빼면 같이 사라진다. */}
      {marks.map((m) =>
        m.rects.map((r, i) => (
          <div key={`${m.id}:${i}`} aria-hidden
            className={`pointer-events-none absolute z-[5] rounded-[2px] ${
              m.kind === "region" ? "border-2 border-accent bg-accent/10" : "bg-accent/25 mix-blend-multiply"}`}
            style={{ left: r.x * scale, top: r.y * scale, width: r.w * scale, height: r.h * scale }} />
        )),
      )}
      {visible && !rendered && (
        <div className="absolute inset-0 grid place-items-center text-fg-subtle"><Loader2 size={18} className="animate-spin" /></div>
      )}
      {tool === "region" && (
        <div className="absolute inset-0 z-10 cursor-crosshair touch-none"
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => setDrag(null)}>
          {rect && (
            <div className="absolute border-2 border-accent bg-accent/15" style={rect} />
          )}
        </div>
      )}
    </div>
  );
}
