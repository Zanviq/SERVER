import {
  ReactNode, forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState,
} from "react";
import {
  Bot, Send, Loader2, CheckCircle2, XCircle, Sparkles, X, Quote, ImageIcon, Eraser,
} from "lucide-react";
import { MarkdownView } from "../notes/LazyMarkdownView";
import { aiChatStream, api, AiEvent, ChatMessage } from "../../lib/api";
import { toast } from "../../store/toast";
import { useMediaQuery } from "../../lib/useMediaQuery";
import { VocabProposal, VocabProposalData } from "./VocabProposal";

interface Step {
  name: string;
  ok?: boolean;
  message?: string;
  /** 화면이 그려야 하는 결과(단어 후보 등). 그런 스킬만 온다. */
  data?: Record<string, unknown>;
}
interface Msg {
  id?: string;
  role: "user" | "assistant";
  text: string;
  steps: Step[];
  pending?: boolean;
  /** 사용자 메시지에 같이 보낸 것(논문 화면) — 말풍선 아래 작게 보여 준다 */
  selections?: { text: string; page: number }[];
  attachments?: { label: string }[];
}

// 스킬 이름 -> 사람이 읽는 이름. 여기 없으면 AI 단계에 raw 이름이 그대로 뜬다
// (bulk_update_calendar_events가 그렇게 보였다). 스킬을 추가하면 여기도 채운다.
const SKILL_LABEL: Record<string, string> = {
  think: "생각 정리",
  // 문서(파일·노트 통합)
  list_documents: "문서 목록",
  read_document: "문서 읽기",
  search_documents: "문서 검색",
  write_document: "문서 작성",
  append_document: "문서 덧붙이기",
  delete_document: "문서 삭제",
  rename_document: "이름 변경",
  move_document: "문서 이동",
  create_folder: "폴더 생성",
  document_backlinks: "백링크 조회",
  // 캘린더
  list_calendar_events: "일정 조회",
  create_calendar_event: "일정 생성",
  update_calendar_event: "일정 수정",
  bulk_create_calendar_events: "일정 일괄 생성",
  bulk_update_calendar_events: "일정 일괄 수정",
  bulk_delete_calendar_events: "일정 일괄 삭제",
  delete_calendar_event: "일정 삭제",
  find_free_slots: "빈 시간 찾기",
  // 할 일
  list_todos: "할 일 조회",
  create_todo: "할 일 생성",
  update_todo: "할 일 수정",
  complete_todo: "할 일 완료",
  delete_todo: "할 일 삭제",
  bulk_complete_todos: "할 일 일괄 완료",
  bulk_delete_todos: "할 일 일괄 삭제",
  list_todo_categories: "카테고리 조회",
  create_todo_category: "카테고리 생성",
  // 단어장
  list_vocab: "단어장 조회",
  list_vocab_tags: "단어장 태그",
  add_vocab_words: "단어장에 추가",
  propose_vocab_words: "단어 후보 제안",
  update_vocab_word: "단어 수정",
  delete_vocab_word: "단어 삭제",
  // 논문
  list_papers: "논문 목록",
  get_paper_info: "논문 정보",
  read_paper_text: "논문 본문 읽기",
  search_paper_chats: "지난 대화 검색",
  set_paper_notes: "논문 메모",
  update_paper_info: "논문 정보 수정",
  // 회의
  list_meetings: "회의 목록",
  get_meeting_info: "회의 정보",
  read_meeting_transcript: "받아쓰기 읽기",
  list_meeting_docs: "회의 문서 목록",
  read_meeting_doc: "회의 문서 읽기",
  write_meeting_doc: "회의 문서 작성",
  append_meeting_doc: "회의 문서 덧붙이기",
  delete_meeting_doc: "회의 문서 삭제",
  update_meeting_info: "회의 정보 수정",
  // 기록(상태·일기)
  get_diary: "기록 조회",
  set_diary: "기록 저장",
  // 지난 대화(컨텍스트)
  list_context_spaces: "대화 공간 목록",
  search_context: "지난 대화 검색",
  read_context: "지난 대화 읽기",
  // 폴더·휴지통
  list_folders: "폴더 목록",
  list_trash: "휴지통 목록",
  restore_from_trash: "휴지통 복원",
  get_system_status: "시스템 상태",
};

