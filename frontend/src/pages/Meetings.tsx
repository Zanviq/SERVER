import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  AudioLines, Bot, ChevronLeft, Eye, FileText, List, Loader2, MoreHorizontal, Pencil, Plus, RefreshCw, Save, Trash2,
} from "lucide-react";
import { Shell } from "../components/layout/Shell";
import { ThreePane } from "../components/notes/ThreePane";
import { ChatPanel, ChatPanelHandle } from "../components/ai/ChatPanel";
import { LiveEditor } from "../components/notes/LazyLiveEditor";
import { MarkdownView } from "../components/notes/LazyMarkdownView";
import { Modal } from "../components/ui/Modal";
import { Dropdown, DropdownItem } from "../components/ui/Dropdown";
import { MeetingList, meetingTitle } from "../components/meetings/MeetingList";
import { Recorder } from "../components/meetings/Recorder";
import { TranscriptView } from "../components/meetings/TranscriptView";
import { api, Meeting, MeetingDocSummary } from "../lib/api";
import { toast } from "../store/toast";
import { useSettings } from "../store/settings";
import { ApiError } from "../lib/api";
import { LatestWins, PendingSave } from "../lib/pendingSave";
import { Draft, draftAgeText, dropDraft, keepDraft, readDraft } from "../lib/draftBackup";

/** 밑글 키. 회의 문서는 회의마다 같은 이름('요약')을 쓸 수 있어 id 를 함께 넣는다. */
const docKey = (id: string, name: string) => `meeting/${id}/${name}`;

const SUGGESTIONS = [
  "이 회의를 3줄로 요약해줘",
  "결정 사항과 할 일을 정리한 문서를 만들어줘",
  "화자별로 무슨 말을 했는지 정리해줘",
  "회의록 형식으로 정리해서 문서로 만들어줘",
];

const TRANSCRIPT_TAB = "\0transcript";

/**
 * 회의 녹음: 왼쪽 목록(날짜·카테고리) · 가운데 원본 받아쓰기와 문서 편집 · 오른쪽 AI.
 * 문서는 노트와 같은 편집기를 쓰지만 저장 공간은 회의 폴더 안에 따로 있다.
 */
