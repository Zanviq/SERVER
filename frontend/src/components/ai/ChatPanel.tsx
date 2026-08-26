import { ReactNode, useEffect, useRef, useState } from "react";
import { Bot, Send, Loader2, CheckCircle2, XCircle, Sparkles } from "lucide-react";
import { MarkdownView } from "../notes/LazyMarkdownView";
import { aiChatStream, api, AiEvent } from "../../lib/api";
import { toast } from "../../store/toast";
import { useMediaQuery } from "../../lib/useMediaQuery";

interface Step {
  name: string;
  ok?: boolean;
  message?: string;
}
interface Msg {
  role: "user" | "assistant";
  text: string;
  steps: Step[];
  pending?: boolean;
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
}

/** 재사용 가능한 AI 채팅 패널 (AI 비서 페이지 + 캘린더 사이드 패널 공용) */
export function ChatPanel({
  suggestions = DEFAULT_SUGGESTIONS,
  onToolSuccess,
  className = "",
  composerTop,
  transformMessage,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 화면 폭이 아니라 입력 방식으로 판단한다 — 태블릿 가로처럼 넓어도 소프트 키보드다.
  const touch = useMediaQuery("(pointer: coarse)");

  useEffect(() => {
    api.aiStatus().then((s) => setEnabled(s.enabled)).catch(() => setEnabled(false));
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // 입력 내용에 맞춰 textarea 높이 자동 조절(장문이면 줄바꿈되며 늘어남, 최대 높이까지)
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  const send = async (raw: string) => {
    if (!raw.trim() || busy) return;
    const text = transformMessage ? transformMessage(raw) : raw;
    setInput("");
    setBusy(true);
    // 직전까지의 대화(완료된 것만)를 멀티턴 컨텍스트로 전달
    const history = messages
      .filter((m) => m.text)
      .map((m) => ({ role: m.role, text: m.text }));
    setMessages((m) => [
      ...m,
      { role: "user", text, steps: [] },
      { role: "assistant", text: "", steps: [], pending: true },
    ]);

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
                steps[i] = { ...steps[i], ok: e.ok, message: e.message };
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
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "AI 오류");
      patchLast((m) => ({ ...m, text: "요청 처리 중 오류가 발생했습니다." }));
    } finally {
      patchLast((m) => ({ ...m, pending: false }));
      setBusy(false);
    }
  };

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
            <div className="grid h-14 w-14 place-items-center rounded-xl bg-accent-muted text-accent">
              <Sparkles size={26} />
            </div>
            <div>
              <p className="text-sm font-semibold">무엇을 도와드릴까요?</p>
              <p className="mt-1 text-[13px] text-fg-muted">파일·노트·일정을 자동으로 처리합니다</p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              {suggestions.map((s) => (
                <button key={s} onClick={() => send(s)}
                  className="rounded-full border border-line bg-surface px-3 py-1.5 text-[12px] text-fg2 hover:border-accent hover:text-accent">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[80%] rounded-lg rounded-br-sm bg-accent px-4 py-2.5 text-[13.5px] text-accent-contrast">
                {m.text}
              </div>
            </div>
          ) : (
            <div key={i} className="flex gap-2.5">
              <div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent-muted text-accent">
                <Bot size={15} />
              </div>
              <div className="min-w-0 flex-1 space-y-2">
                {m.steps.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {m.steps.map((s, j) => (
                      <span key={j}
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
              </div>
            </div>
          ),
        )}
        <div ref={endRef} />
      </div>

      {composerTop && <div className="mt-3">{composerTop}</div>}
      <div className={`${composerTop ? "mt-2" : "mt-3"} flex items-end gap-2`}>
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
          placeholder={touch ? "메시지를 입력하세요…" : "메시지를 입력하세요… (Shift+Enter 줄바꿈)"}
          disabled={busy}
          rows={1}
          className="input flex-1 resize-none !h-auto min-h-[2.25rem] py-2 leading-relaxed [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          style={{ maxHeight: 160, overflowY: "auto" }}
        />
        <button onClick={() => send(input)} disabled={busy || !input.trim()} className="btn btn-primary h-9 px-4">
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
        </button>
      </div>
    </div>
  );
}