// 어떤 스킬이 무엇을 바꾸는지는 **백엔드가 알려준다**(tool_result.mutates).
// 여기에 이름 목록을 두면 새 스킬이 생길 때마다 같이 고쳐야 하고, 빠뜨리면
// "AI는 고쳤다는데 화면은 그대로"가 된다(bulk_update_calendar_events에서 실제로 그랬다).

export const DEFAULT_SUGGESTIONS = [
  "내 노트 목록 보여줘",
  "이번 주 일정 정리해줘",
  "회의 준비 체크리스트 노트 만들어줘",
  "내일 오후 3시에 운동 일정 잡아줘",
];

/** 논문 화면에서 드래그한 영역 — data 는 PNG data URL. */
export interface ChatAttachment {
  id: string;
  mime: string;
  data: string;
  label: string;
}
/** 논문 화면에서 드래그해 고른 글. */
export interface ChatSelection {
  id: string;
  text: string;
  page: number;
}

/** 부모가 대화를 조작할 손잡이(빠른 질문 칩, 대화 비우기). */
export interface ChatPanelHandle {
  send: (text: string) => void;
  focus: () => void;
  clear: () => Promise<void>;
}

interface ChatPanelProps {
  /** 빈 화면에 보여줄 추천 프롬프트 */
  suggestions?: string[];
  /** 캘린더 등 외부 상태를 바꾸는 스킬이 성공했을 때 호출 (예: 목록 새로고침) */
  onToolSuccess?: (mutated: string) => void;
  /** 컨테이너 추가 클래스 (높이 등은 부모가 제어) */
  className?: string;
  /** 입력창 바로 위에 렌더할 요소 (예: 색상 칩) */
  composerTop?: ReactNode;
  /** 전송 전 메시지 변환 (예: 색상 힌트 추가) */
  transformMessage?: (text: string) => string;
  /** 비서("") · 영어 학습 · 논문 · 회의. 모드가 있으면 서버가 대화를 들고 있다. */
  mode?: "" | "assistant" | "calendar" | "english" | "paper" | "meeting";
  paperId?: string;
  meetingId?: string;
  /** 단어 후보를 넣을 때 붙일 태그(논문 제목 등). 누르는 시점의 값이 쓰인다. */
  vocabTags?: string[];
  /** 서버 대화 공간("english" | "paper:<id>" | "meeting:<id>"). 바뀌면 그 공간의 기록을 다시 받는다. */
  space?: string;
  attachments?: ChatAttachment[];
  selections?: ChatSelection[];
  onRemoveAttachment?: (id: string) => void;
  onRemoveSelection?: (id: string) => void;
  /** 첨부·선택을 모두 비운다(전송 직후에도 불린다) */
  onClearContext?: () => void;
  emptyTitle?: string;
  emptySubtitle?: string;
  placeholder?: string;
}

function fromServer(m: ChatMessage): Msg {
  return {
    id: m.id,
    role: m.role,
    text: m.text,
    steps: (m.meta?.tools ?? []).map((t) => ({ name: t.name, ok: t.ok, message: t.message, data: t.data })),
    selections: m.meta?.selections,
    attachments: m.meta?.attachments,
  };
}

