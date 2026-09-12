import {
  ReactNode, forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState,
} from "react";
import {
  Bot, Send, Square, Loader2, CheckCircle2, XCircle, Sparkles, X, Quote, ImageIcon, Eraser,
  ChevronLeft, ChevronRight, GitBranch, Pencil,
} from "lucide-react";
import { MarkdownView } from "../notes/LazyMarkdownView";
import { useNavigate } from "react-router-dom";
import { aiChatStream, api, AiEvent, ChatMessage } from "../../lib/api";
import { isSubmitEnter } from "../../lib/keys";
import { toast } from "../../store/toast";
import { useMediaQuery } from "../../lib/useMediaQuery";
import { VocabProposal, VocabProposalData } from "./VocabProposal";
import { skillIcon } from "./skillIcon";
import { ConversationTree, TreeLink } from "./ConversationTree";
import { deepestLeaf, siblingsOf, threadOf, TreeMessage } from "../../lib/chatTree";

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
  /** 도구를 부른 뒤라 다음에 오는 글로 갈아쳐야 하는가(앞의 글은 그때까지 그대로 둔다) */
  rewriting?: boolean;
  /** 대화 나무에서 매달린 자리. 뿌리는 null. */
  parent?: string | null;
  /** AI 가 붙인 가지 이름(갈라지는 자리에만) */
  branchName?: string;
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
  search_everything: "전체 검색",
  shift_date: "날짜 계산",
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
  /**
   * 첨부·선택을 모두 비운다. 보내면서 비울 때는 reason="sent" 로 알린다 —
   * 그러면 부모가 챙겨 뒀다가, 보내기가 실패했을 때 onRestoreContext 로 되돌린다.
   */
  onClearContext?: (reason?: "sent") => void;
  /** 보내기가 실패했을 때 방금 내린 첨부·선택을 되돌린다 */
  onRestoreContext?: () => void;
  emptyTitle?: string;
  emptySubtitle?: string;
  placeholder?: string;
}

/**
 * 한 답에 달린 단어 후보 목록들 — 겹치는 단어를 뒤 목록에서 뺀다.
 *
 * 모델은 함수 호출을 나란히 내보내기 때문에 add_vocab_words 와
 * propose_vocab_words 를 한 차례에 같이 부르는 일이 있다. 그러면 같은 단어가 두
 * 목록에 실리고, 사용자가 둘 다 누르면 같은 단어를 두 번 넣는다. 서버도 같은
 * 것을 거르지만(routers/ai.py `_drop_repeats`), 그 전에 저장된 대화에도 겹친
 * 목록이 남아 있다.
 */
export function dedupeProposals(steps: Step[]): { key: string; data: VocabProposalData }[] {
  const seen = new Set<string>();
  const out: { key: string; data: VocabProposalData }[] = [];
  steps.forEach((s, j) => {
    if (!s.ok || !s.data || !Array.isArray(s.data.proposal)) return;
    const rows = (s.data.proposal as VocabProposalData["proposal"]).filter((r) => {
      const hw = String(r?.word ?? "").trim().toLowerCase();
      if (!hw || seen.has(hw)) return false;
      seen.add(hw);
      return true;
    });
    if (rows.length === 0) return;
    out.push({ key: `p${j}`, data: { ...(s.data as unknown as VocabProposalData), proposal: rows } });
  });
  return out;
}

function fromServer(m: ChatMessage): Msg {
  return {
    id: m.id,
    role: m.role,
    text: m.text,
    parent: m.parent ?? null,
    branchName: m.meta?.branch_name,
    steps: (m.meta?.tools ?? []).map((t) => ({ name: t.name, ok: t.ok, message: t.message, data: t.data })),
    selections: m.meta?.selections,
    attachments: m.meta?.attachments,
  };
}