export function Meetings() {
  const autosaveMs = useSettings((st) => st.settings?.notes.autosave_ms ?? 900);
  const [meetings, setMeetings] = useState<Meeting[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);   // 목록을 못 받아왔는가
  const [categories, setCategories] = useState<string[]>([]);
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("m") ?? "";
  const selected = meetings?.find((m) => m.id === selectedId) ?? null;
  const [uploading, setUploading] = useState(0);
  const [recOpen, setRecOpen] = useState(false);
  const chat = useRef<ChatPanelHandle>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  // 문서 편집 상태 — 노트 화면과 같은 규칙(자동저장 하나, 마지막 열기만 유효)
  const [docs, setDocs] = useState<MeetingDocSummary[]>([]);
  const [tab, setTab] = useState<string>(TRANSCRIPT_TAB);
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  // 서버에 닿지 못한 회의 문서 편집(노트와 같은 장치). 회의 id + 문서 이름으로 키를 만든다.
  const [draft, setDraft] = useState<Draft | null>(null);
  // 다른 곳(다른 기기 또는 AI)이 같은 문서를 고쳤다
  const [conflict, setConflict] = useState(false);
  // 문서를 연 시점의 수정시각(문서별). 저장할 때 함께 보내 충돌을 잡는다.
  const baseRef = useRef<Record<string, number>>({});
  const [saving, setSaving] = useState(false);
  const [reading, setReading] = useState(false);
  const [newDocOpen, setNewDocOpen] = useState(false);
  const [newDocName, setNewDocName] = useState("");
  const [renameFor, setRenameFor] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");
  const pendingRef = useRef<PendingSave>();
  const pending = (pendingRef.current ??= new PendingSave());
  const openSeqRef = useRef<LatestWins>();
  const openSeq = (openSeqRef.current ??= new LatestWins());
  const docOpen = tab !== TRANSCRIPT_TAB;

  const select = useCallback((id: string) => {
    setParams((prev) => {
      const n = new URLSearchParams(prev);
      if (id) n.set("m", id); else n.delete("m");
      return n;
    }, { replace: true });
  }, [setParams]);

  const load = useCallback(async () => {
    try {
      const [list, cats] = await Promise.all([api.meetingList(), api.meetingCategories()]);
      setMeetings(list);
      setCategories(cats);
      setLoadFailed(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "회의 목록을 못 받았습니다");
      // 빈 목록만 두면 토스트가 사라진 뒤 "녹음 파일을 끌어다 놓으세요"만 남아
      // 회의가 다 사라진 것처럼 보인다.
      setMeetings([]);
      setLoadFailed(true);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // 받아쓰는 중인 회의가 있으면 잠깐씩 다시 받는다(끝나면 요약·원본이 채워진다)
  const anyPending = !!meetings?.some((m) => m.status === "pending");
  useEffect(() => {
    if (!anyPending) return;
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [anyPending, load]);

  const patch = (id: string, p: Partial<Meeting>) =>
    setMeetings((arr) => (arr ? arr.map((x) => (x.id === id ? { ...x, ...p } : x)) : arr));

  // ── 문서 ──
  const loadDocs = useCallback(async (id: string) => {
    if (!id) { setDocs([]); return []; }
    try {
      const d = await api.meetingDocs(id);
      setDocs(d);
      return d;
    } catch {
      setDocs([]);
      return [];
    }
  }, []);

  const flushPendingSave = useCallback(async () => {
    const ok = await pending.flush();
    if (!ok) toast.error("저장하지 못한 문서가 있습니다. 다시 시도하세요.");
    return ok;
  }, [pending]);

  const saveDoc = useCallback(async (id: string, name: string, text: string): Promise<boolean> => {
    setSaving(true);
    try {
      // 이 문서를 연 시점의 수정시각을 함께 보낸다. 사람과 AI 가 같은 문서를
      // 쓰는 자리라, 말없이 덮이면 어느 쪽 글이 사라졌는지도 모른다.
      const key = docKey(id, name);
      const r = await api.meetingDocWrite(id, name, text, baseRef.current[key] ?? 0);
      baseRef.current[key] = r.updated_at;
      setDirty(false);
      dropDraft(key);   // 서버에 닿았으니 밑글은 필요 없다
      setDraft(null);
      setConflict(false);
      setDocs((ds) => ds.map((d) => (d.name === name ? { ...d, updated_at: r.updated_at, size: text.length } : d)));
      return true;
    } catch (e) {
      // 409 = 다른 곳에서 바뀌었다. 자동저장이 1초마다 같은 토스트를 쏟지 않게
      // 띠로 알리고, 덮어쓸지는 사용자가 고른다(노트와 같은 규칙).
      if (e instanceof ApiError && e.status === 409) {
        setConflict(true);
        return false;
      }
      toast.error(e instanceof Error ? e.message : "저장 실패");
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  const openDoc = useCallback(async (id: string, name: string) => {
    const token = openSeq.begin();
    await flushPendingSave();
    setTab(name);
    setReading(false);
    try {
      const d = await api.meetingDocRead(id, name);
      if (!openSeq.isCurrent(token)) return;
      setContent(d.content);
      setDirty(false);
      setDraft(readDraft(docKey(id, name), d.content));
      baseRef.current[docKey(id, name)] = d.updated_at;
      setConflict(false);
    } catch (e) {
      if (!openSeq.isCurrent(token)) return;
      toast.error(e instanceof Error ? e.message : "문서를 못 열었습니다");
      setTab(TRANSCRIPT_TAB);
    }
  }, [flushPendingSave, openSeq]);

  const showTranscript = useCallback(() => {
    void flushPendingSave();
    openSeq.abandonAll();
    setTab(TRANSCRIPT_TAB);
    setContent("");
    setDirty(false);
    setDraft(null);   // 원본 탭에는 띠가 뜰 일이 없다
  }, [flushPendingSave, openSeq]);

  // 회의를 바꾸면 문서 목록을 새로 받고 원본 탭으로 돌아간다
  useEffect(() => {
    showTranscript();
    void loadDocs(selectedId);
  }, [selectedId, loadDocs, showTranscript]);
  useEffect(() => () => { void pending.flush(); }, [pending]);

  // 저장되지 않은 편집이 있는 채로 창을 닫으려 하면 되묻는다(노트와 같다).
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const onEdit = (text: string) => {
    setContent(text);
    setDirty(true);
    if (!selectedId || !docOpen) return;
    const id = selectedId, name = tab;
    keepDraft(docKey(id, name), text);   // 자동저장이 뜨기 전에 끊겨도 남게
    pending.schedule(autosaveMs, () => saveDoc(id, name, text));
  };

  /** AI 가 문서를 만들거나 고쳤다 — 목록을 새로 받고, 열어 둔 문서가 바뀌었으면 다시 읽는다 */
  const onMutated = useCallback(async (what: string) => {
    if (what !== "meetings") return;
    void load();
    const next = await loadDocs(selectedId);
    if (!docOpen) return;
    const mine = next.find((d) => d.name === tab);
    const before = docs.find((d) => d.name === tab);
    if (!mine) { showTranscript(); return; }
    if (!dirty && !pending.scheduled && mine.updated_at !== before?.updated_at) {
      void openDoc(selectedId, tab);
    }
  }, [load, loadDocs, selectedId, docOpen, tab, docs, dirty, pending, openDoc, showTranscript]);

  const createDoc = async () => {
    const name = newDocName.trim();
    if (!name || !selectedId) return;
    setNewDocOpen(false);
    setNewDocName("");
    try {
      const r = await api.meetingDocWrite(selectedId, name, "");
      await loadDocs(selectedId);
      patch(selectedId, { docs: (selected?.docs ?? 0) + (r.created ? 1 : 0) });
      await openDoc(selectedId, r.name);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "문서를 못 만들었습니다");
    }
  };

  const doRename = async () => {
    const next = renameName.trim();
    if (!renameFor || !next || !selectedId) return;
    if (tab === renameFor && !(await flushPendingSave())) return;
    setRenameFor(null);
    try {
      const r = await api.meetingDocRename(selectedId, renameFor, next);
      await loadDocs(selectedId);
      if (tab === renameFor) setTab(r.name);
      toast.ok("이름을 바꿨습니다");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "이름을 못 바꿨습니다");
    }
  };

  const deleteDoc = async (name: string) => {
    if (!selectedId || !confirm(`"${name}" 문서를 지울까요? 되돌릴 수 없습니다.`)) return;
    if (tab === name) pending.cancel(); // 남은 타이머가 지운 문서를 되살리지 않게
    try {
      await api.meetingDocDelete(selectedId, name);
      dropDraft(docKey(selectedId, name));   // 지운 문서가 밑글로 되살아나면 안 된다
      if (tab === name) showTranscript();
      await loadDocs(selectedId);
      patch(selectedId, { docs: Math.max(0, (selected?.docs ?? 1) - 1) });
      toast.ok("지웠습니다");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "지우지 못했습니다");
    }
  };

  // ── 회의 ──
  /**
   * 녹음을 올린다. **하나라도 실패하면 false.**
   *
   * 예전에는 실패를 토스트로만 흘리고 늘 성공처럼 돌아왔다. 파일 올리기는 원본이
   * 디스크에 남아 있으니 그래도 됐지만, **녹음 창은 그 값을 보고 창을 닫는다** —
   * 녹음은 메모리에만 있어서 한 시간짜리 회의가 통째로 사라졌다.
   */
  const upload = async (files: File[], meta: { title?: string; category?: string; day?: string } = {}) => {
    setUploading((n) => n + files.length);
    let first = "";
    let allOk = true;
    for (const f of files) {
      try {
        const m = await api.meetingUpload(f, meta);
        setMeetings((arr) => [m, ...(arr ?? []).filter((x) => x.id !== m.id)]);
        if (!first) first = m.id;
      } catch (e) {
        allOk = false;
        toast.error(`${f.name}: ${e instanceof Error ? e.message : "올리지 못했습니다"}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
    if (first) {
      select(first);
      toast.ok("올렸습니다. AI가 받아쓰는 중입니다.");
      void load(); // 정렬(날짜순)·카테고리 목록을 서버 기준으로
    }
    return allOk;
  };

  const update = async (m: Meeting, body: Parameters<typeof api.meetingUpdate>[1]) => {
    try {
      const next = await api.meetingUpdate(m.id, body);
      patch(m.id, next);
      if (body.category !== undefined || body.date !== undefined) void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "저장 실패");
    }
  };

  const remove = async (m: Meeting) => {
    if (!confirm(`"${meetingTitle(m)}"을(를) 휴지통으로 보낼까요? 원본·문서·대화가 같이 갑니다.`)) return;
    try {
      await api.meetingDelete(m.id);
      setMeetings((arr) => (arr ? arr.filter((x) => x.id !== m.id) : arr));
      if (m.id === selectedId) select("");
      toast.ok("휴지통으로 보냈습니다");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "삭제 실패");
    }
  };

  const retry = async (m: Meeting) => {
    try {
      const r = await api.meetingTranscribe(m.id);
      patch(m.id, { status: r.status as Meeting["status"], error: "" });
      toast.ok(r.started ? "다시 받아쓰기 시작했습니다" : "이미 받아쓰는 중입니다");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "요청 실패");
    }
  };

  const seek = (sec: number) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = sec;
    void a.play().catch(() => {});
  };
  // MediaRecorder 가 만든 webm 은 길이 정보가 없어 duration 이 Infinity 로 온다 —
  // 끝으로 한 번 보냈다 돌아오면 브라우저가 길이를 알아낸다.
  const onAudioMeta = () => {
    const a = audioRef.current;
    if (!a || a.duration !== Infinity) return;
    const back = () => { a.currentTime = 0; a.removeEventListener("timeupdate", back); };
    a.addEventListener("timeupdate", back);
    a.currentTime = 1e101;
  };

  const clearChat = async () => {
    if (!selected || !confirm("이 회의의 대화를 모두 지울까요?")) return;
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
        <button onClick={clearChat} className="btn btn-ghost h-8 px-2" title="이 회의의 대화 비우기" aria-label="대화 비우기">
          <Trash2 size={15} />
        </button>
      )}
    </>
  );

  return (
    <Shell title="회의" actions={actions}>
      <ThreePane storageKey="meetings.panes.v1" showDetail={!!selected} fixedLabel="회의 목록" sideLabel="AI 패널" centerLabel="회의">
        <MeetingList meetings={meetings ?? []} failed={loadFailed} onReload={() => void load()}
          categories={categories} selectedId={selectedId} onSelect={select}
          onRecord={() => setRecOpen(true)} onUpload={(fs) => upload(fs)} onDelete={remove} onRetry={retry}
          uploading={uploading} className="h-view-11 lg:h-auto" />

        {selected ? (
          <div className="card relative flex h-view-11 flex-col overflow-hidden lg:h-auto lg:min-h-0">
            <MeetingHeader key={selected.id} meeting={selected} categories={categories}
              onBack={() => select("")} onUpdate={(b) => update(selected, b)} onRetry={() => retry(selected)} />
            <div className="shrink-0 border-b border-line px-3 py-2">
              {/* 원본은 그대로 둔다 — 문서를 아무리 만들어도 녹음은 여기 있다 */}
              <audio ref={audioRef} controls preload="metadata" src={api.meetingAudioUrl(selected.id)}
                onLoadedMetadata={onAudioMeta} className="h-9 w-full" />
            </div>
            <div className="flex shrink-0 items-center border-b border-line px-1" role="tablist">
              <div className="flex min-w-0 flex-1 overflow-x-auto">
                <TabBtn on={!docOpen} onClick={showTranscript} icon={<AudioLines size={13} />} label="원본" />
                {docs.map((d) => (
                  <TabBtn key={d.name} on={tab === d.name} onClick={() => { if (tab !== d.name) void openDoc(selected.id, d.name); }}
                    icon={<FileText size={13} />} label={d.name} />
                ))}
                <button type="button" onClick={() => setNewDocOpen(true)} title="새 문서"
                  className="inline-flex items-center gap-1 px-2 py-2 text-[12px] text-fg-muted hover:text-fg">
                  <Plus size={13} /> 새 문서
                </button>
              </div>
              {docOpen && (
                <div className="flex shrink-0 items-center gap-1 pl-1">
                  {saving ? <Loader2 size={13} className="animate-spin text-fg-muted" />
                    : dirty ? <Save size={13} className="text-warning" />
                    : <span className="label text-positive">저장됨</span>}
                  <button
                    onClick={() => setReading((v) => !v)}
                    title="편집 / 읽기 전환"
                    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors ${
                      reading ? "border-accent/40 bg-accent-muted text-accent-fg" : "border-line text-fg-muted hover:text-fg"
                    }`}>
                    {reading ? <><Eye size={11} /> 읽기</> : <><Pencil size={11} /> 편집</>}
                  </button>
                  <Dropdown align="end" width={150} className="btn btn-ghost h-7 px-2" trigger={() => <MoreHorizontal size={14} />}>
                    {(close) => (
                      <>
                        <DropdownItem onClick={() => { setRenameFor(tab); setRenameName(tab); close(); }}>
                          <Pencil size={13} /> 이름 변경
                        </DropdownItem>
                        <DropdownItem onClick={() => { void deleteDoc(tab); close(); }} className="text-danger">
                          <Trash2 size={13} /> 삭제
                        </DropdownItem>
                      </>
                    )}
                  </Dropdown>
                </div>
              )}
            </div>
            {/* 다른 곳(다른 기기·AI)이 같은 문서를 고쳤다 */}
            {conflict && docOpen && (
              <div className="flex flex-wrap items-center gap-2 border-b border-line bg-[rgb(var(--danger)/0.1)] px-3 py-2 text-[12.5px]">
                <span className="min-w-0 flex-1">
                  이 문서가 <b>다른 곳에서도 바뀌었습니다.</b> (AI 가 다시 썼을 수도 있습니다)
                </span>
                <button
                  onClick={async () => {
                    baseRef.current[docKey(selected.id, tab)] = 0;   // 검사를 건너뛴다
                    setConflict(false);
                    await saveDoc(selected.id, tab, content);
                  }}
                  className="btn btn-danger h-7 px-2 text-[12px]"
                >
                  내 글로 덮어쓰기
                </button>
                <button
                  onClick={() => { setConflict(false); void openDoc(selected.id, tab); }}
                  className="btn btn-ghost h-7 px-2 text-[12px]"
                >
                  저쪽 내용 불러오기
                </button>
              </div>
            )}
            {/* 서버에 닿지 못한 편집. 자동으로 덮어쓰지 않고 사용자가 고른다(노트와 같다). */}
            {draft && docOpen && (
              <div className="flex flex-wrap items-center gap-2 border-b border-line bg-[rgb(var(--warning)/0.12)] px-3 py-2 text-[12.5px]">
                <span className="min-w-0 flex-1">
                  저장되지 못한 편집이 이 브라우저에 남아 있습니다({draftAgeText(draft.at)}).
                </span>
                <button
                  onClick={() => {
                    setContent(draft.text);
                    setDirty(true);
                    setDraft(null);
                    void saveDoc(selected.id, tab, draft.text);
                  }}
                  className="btn btn-primary h-7 px-2 text-[12px]"
                >
                  되살리기
                </button>
                <button
                  onClick={() => { dropDraft(docKey(selected.id, tab)); setDraft(null); }}
                  className="btn btn-ghost h-7 px-2 text-[12px]"
                >
                  버리기
                </button>
              </div>
            )}
            {!docOpen ? (
              <TranscriptView meeting={selected} onSeek={seek} onRetry={() => retry(selected)}
                onRenameSpeaker={(label, name) => update(selected, { speakers: { ...(selected.speakers ?? {}), [label]: name } })} />
            ) : reading ? (
              <div className="flex-1 overflow-auto p-4">
                <MarkdownView content={content} onWikiClick={() => {}} />
              </div>
            ) : (
              <LiveEditor
                // 문서마다 편집기를 새로 만든다 — 되돌리기 이력이 다른 문서로 넘어가면 안 된다
                key={`${selected.id}/${tab}`}
                value={content}
                onChange={onEdit}
                onSave={() => { void saveDoc(selected.id, tab, content); }}
                docKey={`${selected.id}/${tab}`}
              />
            )}
          </div>
        ) : (
          <div className="card flex h-view-11 flex-col items-center justify-center gap-2 text-center text-[13px] text-fg-muted lg:h-auto">
            <AudioLines size={28} className="text-fg-subtle" />
            <p>왼쪽에서 회의를 고르거나 녹음을 시작하세요.</p>
            <p className="text-[12px] text-fg-subtle">원본은 그대로 두고, AI에게 원하는 느낌으로 요약·정리 문서를 만들게 할 수 있습니다.</p>
          </div>
        )}

        <div className="card flex h-view-11 flex-col overflow-hidden lg:h-auto">
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2 text-sm font-semibold">
            <Bot size={16} className="text-accent" /> AI 회의 비서
          </div>
          <div className="flex min-h-0 flex-1 flex-col p-3">
            {selected ? (
              <ChatPanel ref={chat} className="flex-1" mode="meeting" meetingId={selected.id} space={`meeting:${selected.id}`}
                suggestions={SUGGESTIONS}
                emptyTitle={meetingTitle(selected)}
                emptySubtitle="받아쓴 원본을 읽고, 원하는 느낌의 요약·회의록을 이 회의의 문서로 만들어 줍니다"
                placeholder="어떤 형식으로 정리할까요? (예: 결정 사항 위주로 짧게)"
                onToolSuccess={(m) => { void onMutated(m); }} />
            ) : (
              <div className="flex flex-1 items-center justify-center text-[12.5px] text-fg-muted">회의를 고르면 대화가 열립니다</div>
            )}
          </div>
        </div>
      </ThreePane>

      <Recorder open={recOpen} onClose={() => setRecOpen(false)} categories={categories}
        onSave={(file, meta) => upload([file], meta)} />

      <Modal open={newDocOpen} onClose={() => setNewDocOpen(false)} title="새 문서" width="max-w-sm">
        <div className="space-y-3">
          <input autoFocus className="input" value={newDocName} placeholder="문서 이름 (예: 회의록)"
            onChange={(e) => setNewDocName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void createDoc(); if (e.key === "Escape") setNewDocOpen(false); }} />
          <div className="flex justify-end gap-2">
            <button onClick={() => setNewDocOpen(false)} className="btn btn-secondary">취소</button>
            <button onClick={() => void createDoc()} className="btn btn-primary" disabled={!newDocName.trim()}>만들기</button>
          </div>
        </div>
      </Modal>

      <Modal open={!!renameFor} onClose={() => setRenameFor(null)} title="이름 변경" width="max-w-sm">
        <div className="space-y-3">
          <input autoFocus className="input" value={renameName} placeholder="새 이름"
            onChange={(e) => setRenameName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void doRename(); if (e.key === "Escape") setRenameFor(null); }} />
          <div className="flex justify-end gap-2">
            <button onClick={() => setRenameFor(null)} className="btn btn-secondary">취소</button>
            <button onClick={() => void doRename()} className="btn btn-primary" disabled={!renameName.trim()}>바꾸기</button>
          </div>
        </div>
      </Modal>
    </Shell>
  );
}