/** 재사용 가능한 AI 채팅 패널 (AI 비서 · 캘린더 사이드 · 영어 학습 · 논문 공용) */
export const ChatPanel = forwardRef<ChatPanelHandle, ChatPanelProps>(function ChatPanel({
  suggestions = DEFAULT_SUGGESTIONS,
  onToolSuccess,
  className = "",
  composerTop,
  transformMessage,
  mode = "",
  paperId = "",
  meetingId = "",
  vocabTags,
  space,
  attachments = [],
  selections = [],
  onRemoveAttachment,
  onRemoveSelection,
  onClearContext,
  emptyTitle = "무엇을 도와드릴까요?",
  emptySubtitle = "파일·노트·일정을 자동으로 처리합니다",
  placeholder,
}, ref) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loadingSpace, setLoadingSpace] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 화면 폭이 아니라 입력 방식으로 판단한다 — 태블릿 가로처럼 넓어도 소프트 키보드다.
  const touch = useMediaQuery("(pointer: coarse)");
  const hasContext = attachments.length > 0 || selections.length > 0;

  useEffect(() => {
    api.aiStatus().then((s) => setEnabled(s.enabled)).catch(() => setEnabled(false));
  }, []);

  // 서버 공간의 기록. 논문을 바꾸면 그 논문의 대화로 갈아탄다.
  useEffect(() => {
    if (!space) {
      setMessages([]);
      return;
    }
    let alive = true;
    setLoadingSpace(true);
    setMessages([]);
    api.aiSpace(space)
      .then((r) => { if (alive) setMessages(r.messages.map(fromServer)); })
      .catch((e) => { if (alive) toast.error(e instanceof Error ? e.message : "대화 기록을 불러오지 못했습니다"); })
      .finally(() => { if (alive) setLoadingSpace(false); });
    return () => { alive = false; };
  }, [space]);

  const firstScroll = useRef(true);
  useEffect(() => {
    // 기록을 처음 받았을 때는 스르륵 내리지 않는다(수백 줄을 애니메이션으로 지나간다)
    endRef.current?.scrollIntoView({ behavior: firstScroll.current ? "auto" : "smooth" });
    if (messages.length > 0) firstScroll.current = false;
  }, [messages]);
  useEffect(() => { firstScroll.current = true; }, [space]);

  // 입력 내용에 맞춰 textarea 높이 자동 조절(장문이면 줄바꿈되며 늘어남, 최대 높이까지)
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  const send = useCallback(async (raw: string) => {
    if ((!raw.trim() && !hasContext) || busy) return;
    const text = transformMessage ? transformMessage(raw) : raw;
    setInput("");
    setBusy(true);
    // 직전까지의 대화(완료된 것만)를 멀티턴 컨텍스트로 전달(모드가 있으면 서버가 무시한다)
    const history = messages
      .filter((m) => m.text)
      .map((m) => ({ role: m.role, text: m.text }));
    const sent = {
      attachments: attachments.map((a) => ({ mime: a.mime, data: a.data, label: a.label })),
      selections: selections.map((s) => ({ text: s.text, page: s.page })),
    };
    setMessages((m) => [
      ...m,
      {
        role: "user", text, steps: [],
        selections: sent.selections, attachments: sent.attachments.map((a) => ({ label: a.label })),
      },
      { role: "assistant", text: "", steps: [], pending: true },
    ]);
    // 보낸 첨부는 칩에서 내린다(클로드처럼) — 다음 질문에 또 실리면 안 된다
    onClearContext?.();

    const patchLast = (fn: (m: Msg) => Msg) =>
      setMessages((arr) => arr.map((m, i) => (i === arr.length - 1 ? fn(m) : m)));

    try {
      await aiChatStream(text, history, (e: AiEvent) => {
        if (e.type === "tool_call") {
          patchLast((m) => ({ ...m, steps: [...m.steps, { name: e.name! }] }));
        } else if (e.type === "tool_result") {
          patchLast((m) => {
            const steps = [...m.steps];
            for (let i = steps.length - 1; i >= 0; i--) {
              if (steps[i].name === e.name && steps[i].ok === undefined) {
                steps[i] = { ...steps[i], ok: e.ok, message: e.message, data: e.data };
                break;
              }
            }
            return { ...m, steps };
          });
          if (e.ok && e.mutates) onToolSuccess?.(e.mutates);
        } else if (e.type === "text") {
          patchLast((m) => ({ ...m, text: e.text ?? "" }));
        } else if (e.type === "error") {
          patchLast((m) => ({ ...m, text: `오류: ${e.message}` }));
        }
      }, { mode, paper_id: paperId, meeting_id: meetingId, ...sent });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "AI 오류");
      patchLast((m) => ({ ...m, text: "요청 처리 중 오류가 발생했습니다." }));
    } finally {
      patchLast((m) => ({ ...m, pending: false }));
      setBusy(false);
    }
  }, [attachments, busy, hasContext, messages, meetingId, mode, onClearContext, onToolSuccess, paperId, selections, transformMessage]);

  const clear = useCallback(async () => {
    if (space) await api.aiSpaceClear(space);
    setMessages([]);
  }, [space]);

  useImperativeHandle(ref, () => ({
    send: (t: string) => { void send(t); },
    focus: () => inputRef.current?.focus(),
    clear,
  }), [send, clear]);

  const canSend = !busy && (!!input.trim() || hasContext);

  return (
    <div className={`flex min-h-0 flex-col ${className}`}>
      {enabled === false && (
        <div className="mb-3 rounded-md border border-warning/30 bg-warning/10 px-4 py-2.5 text-[13px] text-warning">
          GEMINI_API_KEY가 설정되지 않아 AI가 비활성화되어 있습니다. (.env 확인)
        </div>
      )}

      <div className="flex-1 space-y-4 overflow-auto pr-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            {loadingSpace ? (
              <Loader2 size={20} className="animate-spin text-fg-muted" />
            ) : (
              <>
                <div className="grid h-14 w-14 place-items-center rounded-xl bg-accent-muted text-accent">
                  <Sparkles size={26} />
                </div>
                <div>
                  <p className="text-sm font-semibold">{emptyTitle}</p>
                  <p className="mt-1 text-[13px] text-fg-muted">{emptySubtitle}</p>
                </div>
                <div className="flex flex-wrap justify-center gap-2">
                  {suggestions.map((s) => (
                    <button key={s} onClick={() => send(s)}
                      className="rounded-full border border-line bg-surface px-3 py-1.5 text-[12px] text-fg2 hover:border-accent hover:text-accent">
                      {s}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={m.id ?? i} className="flex flex-col items-end gap-1">
              {(m.selections?.length || m.attachments?.length) ? (
                <div className="flex max-w-[80%] flex-wrap justify-end gap-1">
                  {m.selections?.map((s, j) => (
                    <span key={`s${j}`} title={s.text}
                      className="inline-flex max-w-[240px] items-center gap-1 rounded-full border border-line bg-subtle px-2 py-0.5 text-[11px] text-fg-muted">
                      <Quote size={10} className="shrink-0" />
                      <span className="truncate">{s.page ? `${s.page}쪽 · ` : ""}{s.text}</span>
                    </span>
                  ))}
                  {m.attachments?.map((a, j) => (
                    <span key={`a${j}`}
                      className="inline-flex items-center gap-1 rounded-full border border-line bg-subtle px-2 py-0.5 text-[11px] text-fg-muted">
                      <ImageIcon size={10} /> {a.label || "영역 이미지"}
                    </span>
                  ))}
                </div>
              ) : null}
              {m.text && (
                <div className="max-w-[80%] whitespace-pre-wrap rounded-lg rounded-br-sm bg-accent px-4 py-2.5 text-[13.5px] text-accent-contrast">
                  {m.text}
                </div>
              )}
            </div>
          ) : (
            <div key={m.id ?? i} className="flex gap-2.5">
              <div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent-muted text-accent">
                <Bot size={15} />
              </div>
              <div className="min-w-0 flex-1 space-y-2">
                {m.steps.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {m.steps.map((s, j) => (
                      <span key={j} title={s.message}
                        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px] ${
                          s.ok === false ? "border-danger/30 text-danger"
                          : s.ok ? "border-accent/30 bg-accent-muted text-accent-fg"
                          : "border-line text-fg-muted"}`}>
                        {s.ok === undefined ? <Loader2 size={11} className="animate-spin" />
                          : s.ok ? <CheckCircle2 size={11} /> : <XCircle size={11} />}
                        {SKILL_LABEL[s.name] ?? s.name}
                      </span>
                    ))}
                  </div>
                )}
                {m.text ? (
                  <div className="card px-4 py-2.5">
                    <MarkdownView content={m.text} onWikiClick={() => {}} />
                  </div>
                ) : m.pending && m.steps.length === 0 ? (
                  <div className="inline-flex items-center gap-2 text-[13px] text-fg-muted">
                    <Loader2 size={14} className="animate-spin" /> 생각 중…
                  </div>
                ) : null}
                {/* 단어 후보: 고른 것만 서버로 바로 가고 백그라운드에서 채워진다 */}
                {m.steps.map((s, j) =>
                  s.name === "propose_vocab_words" && s.ok && s.data && Array.isArray(s.data.proposal) ? (
                    <VocabProposal
                      key={`p${j}`}
                      data={s.data as unknown as VocabProposalData}
                      tags={vocabTags}
                    />
                  ) : null,
                )}
              </div>
            </div>
          ),
        )}
        <div ref={endRef} />
      </div>

      {composerTop && <div className="mt-3">{composerTop}</div>}
      {hasContext && (
        <div className={`${composerTop ? "mt-2" : "mt-3"} flex flex-wrap items-center gap-1.5`}>
          {attachments.map((a) => (
            <span key={a.id} className="group relative inline-flex items-center gap-1.5 rounded-md border border-line bg-subtle p-1 pr-1.5 text-[11.5px] text-fg2">
              <img src={a.data} alt={a.label} className="h-10 w-auto max-w-[96px] rounded-sm object-cover" />
              <span className="max-w-[120px] truncate">{a.label}</span>
              <button type="button" onClick={() => onRemoveAttachment?.(a.id)} aria-label={`${a.label} 빼기`}
                className="grid h-5 w-5 place-items-center rounded-full text-fg-muted hover:bg-hovered hover:text-danger">
                <X size={12} />
              </button>
            </span>
          ))}
          {selections.map((s) => (
            <span key={s.id} title={s.text}
              className="inline-flex max-w-[260px] items-center gap-1.5 rounded-md border border-line bg-subtle px-2 py-1 text-[11.5px] text-fg2">
              <Quote size={11} className="shrink-0 text-accent" />
              <span className="truncate">{s.page ? `${s.page}쪽 · ` : ""}{s.text}</span>
              <button type="button" onClick={() => onRemoveSelection?.(s.id)} aria-label="선택한 글 빼기"
                className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-fg-muted hover:bg-hovered hover:text-danger">
                <X size={12} />
              </button>
            </span>
          ))}
          <button type="button" onClick={() => onClearContext?.()}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11.5px] text-fg-muted hover:bg-hovered hover:text-fg">
            <Eraser size={12} /> 모두 지우기
          </button>
        </div>
      )}
      <div className={`${composerTop || hasContext ? "mt-2" : "mt-3"} flex items-end gap-2`}>
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // Enter=전송, Shift+Enter=줄바꿈. 단 소프트 키보드에서는 Enter가 줄바꿈
            // 키라 Shift+Enter를 칠 방법이 없다 — 터치 기기에서는 전송을 버튼으로만.
            // (한글 조합 중 Enter는 조합 확정이므로 전송하면 마지막 글자가 잘린다)
            if (e.key === "Enter" && !e.shiftKey && !touch && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send(input);
            }
          }}
          placeholder={placeholder ?? (touch ? "메시지를 입력하세요…" : "메시지를 입력하세요… (Shift+Enter 줄바꿈)")}
          disabled={busy}
          rows={1}
          className="input flex-1 resize-none !h-auto min-h-[2.25rem] py-2 leading-relaxed [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          style={{ maxHeight: 160, overflowY: "auto" }}
        />
        <button onClick={() => send(input)} disabled={!canSend} className="btn btn-primary h-9 px-4" aria-label="보내기">
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
        </button>
      </div>
    </div>
  );
});