/**
 * 같은 자리에서 갈라진 가지 사이를 오가는 단추 — `◀ 2/3 ▶`.
 *
 * 지도를 열지 않고도 "아까 저쪽으로 물어본 것"으로 돌아갈 수 있어야 한다. 가지가
 * 하나뿐이면 아무것도 그리지 않는다(없는 선택지를 보여 줄 이유가 없다).
 */
function BranchSwitch({ msgs, current, onGo, onEdit, busy }: {
  msgs: TreeMessage[];
  current?: string;
  onGo: (id: string) => void;
  onEdit: () => void;
  busy?: boolean;
}) {
  const at = msgs.findIndex((m) => m.id === current);
  if (!current) return null;
  const many = msgs.length > 1 && at >= 0;
  return (
    <div className="flex items-center gap-0.5 pr-0.5 text-[11px] text-fg-muted">
      {many && (
        <>
          <button type="button" aria-label="이전 가지" disabled={at === 0 || busy}
            className="tap grid h-6 w-6 place-items-center rounded hover:bg-hovered disabled:opacity-30"
            onClick={() => onGo(msgs[at - 1].id)}>
            <ChevronLeft size={13} />
          </button>
          <span className="tabular-nums">{at + 1}/{msgs.length}</span>
          <button type="button" aria-label="다음 가지" disabled={at === msgs.length - 1 || busy}
            className="tap grid h-6 w-6 place-items-center rounded hover:bg-hovered disabled:opacity-30"
            onClick={() => onGo(msgs[at + 1].id)}>
            <ChevronRight size={13} />
          </button>
        </>
      )}
      <button type="button" title="이 질문을 고쳐서 새 가지로 다시 묻기"
        aria-label="질문 고쳐서 새 가지" disabled={busy} onClick={onEdit}
        className="tap grid h-6 w-6 place-items-center rounded hover:bg-hovered hover:text-accent disabled:opacity-30">
        <Pencil size={12} />
      </button>
    </div>
  );
}

