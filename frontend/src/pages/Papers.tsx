import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { BookMarked, FileText, Info, List, MessageSquare, Trash2 } from "lucide-react";
import { Shell } from "../components/layout/Shell";
import { ThreePane } from "../components/notes/ThreePane";
import { ChatPanel, ChatPanelHandle, ChatAttachment, ChatSelection } from "../components/ai/ChatPanel";
import { PaperList, paperTitle } from "../components/papers/PaperList";
import { PdfViewer, PdfMark, PdfRect } from "../components/papers/PdfViewer";
import { PaperInfo } from "../components/papers/PaperInfo";
import { VocabPanel } from "../components/vocab/VocabPanel";
import { api, Paper } from "../lib/api";
import { toast } from "../store/toast";

const SUGGESTIONS = [
  "이 논문을 3줄로 요약해줘",
  "핵심 기여와 기존 연구와의 차이를 설명해줘",
  "실험 설계와 결과를 정리해줘",
  "이 논문의 핵심 용어·어려운 단어를 단어장 후보로 뽑아줘",
];

type Tab = "chat" | "info" | "vocab";
const uid = () => Math.random().toString(36).slice(2, 10);

/**
 * 논문 리뷰: 왼쪽 목록 · 가운데 PDF · 오른쪽 AI(대화 / 정보 / 단어장).
 * PDF 에서 고른 글·오린 영역은 AI 입력 위에 칩으로 쌓이고 보낼 때 같이 간다.
 */