/** 제목·날짜·카테고리 — 자리에서 바로 고친다. 회의를 바꾸면(key) 초안도 새로 잡는다. */
function MeetingHeader({ meeting, categories, onBack, onUpdate, onRetry }: {
  meeting: Meeting;
  categories: string[];
  onBack: () => void;
  onUpdate: (b: Parameters<typeof api.meetingUpdate>[1]) => void;
  onRetry: () => void;
}) {
  const [title, setTitle] = useState(meeting.title);
  const [category, setCategory] = useState(meeting.category);
  useEffect(() => { setTitle(meeting.title); }, [meeting.title]);
  useEffect(() => { setCategory(meeting.category); }, [meeting.category]);

  const commitTitle = () => { const t = title.trim(); if (t !== meeting.title) onUpdate({ title: t }); };
  const commitCategory = () => { const c = category.trim(); if (c !== meeting.category) onUpdate({ category: c }); };

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2">
      <button onClick={onBack} aria-label="회의 목록으로" className="-ml-1 shrink-0 rounded p-1 text-fg-muted hover:bg-hovered hover:text-fg lg:hidden">
        <ChevronLeft size={16} />
      </button>
      <input value={title} onChange={(e) => setTitle(e.target.value)} onBlur={commitTitle}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        placeholder={meetingTitle(meeting)} aria-label="회의 제목"
        className="min-w-0 flex-1 basis-40 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-[14px] font-semibold hover:border-line focus:border-accent focus:outline-none" />
      <input type="date" value={meeting.date} onChange={(e) => { if (e.target.value) onUpdate({ date: e.target.value }); }}
        aria-label="회의 날짜" className="input h-7 w-[9.5rem] px-2 text-[12px]" />
      <input value={category} onChange={(e) => setCategory(e.target.value)} onBlur={commitCategory}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        placeholder="카테고리" list="meeting-categories-header" aria-label="카테고리"
        className="input h-7 w-28 px-2 text-[12px]" />
      <datalist id="meeting-categories-header">
        {categories.map((c) => <option key={c} value={c} />)}
      </datalist>
      {meeting.status === "pending" && <span className="badge badge-accent gap-1"><Loader2 size={10} className="animate-spin" /> 받아쓰는 중</span>}
      {meeting.status === "ready" && (
        <button onClick={() => { if (confirm("원본을 다시 받아쓸까요? 요약이 새로 만들어집니다.")) onRetry(); }}
          className="btn btn-ghost h-7 gap-1 px-2 text-[11.5px]" title="다시 받아쓰기">
          <RefreshCw size={12} /> 다시 받아쓰기
        </button>
      )}
    </div>
  );
}

function TabBtn({ on, onClick, icon, label }: { on: boolean; onClick: () => void; icon: ReactNode; label: string }) {
  return (
    <button type="button" role="tab" aria-selected={on} onClick={onClick} title={label}
      className={`-mb-px inline-flex max-w-[12rem] shrink-0 items-center gap-1 border-b-2 px-3 py-2 text-[12.5px] ${on ? "border-accent text-accent-fg" : "border-transparent text-fg-muted hover:text-fg"}`}>
      {icon} <span className="truncate">{label}</span>
    </button>
  );
}