/** 나무 계산에 넘길 최소 모양 — 화면 전용 필드는 뺀다. */
function asTree(msgs: Msg[]): TreeMessage[] {
  return msgs.filter((m) => m.id).map((m) => ({
    id: m.id!, role: m.role, text: m.text, parent: m.parent ?? null,
    branchName: m.branchName,
  }));
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
  onRestoreContext,
  emptyTitle = "무엇을 도와드릴까요?",
  emptySubtitle = "파일·노트·일정을 자동으로 처리합니다",
  placeholder,
}, ref) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loadingSpace, setLoadingSpace] = useState(false);
  //: 대화 나무에서 지금 보고 있는 끝자락. 말풍선에 보이는 것은 여기서 뿌리까지의
  //: 한 줄기뿐이고, 다음 말도 여기에 붙는다.
  const [head, setHead] = useState("");
  const [links, setLinks] = useState<TreeLink[]>([]);
  const [showTree, setShowTree] = useState(false);
  //: 다음 한 번만 이 메시지 뒤에 붙인다(과거 질문에서 새 가지를 낼 때).
  //: id 가 null 이면 **대화 맨 앞**이다 — 첫 질문을 고쳐 다시 묻는 경우다.
  const [branchFrom, setBranchFrom] = useState<{ id: string | null; label: string } | null>(null);
  //: 견주어 달라고 고른 가지들(다음 한 번만 실린다)
  const [compare, setCompare] = useState<string[]>([]);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);   // 중단 버튼
  const navigate = useNavigate();
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
      setHead("");
      setLinks([]);
      return;
    }
    let alive = true;
    setLoadingSpace(true);
    setMessages([]);
    setBranchFrom(null);
    setCompare([]);
    api.aiSpace(space)
      .then((r) => {
        if (!alive) return;
        setMessages(r.messages.map(fromServer));
        setHead(r.head ?? "");
        setLinks(r.links ?? []);
      })
      .catch((e) => { if (alive) toast.error(e instanceof Error ? e.message : "대화 기록을 불러오지 못했습니다"); })
      .finally(() => { if (alive) setLoadingSpace(false); });
    return () => { alive = false; };
  }, [space]);

  /**
   * 말풍선에 보이는 것 — **지금 가지 한 줄기**.
   *
   * 서버에 남지 않는 화면(비서 등 space 가 없는 곳)은 메시지가 곧 한 줄이므로
   * 그대로 쓴다. 스트리밍 중인 말풍선은 아직 id 가 없어 나무에 없으므로 뒤에 붙인다.
   */
  const shown = useMemo(() => {
    if (!space) return messages;
    const live = messages.filter((m) => !m.id);
    const tree = asTree(messages);
    const ids = new Set(threadOf(tree, head).map((m) => m.id));
    return [...messages.filter((m) => m.id && ids.has(m.id!)), ...live];
  }, [messages, head, space]);

  /** 이 메시지와 같은 자리에서 갈라진 형제들(말풍선의 ◀ 2/3 ▶). */
  const branchesOf = useCallback((id?: string) => {
    if (!space || !id) return [] as TreeMessage[];
    const sib = siblingsOf(asTree(messages), id);
    return sib.length > 1 ? sib : [];
  }, [messages, space]);

  /** 다른 가지로 옮겨 간다. 그 가지의 **끝까지** 따라간다. */
  const goTo = useCallback(async (id: string) => {
    if (!space) return;
    const leaf = deepestLeaf(asTree(messages), id);
    setHead(leaf);                       // 먼저 화면을 바꾼다(기다릴 이유가 없다)
    try {
      await api.aiSpaceHead(space, leaf);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "가지를 옮기지 못했습니다");
    }
  }, [messages, space]);

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
    // 직전까지의 대화(완료된 것만)를 멀티턴 컨텍스트로 전달(모드가 있으면 서버가 무시한다).
    // **보이는 줄기만** 보낸다 — 다른 가지의 이야기가 섞이면 가지를 나눈 의미가 없다.
    const history = shown
      .filter((m) => m.text)
      .map((m) => ({ role: m.role, text: m.text }));
    // 이번 한 번만 쓰는 것들: 어디에 붙일지, 어떤 가지들을 견줄지.
    // 가지를 안 내면 아예 보내지 않는다(undefined 는 JSON 에서 빠진다) — null 은
    // "맨 앞에 내라"는 **다른 뜻**이라 빈 문자열 하나로 뭉뚱그릴 수 없다.
    const parent = branchFrom ? branchFrom.id : undefined;
    const compareIds = compare;
    setBranchFrom(null);
    setCompare([]);
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
    // 보낸 첨부는 칩에서 내린다(클로드처럼) — 다음 질문에 또 실리면 안 된다.
    // "sent" 라고 알려 두면 실패했을 때 부모가 되돌려 준다.
    onClearContext?.("sent");

    const patchLast = (fn: (m: Msg) => Msg) =>
      setMessages((arr) => arr.map((m, i) => (i === arr.length - 1 ? fn(m) : m)));

    // 실패하면 친 글을 입력칸에 돌려준다. 길게 쓴 질문이 한도 초과 한 번에
    // 사라지면 말풍선에서 긁어다 다시 붙여야 했다. 그 사이에 다른 것을 치기
    // 시작했으면 건드리지 않는다(쓰던 글을 덮는 것이 더 나쁘다).
    // 첨부·선택도 함께 돌려준다. 글만 돌아오면 PDF 에서 문단을 다시 고르고
    // 그림을 다시 오려야 한다 — 정작 되찾기 어려운 쪽이 그쪽이다.
    const giveBack = () => {
      setInput((cur) => (cur.trim() ? cur : raw));
      onRestoreContext?.();
    };

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await aiChatStream(text, history, (e: AiEvent) => {
        if (e.type === "tool_call") {
          // 스킬을 부르기 직전에 흘러나온 말은 대개 머리말이고, 도구를 쓰고 나면
          // 모델이 답을 처음부터 다시 쓴다. 그래서 갈아치워야 하는데, **여기서
          // 곧바로 비우면 안 된다** — 모델이 답을 다 쓴 뒤 마지막에 도구를 부르는
          // 경우가 있고(단어 후보가 그랬다), 그러면 다 읽던 답이 눈앞에서 사라진다.
          // 표시만 해 두고, **새 글이 실제로 오는 순간** 갈아친다.
          patchLast((m) => ({ ...m, rewriting: true, steps: [...m.steps, { name: e.name! }] }));
        } else if (e.type === "text_delta") {
          patchLast((m) => ({
            ...m,
            text: (m.rewriting ? "" : m.text) + (e.text ?? ""),
            rewriting: false,
          }));
        } else if (e.type === "tool_result") {
          patchLast((m) => {
            const steps = [...m.steps];
            for (let i = steps.length - 1; i >= 0; i--) {
              if (steps[i].name === e.name && steps[i].ok === undefined) {
                steps[i] = { ...steps[i], ok: e.ok, message: e.message, data: e.data };
                return { ...m, steps };
              }
            }
            // 짝이 되는 tool_call 이 없는 결과도 있다 — **서버가 스스로 한 일**이다
            // (모델이 잊은 단어 후보를 서버가 채우는 경우). 예전에는 여기서 조용히
            // 버려서, 그 후보 목록이 **화면에 아예 안 나왔다**. 칩도 없고 고를
            // 것도 없으니 서버가 한 일이 통째로 사라진 셈이다.
            return { ...m, steps: [...steps, { name: e.name!, ok: e.ok, message: e.message, data: e.data }] };
          });
          if (e.ok && e.mutates) onToolSuccess?.(e.mutates);
        } else if (e.type === "text") {
          patchLast((m) => ({ ...m, text: e.text ?? "", rewriting: false }));
        } else if (e.type === "error") {
          patchLast((m) => ({ ...m, text: `오류: ${e.message}` }));
          giveBack();
        }
      }, {
        mode, paper_id: paperId, meeting_id: meetingId, ...sent,
        parent, compare: compareIds, signal: ctrl.signal,
      });
    } catch (err) {
      if (!ctrl.signal.aborted) {   // 중단은 오류가 아니다
        toast.error(err instanceof Error ? err.message : "AI 오류");
        patchLast((m) => ({ ...m, text: "요청 처리 중 오류가 발생했습니다." }));
        giveBack();
      }
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
      // 중단했으면 흘러온 데까지 그대로 두고 표시만 붙인다(서버도 같은 것을 남긴다).
      // 끊긴 자리가 보이지 않으면 다 쓴 답으로 착각한다.
      patchLast((m) => ({
        ...m,
        pending: false,
        text: ctrl.signal.aborted
          ? (m.text ? `${m.text}\n\n_(여기서 멈췄습니다.)_` : "중단했습니다.")
          : m.text,
      }));
      setBusy(false);
      // 방금 차례가 나무의 **어디에** 붙었는지는 서버가 정한다(id·parent·head).
      // 다시 받아 와야 지도에 나오고, 가지를 갈아탈 수 있다. 실패해도 화면에
      // 흘러온 답은 그대로 있으므로 조용히 넘어간다.
      if (space) {
        try {
          const r = await api.aiSpace(space);
          setMessages(r.messages.map(fromServer));
          setHead(r.head ?? "");
          setLinks(r.links ?? []);
        } catch {
          /* 화면에 보이는 것은 그대로 둔다 */
        }
      }
    }
  }, [attachments, branchFrom, busy, compare, hasContext, meetingId, mode, onClearContext, onRestoreContext, onToolSuccess, paperId, selections, shown, space, transformMessage]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  /** 답 속의 `[[문서 제목]]` 을 눌렀을 때. 문서 화면이 제목으로 찾아 연다
   *  (`?open=`). 이미 문서 화면이면 그 안에서 열리고, 다른 화면이면 옮겨 간다. */
  const openDoc = useCallback((title: string) => {
    // create=0 — 없는 문서를 만들지는 않는다. 여기서 누르는 것은 "읽으러 가기"지
    // "만들기"가 아니다(편집기 안의 위키링크는 없으면 만드는 것이 맞다).
    navigate(`/notes?open=${encodeURIComponent(title)}&create=0`);
  }, [navigate]);

  const clear = useCallback(async () => {
    if (space) await api.aiSpaceClear(space);
    setMessages([]);
    setHead("");
    setLinks([]);
    setBranchFrom(null);
    setCompare([]);
  }, [space]);

  /** 과거 질문을 고쳐 새 가지로 다시 묻는다 — 그 질문의 **부모**에 붙인다. */
  const editAndFork = useCallback((userMsgId: string, text: string) => {
    const me = messages.find((m) => m.id === userMsgId);
    setBranchFrom({
      // 첫 질문이면 부모가 없다 → null(= 대화 맨 앞). "" 로 두면 서버가
      // "가지 안 냄"으로 읽어 끝에 이어 붙인다.
      id: me?.parent ?? null,
      label: (text || "").replace(/\s+/g, " ").trim().slice(0, 40),
    });
    setInput(text);
    setShowTree(false);
    inputRef.current?.focus();
  }, [messages]);

  /** 갈라지는 가지에 AI 가 한 줄 이름을 붙인다(지도에서 누른다). */
  const nameBranches = useCallback(async () => {
    if (!space) return;
    try {
      const r = await api.aiSpaceNameBranches(space);
      const n = Object.keys(r.names ?? {}).length;
      if (n === 0) {
        toast.error("이름을 짓지 못했습니다");
        return;
      }
      setMessages((arr) => arr.map((m) => (
        m.id && r.names[m.id] ? { ...m, branchName: r.names[m.id] } : m
      )));
      toast.ok(`가지 ${n}개에 이름을 붙였습니다`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "이름을 짓지 못했습니다");
    }
  }, [space]);

  const linkMemory = useCallback(async (fromId: string, toId: string, on: boolean) => {
    if (!space) return;
    try {
      await api.aiSpaceLink(space, fromId, toId, on);
      const r = await api.aiSpace(space);
      setLinks(r.links ?? []);
      toast.ok(on ? "기억을 이었습니다 — 다음 질문부터 이 가지의 이야기가 맥락에 들어갑니다"
        : "기억 연결을 풀었습니다");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "잇지 못했습니다");
    }
  }, [space]);

  useImperativeHandle(ref, () => ({
    send: (t: string) => { void send(t); },
    focus: () => inputRef.current?.focus(),
    clear,
  }), [send, clear]);

  const canSend = !busy && (!!input.trim() || hasContext);
  //: 끝자락(잎)이 몇 개인가 = 가지가 몇 갈래인가. 하나뿐이면 지도 단추에 숫자를
  //: 붙이지 않는다 — 가지가 없는데 "1"이 떠 있으면 무슨 수인지 알 수 없다.
  const branchCount = useMemo(() => {
    if (!space) return 0;
    const tree = asTree(messages);
    const parents = new Set(tree.map((m) => m.parent ?? "").filter(Boolean));
    return tree.filter((m) => !parents.has(m.id)).length;
  }, [messages, space]);

  return (
    <div className={`flex min-h-0 flex-col ${className}`}>
      {enabled === false && (
        <div className="mb-3 rounded-md border border-warning/30 bg-warning/10 px-4 py-2.5 text-[13px] text-warning">
          GEMINI_API_KEY가 설정되지 않아 AI가 비활성화되어 있습니다. (.env 확인)
        </div>
      )}

      {/* 대화 지도 — 나무 전체를 보고 가지를 갈아탄다. 대화 위에 접혀 들어간다
          (딴 화면으로 보내면 말풍선과 지도를 나란히 볼 수 없다). */}
      {space && showTree && (
        <div className="mb-2 flex h-[min(48vh,380px)] min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-surface">
          <ConversationTree
            messages={asTree(messages)} head={head} links={links}
            onGo={(id) => { void goTo(id); setShowTree(false); }}
            onEdit={editAndFork}
            onLink={(a, b, on) => void linkMemory(a, b, on)}
            onCompare={(ids) => {
              setCompare(ids);
              setShowTree(false);
              inputRef.current?.focus();
            }}
            onName={nameBranches}
            onClose={() => setShowTree(false)}
            busy={busy}
          />
        </div>
      )}

      <div className="flex-1 space-y-4 overflow-auto pr-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {shown.length === 0 && (
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

        {shown.map((m, i) =>
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
              {/* 이 질문에서 갈라진 가지가 여럿이면 여기서 바로 옮겨 다닌다 —
                  지도를 열지 않고도 "아까 저쪽으로 물어본 것"으로 돌아갈 수 있다. */}
              <BranchSwitch msgs={branchesOf(m.id)} current={m.id} onGo={goTo}
                onEdit={() => editAndFork(m.id!, m.text)} busy={busy} />
            </div>
          ) : (
            <div key={m.id ?? i} className="flex gap-2.5">
              <div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent-muted text-accent">
                <Bot size={15} />
              </div>
              <div className="min-w-0 flex-1 space-y-2">
                {m.steps.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {m.steps.map((s, j) => {
                      // 갈래 아이콘 + 상태 아이콘. 갈래는 "무엇을 했나"(일정·논문·
                      // 단어장…), 상태는 "됐나"를 말한다 — 둘은 다른 물음이라
                      // 하나로 합치면 어느 쪽도 알 수 없다.
                      const Kind = skillIcon(s.name);
                      return (
                        <span key={j} title={s.message}
                          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px] ${
                            s.ok === false ? "border-danger/30 text-danger"
                            : s.ok ? "border-accent/30 bg-accent-muted text-accent-fg"
                            : "border-line text-fg-muted"}`}>
                          <Kind size={11} className="shrink-0 opacity-80" />
                          {SKILL_LABEL[s.name] ?? s.name}
                          {s.ok === undefined ? <Loader2 size={11} className="animate-spin" />
                            : s.ok ? <CheckCircle2 size={11} /> : <XCircle size={11} />}
                        </span>
                      );
                    })}
                  </div>
                )}
                {m.text ? (
                  <div className="card px-4 py-2.5">
                    {/* AI 가 "[[주간정리]] 로 만들었습니다"라고 답할 때, 그 링크가
                        아무 데도 가지 않으면 이름만 알려 주고 끝난 셈이다. */}
                    <MarkdownView content={m.text} onWikiClick={openDoc} />
                    {/* 아직 쓰는 중이면 커서를 남겨 둔다 — 없으면 잘린 답을
                        다 쓴 답으로 착각한다. */}
                    {m.pending && (
                      <span className="ml-0.5 inline-block h-3.5 w-[2px] translate-y-[2px] animate-pulse bg-fg-muted" />
                    )}
                  </div>
                ) : m.pending && m.steps.length === 0 ? (
                  <div className="inline-flex items-center gap-2 text-[13px] text-fg-muted">
                    <Loader2 size={14} className="animate-spin" /> 생각 중…
                  </div>
                ) : null}
                {/* 단어 후보: 고른 것만 서버로 바로 가고 백그라운드에서 채워진다.
                    스킬 이름이 아니라 **후보가 들어 있는지**로 본다 — 허락 없이
                    불린 add_vocab_words 도 저장 대신 후보로 돌아온다.
                    한 답에 목록이 여럿 오면(모델이 함수 호출을 나란히 낸다) 겹치는
                    단어는 앞 목록에만 남긴다 — 두 목록에서 같은 단어를 두 번 넣게
                    되는 것을 막는다. */}
                {dedupeProposals(m.steps).map((p) => (
                  <VocabProposal key={p.key} data={p.data} tags={vocabTags} space={space} />
                ))}
              </div>
            </div>
          ),
        )}
        <div ref={endRef} />
      </div>

      {composerTop && <div className="mt-3">{composerTop}</div>}
      {/* 이번 한 번만 달라지는 것들 — 어디에 붙는지, 무엇을 견주는지. 보내고 나면
          사라진다. 보이지 않으면 "왜 여기에 붙었지"를 알 길이 없다. */}
      {(branchFrom || compare.length > 0) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {branchFrom && (
            <span className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-accent/40 bg-accent-muted px-2 py-1 text-[11.5px] text-accent-fg">
              <GitBranch size={12} className="shrink-0" />
              <span className="truncate">
                {branchFrom.label
                  ? `"${branchFrom.label}" 대신 새 가지로 물어봅니다`
                  : "여기서 새 가지로 물어봅니다"}
                {branchFrom.id === null && " (대화 맨 앞)"}
              </span>
              <button type="button" onClick={() => setBranchFrom(null)} aria-label="새 가지 취소"
                className="grid h-5 w-5 shrink-0 place-items-center rounded-full hover:bg-hovered">
                <X size={12} />
              </button>
            </span>
          )}
          {compare.length > 0 && (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-positive/40 bg-positive/10 px-2 py-1 text-[11.5px] text-positive">
              가지 {compare.length}개를 견줍니다
              <button type="button" onClick={() => setCompare([])} aria-label="비교 취소"
                className="grid h-5 w-5 place-items-center rounded-full hover:bg-hovered">
                <X size={12} />
              </button>
            </span>
          )}
        </div>
      )}
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
        {/* 대화가 서버에 남는 화면에서만 나무가 된다(비서 임시 대화는 새로고침에 사라진다) */}
        {space && (
          <button type="button" onClick={() => setShowTree((v) => !v)}
            aria-label={showTree ? "대화 지도 닫기" : "대화 지도 열기"}
            title="대화 지도 — 가지를 보고 갈아탄다"
            className={`btn h-9 shrink-0 px-3 ${showTree ? "btn-primary" : "btn-ghost"}`}>
            <GitBranch size={15} />
            {branchCount > 1 && (
              <span className="text-[11px] tabular-nums">{branchCount}</span>
            )}
          </button>
        )}
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // Enter=전송, Shift+Enter=줄바꿈. 단 소프트 키보드에서는 Enter가 줄바꿈
            // 키라 Shift+Enter를 칠 방법이 없다 — 터치 기기에서는 전송을 버튼으로만.
            // (한글 조합 중 Enter는 조합 확정이므로 전송하면 마지막 글자가 잘린다)
            if (isSubmitEnter(e) && !e.shiftKey && !touch) {
              e.preventDefault();
              send(input);
            }
            // 답이 흐르는 중 Esc 로도 끊는다(버튼까지 가지 않아도 되게)
            if (e.key === "Escape" && busy) {
              e.preventDefault();
              stop();
            }
          }}
          placeholder={placeholder ?? (touch ? "메시지를 입력하세요…" : "메시지를 입력하세요… (Shift+Enter 줄바꿈)")}
          // 답을 기다리는 동안에도 다음 말을 적어 둘 수 있어야 한다(보내기만 막힌다).
          // 잠가 두면 Esc 로 중단할 방법도 함께 사라진다.
          rows={1}
          className="input flex-1 resize-none !h-auto min-h-[2.25rem] py-2 leading-relaxed [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          style={{ maxHeight: 160, overflowY: "auto" }}
        />
        {busy ? (
          // 답이 길거나 엉뚱하게 흘러갈 때 끊을 수 있어야 한다. 여기까지 온 답은
          // 지우지 않고 남긴다(서버도 같은 것을 기록에 넣는다).
          <button onClick={stop} className="btn btn-ghost h-9 px-4" aria-label="중단">
            <Square size={14} fill="currentColor" />
          </button>
        ) : (
          <button onClick={() => send(input)} disabled={!canSend} className="btn btn-primary h-9 px-4" aria-label="보내기">
            <Send size={16} />
          </button>
        )}
      </div>
    </div>
  );
});