export function Papers() {
  const [papers, setPapers] = useState<Paper[] | null>(null);
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("p") ?? "";
  const selected = papers?.find((p) => p.id === selectedId) ?? null;
  const [uploading, setUploading] = useState(0);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [selections, setSelections] = useState<ChatSelection[]>([]);
  // PDF 위에 남기는 선택 자국. 칩과 id 를 공유해서 칩을 빼면 자국도 사라진다.
  const [marks, setMarks] = useState<PdfMark[]>([]);
  const [tab, setTab] = useState<Tab>("chat");
  const [vocabKey, setVocabKey] = useState(0);
  const [pendingAsk, setPendingAsk] = useState<string | null>(null);
  const chat = useRef<ChatPanelHandle>(null);

  const select = useCallback((id: string) => {
    setParams((prev) => {
      const n = new URLSearchParams(prev);
      if (id) n.set("p", id); else n.delete("p");
      return n;
    }, { replace: true });
  }, [setParams]);

  const load = useCallback(async () => {
    try {
      setPapers(await api.paperList());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "논문 목록을 못 받았습니다");
      setPapers([]);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // 추출 중인 논문이 있으면 잠깐씩 다시 받는다(끝나면 제목·요약이 채워진다)
  const anyPending = !!papers?.some((p) => p.status === "pending");
  useEffect(() => {
    if (!anyPending) return;
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [anyPending, load]);

  // 논문을 바꾸면 얹어 둔 선택은 그 논문 것이라 같이 비운다
  useEffect(() => { setAttachments([]); setSelections([]); setMarks([]); }, [selectedId]);

  const patch = (id: string, p: Partial<Paper>) =>
    setPapers((arr) => (arr ? arr.map((x) => (x.id === id ? { ...x, ...p } : x)) : arr));

  const upload = async (files: File[]) => {
    setUploading((n) => n + files.length);
    let first = "";
    for (const f of files) {
      try {
        const p = await api.paperUpload(f);
        setPapers((arr) => [p, ...(arr ?? []).filter((x) => x.id !== p.id)]);
        if (!first) first = p.id;
      } catch (e) {
        toast.error(`${f.name}: ${e instanceof Error ? e.message : "올리지 못했습니다"}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
    if (first && !selectedId) select(first);
    if (first) toast.ok(files.length > 1 ? `${files.length}개 올렸습니다. AI가 정보를 읽습니다.` : "올렸습니다. AI가 정보를 읽습니다.");
  };

  const update = async (p: Paper, body: Partial<Paper>) => {
    try {
      const next = await api.paperUpdate(p.id, body);
      patch(p.id, next);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "저장 실패");
    }
  };

  const remove = async (p: Paper) => {
    if (!confirm(`"${paperTitle(p)}"을(를) 휴지통으로 보낼까요? 대화 기록도 같이 갑니다.`)) return;
    try {
      await api.paperDelete(p.id);
      setPapers((arr) => (arr ? arr.filter((x) => x.id !== p.id) : arr));
      if (p.id === selectedId) select("");
      toast.ok("휴지통으로 보냈습니다");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "삭제 실패");
    }
  };

  const retry = async (p: Paper) => {
    try {
      const r = await api.paperExtract(p.id);
      patch(p.id, { status: r.status as Paper["status"], error: "" });
      toast.ok(r.started ? "다시 읽기 시작했습니다" : "이미 읽는 중입니다");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "요청 실패");
    }
  };

  // 읽던 쪽 저장 — 스크롤마다 쓰지 않고 멈춘 뒤 한 번
  const readTimer = useRef<number>(0);
  const onPageChange = useCallback((page: number) => {
    // 먼저 취소한다 — 열자마자 1쪽이 잡혔다가 읽던 쪽으로 튀는데, 그 1쪽 저장이 남으면 안 된다
    window.clearTimeout(readTimer.current);
    if (!selected || selected.read_page === page) return;
    readTimer.current = window.setTimeout(() => {
      api.paperUpdate(selected.id, { read_page: page }).then((n) => patch(selected.id, { read_page: n.read_page })).catch(() => {});
    }, 1500);
  }, [selected]);
  useEffect(() => () => window.clearTimeout(readTimer.current), []);

  const addText = useCallback((text: string, page: number, rects: PdfRect[] = []) => {
    const id = uid();
    setSelections((s) => [...s, { id, text, page }]);
    if (rects.length) setMarks((m) => [...m, { id, page, kind: "text", rects }]);
    setTab("chat");
  }, []);
  const askText = useCallback((text: string, page: number, prompt: string, rects: PdfRect[] = []) => {
    addText(text, page, rects);
    setPendingAsk(prompt);
  }, [addText]);
  const addRegion = useCallback((dataUrl: string, page: number, rect: PdfRect) => {
    const id = uid();
    setAttachments((a) => [...a, { id, mime: "image/png", data: dataUrl, label: `${page}쪽 영역` }]);
    setMarks((m) => [...m, { id, page, kind: "region", rects: [rect] }]);
    setTab("chat");
    toast.ok(`${page}쪽 영역을 AI 입력에 얹었습니다`);
  }, []);
  const dropMark = useCallback((id: string) => setMarks((m) => m.filter((x) => x.id !== id)), []);
  // 선택이 상태에 반영된 다음 보내야 그 선택이 같이 간다
  useEffect(() => {
    if (pendingAsk === null) return;
    chat.current?.send(pendingAsk);
    setPendingAsk(null);
  }, [pendingAsk, selections]);

  // 이 논문에서 넣는 단어에 붙는 태그. 배열 정체성이 매번 바뀌면 아래 패널의
  // 폼이 입력 중에 초기화되므로 제목이 바뀔 때만 새로 만든다.
  const vocabTags = useMemo(() => (selected?.title ? [selected.title] : []), [selected?.title]);

  const clearContext = useCallback(() => { setAttachments([]); setSelections([]); setMarks([]); }, []);
  const contextCount = attachments.length + selections.length;

  const ask = (text: string) => { setTab("chat"); chat.current?.send(text); };

  const clearChat = async () => {
    if (!selected || !confirm("이 논문의 대화를 모두 지울까요?")) return;
    try {
      await chat.current?.clear();
      toast.ok("대화를 비웠습니다");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "지우지 못했습니다");
    }
  };

  const actions = (
    <>
      {selected && (
        <button onClick={() => select("")} className="btn btn-ghost h-8 gap-1 px-2 text-[12px] lg:hidden" title="목록으로">
          <List size={14} /> 목록
        </button>
      )}
      {selected && (
        <button onClick={clearChat} className="btn btn-ghost h-8 px-2" title="이 논문의 대화 비우기" aria-label="대화 비우기">
          <Trash2 size={15} />
        </button>
      )}
    </>
  );

  return (
    <Shell title="논문" actions={actions}>
      <ThreePane storageKey="papers.panes.v1" showDetail={!!selected}>
        <PaperList papers={papers ?? []} selectedId={selectedId} onSelect={select} onUpload={upload}
          onStar={(p) => update(p, { starred: !p.starred })} onDelete={remove} onRetry={retry}
          uploading={uploading} className="h-view-11 lg:h-auto" />

        {selected ? (
          <div className="flex h-view-11 flex-col lg:h-auto [&>*]:min-h-0 [&>*]:flex-1">
            <PdfViewer key={selected.id} paperId={selected.id} fileUrl={api.paperFileUrl(selected.id)}
              initialPage={selected.read_page || 1} onPageChange={onPageChange}
              onAddText={addText} onAskText={askText} onAddRegion={addRegion} marks={marks}
              contextCount={contextCount} onClearContext={clearContext} />
          </div>
        ) : (
          <div className="card flex h-view-11 flex-col items-center justify-center gap-2 text-center text-[13px] text-fg-muted lg:h-auto">
            <FileText size={28} className="text-fg-subtle" />
            <p>왼쪽에서 논문을 고르거나 PDF를 끌어다 놓으세요.</p>
            <p className="text-[12px] text-fg-subtle">글을 드래그하면 AI에 넣을 수 있고, 영역 도구로 그림·표·수식을 오려 물어볼 수 있습니다.</p>
          </div>
        )}

        <div className="card flex h-view-11 flex-col overflow-hidden lg:h-auto">
          <div className="flex shrink-0 border-b border-line px-1" role="tablist">
            <TabBtn on={tab === "chat"} onClick={() => setTab("chat")} icon={<MessageSquare size={13} />} label="대화" badge={contextCount || undefined} />
            <TabBtn on={tab === "info"} onClick={() => setTab("info")} icon={<Info size={13} />} label="정보" />
            <TabBtn on={tab === "vocab"} onClick={() => setTab("vocab")} icon={<BookMarked size={13} />} label="단어장" />
          </div>
          {/* 대화는 탭을 옮겨도 살아 있어야 한다(스트리밍 중일 수 있다) — 숨기기만 한다 */}
          <div className={`min-h-0 flex-1 flex-col p-3 ${tab === "chat" ? "flex" : "hidden"}`}>
            {selected ? (
              <ChatPanel ref={chat} className="flex-1" mode="paper" paperId={selected.id} space={`paper:${selected.id}`}
                vocabTags={vocabTags}
                suggestions={SUGGESTIONS} attachments={attachments} selections={selections}
                onRemoveAttachment={(id) => { setAttachments((a) => a.filter((x) => x.id !== id)); dropMark(id); }}
                onRemoveSelection={(id) => { setSelections((s) => s.filter((x) => x.id !== id)); dropMark(id); }}
                onClearContext={clearContext}
                emptyTitle={paperTitle(selected)}
                emptySubtitle="논문 본문·정보·다른 논문에서 나눈 대화까지 보고 답합니다"
                placeholder="논문에 대해 물어보세요… (글을 드래그하거나 영역을 오려 붙일 수 있어요)"
                onToolSuccess={(m) => { if (m === "vocab") setVocabKey((k) => k + 1); if (m === "paper") void load(); }} />
            ) : (
              <div className="flex flex-1 items-center justify-center text-[12.5px] text-fg-muted">논문을 고르면 대화가 열립니다</div>
            )}
          </div>
          {tab === "info" && (
            selected ? (
              <PaperInfo paper={selected} onUpdate={(b) => update(selected, b)} onAsk={ask} onRetry={() => retry(selected)} />
            ) : <div className="flex flex-1 items-center justify-center text-[12.5px] text-fg-muted">논문을 고르세요</div>
          )}
          {tab === "vocab" && (
            <VocabPanel refreshKey={vocabKey} initialTag={selected?.title || ""}
              defaultTags={vocabTags}
              className="min-h-0 flex-1 rounded-none border-0" />
          )}
        </div>
      </ThreePane>
    </Shell>
  );
}

function TabBtn({ on, onClick, icon, label, badge }: { on: boolean; onClick: () => void; icon: ReactNode; label: string; badge?: number }) {
  return (
    <button type="button" role="tab" aria-selected={on} onClick={onClick}
      className={`-mb-px inline-flex items-center gap-1 border-b-2 px-3 py-2 text-[12.5px] ${on ? "border-accent text-accent-fg" : "border-transparent text-fg-muted hover:text-fg"}`}>
      {icon} {label}
      {badge ? <span className="badge badge-accent ml-0.5 px-1.5 py-0 text-[10.5px]">{badge}</span> : null}
    </button>
  );
}
