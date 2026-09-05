import { PointerEvent as ReactPointerEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask, TextLayer as TextLayerT } from "pdfjs-dist";
import {
  BoxSelect, ChevronDown, ChevronUp, Eraser, ExternalLink, Loader2, MessageSquarePlus,
  Minus, Plus, ScanSearch, Sparkles, TextCursor, BookMarked,
} from "lucide-react";
import { loadPdfJs, PdfJs } from "../../lib/pdfjs";

export type PdfTool = "text" | "region";

interface Props {
  paperId: string;
  fileUrl: string;
  /** 마지막으로 읽던 쪽 — 열 때 거기로 간다 */
  initialPage?: number;
  onPageChange?: (page: number, total: number) => void;
  /** 드래그로 고른 글을 AI 입력에 얹는다 */
  onAddText: (text: string, page: number) => void;
  /** 고른 글을 얹고 바로 묻는다 */
  onAskText: (text: string, page: number, prompt: string) => void;
  /** 영역 도구로 오린 그림(PNG data URL) */
  onAddRegion: (dataUrl: string, page: number) => void;
  /** 지금 AI 입력에 얹힌 첨부·선택 수 — "선택 모두 지우기" 버튼 */
  contextCount: number;
  onClearContext: () => void;
}

const GAP = 16;
const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 2.5, 3];
const MAX_REGION_PX = 1600;

type Size = { w: number; h: number };

/**
 * 연속 스크롤 PDF 뷰어(pdf.js). 보이는 쪽만 그린다.
 * 도구: 텍스트 선택(드래그 → "AI에 넣기" 말풍선) · 영역 선택(드래그 → 그림으로 오려 AI 첨부).
 */
export function PdfViewer({
  paperId, fileUrl, initialPage = 1, onPageChange, onAddText, onAskText, onAddRegion,
  contextCount, onClearContext,
}: Props) {
  const [pdfjs, setPdfjs] = useState<PdfJs | null>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<Size[]>([]);
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [tool, setTool] = useState<PdfTool>("text");
  const [containerW, setContainerW] = useState(0);
  const [range, setRange] = useState<[number, number]>([0, 1]);
  const [current, setCurrent] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [pop, setPop] = useState<{ x: number; y: number; text: string; page: number } | null>(null);
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
  }, [fileUrl, paperId]);

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
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onDown = (e: PointerEvent) => {
      setPop(null);
      const layer = (e.target as HTMLElement).closest?.(".textLayer");
      if (layer) el.querySelectorAll(".textLayer").forEach((l) => l.classList.add("selecting"));
    };
    const onUp = () => {
      el.querySelectorAll(".textLayer").forEach((l) => l.classList.remove("selecting"));
      if (tool !== "text") return;
      setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);
        const anchor = range.commonAncestorContainer;
        const node = anchor.nodeType === 1 ? (anchor as HTMLElement) : anchor.parentElement;
        if (!node || !el.contains(node)) return;
        const text = sel.toString().replace(/\s+/g, " ").trim();
        if (!text) return;
        const start = range.startContainer.nodeType === 1 ? (range.startContainer as HTMLElement) : range.startContainer.parentElement;
        const page = Number(start?.closest<HTMLElement>("[data-page]")?.dataset.page ?? current);
        const r = range.getBoundingClientRect();
        setPop({ x: r.left + r.width / 2, y: r.bottom + 8, text, page });
      }, 0);
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    return () => { el.removeEventListener("pointerdown", onDown); el.removeEventListener("pointerup", onUp); };
  }, [tool, current]);

  useEffect(() => {
    const onChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setPop(null);
    };
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  }, []);

  const usePop = (fn: (text: string, page: number) => void) => {
    if (!pop) return;
    fn(pop.text, pop.page);
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
            <a href={fileUrl} target="_blank" rel="noreferrer" className="btn btn-secondary mt-2 h-8">새 탭에서 열기</a>
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
                  tool={tool} onRegion={onAddRegion} />
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
          <button type="button" className="btn btn-ghost h-7 gap-1 px-2 text-[12px]" onClick={() => usePop((t, p) => onAskText(t, p, "이 부분을 쉽게 설명해줘. 핵심 주장과 이 논문에서의 역할을 짚어줘."))} title="바로 설명을 묻는다">
            <Sparkles size={13} /> 설명
          </button>
          <button type="button" className="btn btn-ghost h-7 gap-1 px-2 text-[12px]" onClick={() => usePop((t, p) => onAskText(t, p, "이 문장을 해석하고 문장 구조를 설명해줘. 어려운 단어는 단어장 후보로 제안해줘."))} title="해석·문법 + 단어장 후보">
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
  onRegion: (dataUrl: string, page: number) => void;
}

function PageView({ pdf, pdfjs, num, scale, size, visible, top, left, tool, onRegion }: PageProps) {
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
      if (!(e instanceof pdfjs.RenderingCancelledException)) console.error(e);
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
    onRegion(out.toDataURL("image/png"), num);
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
