import { useRef, useState } from "react";
import { BookMarked, MessageSquare, Trash2 } from "lucide-react";
import { Shell } from "../components/layout/Shell";
import { ThreePane } from "../components/notes/ThreePane";
import { ChatPanel, ChatPanelHandle } from "../components/ai/ChatPanel";
import { VocabPanel } from "../components/vocab/VocabPanel";
import { toast } from "../store/toast";

const SUGGESTIONS = [
  "adequate",
  "이 문장 분석해줘: Inaccurately defined personas sometimes hinder LLMs and degrade their reasoning.",
  "오늘 복습할 단어로 퀴즈 내줘",
  "최근에 넣은 단어 5개로 짧은 글 써줘",
];

/** 이 화면에서 넣는 것의 기본 출처 태그. 백엔드(modes.ENGLISH_TAG)와 같은 값이어야 한다. */
const ENGLISH_TAG = ["영어 학습"];

/**
 * 영어 학습: 왼쪽은 튜터와 대화, 오른쪽은 단어장.
 * 대화에서 "단어장에 넣어줘" 하면 AI가 사전 형식으로 채워 넣고, 단어장이 바로 갱신된다.
 */
export function English() {
  const chat = useRef<ChatPanelHandle>(null);
  const [vocabKey, setVocabKey] = useState(0);
  // 모바일은 한 번에 하나 — 대화 ↔ 단어장
  const [mobileView, setMobileView] = useState<"chat" | "vocab">("chat");

  const clearChat = async () => {
    if (!confirm("영어 학습 대화를 모두 지울까요? 단어장은 그대로 남습니다.")) return;
    try {
      await chat.current?.clear();
      toast.ok("대화를 비웠습니다");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "지우지 못했습니다");
    }
  };

  const actions = (
    <>
      <div className="flex rounded-md border border-line p-0.5 lg:hidden" role="tablist">
        <button role="tab" aria-selected={mobileView === "chat"} onClick={() => setMobileView("chat")}
          className={`rounded-sm px-2 py-1 text-[12px] ${mobileView === "chat" ? "bg-accent-muted text-accent-fg" : "text-fg-muted"}`}>
          <MessageSquare size={13} className="mr-1 inline" />대화
        </button>
        <button role="tab" aria-selected={mobileView === "vocab"} onClick={() => setMobileView("vocab")}
          className={`rounded-sm px-2 py-1 text-[12px] ${mobileView === "vocab" ? "bg-accent-muted text-accent-fg" : "text-fg-muted"}`}>
          <BookMarked size={13} className="mr-1 inline" />단어장
        </button>
      </div>
      <button onClick={clearChat} className="btn btn-ghost h-8 px-2" title="대화 비우기" aria-label="대화 비우기">
        <Trash2 size={15} />
      </button>
    </>
  );

  return (
    <Shell title="영어 학습" actions={actions}>
      <ThreePane storageKey="english.panes.v1" side="right" showDetail={mobileView === "chat"}>
        <VocabPanel refreshKey={vocabKey} defaultTags={ENGLISH_TAG} className="h-view-11 lg:h-auto" />
        <div className="card flex h-view-11 flex-col overflow-hidden p-3 lg:h-auto">
          <ChatPanel
            ref={chat}
            className="flex-1"
            mode="english"
            space="english"
            suggestions={SUGGESTIONS}
            vocabTags={ENGLISH_TAG}
            emptyTitle="영어 튜터"
            emptySubtitle="단어·문장을 보내면 뜻·유의어·예문·문법을 풀어 주고, 원하면 단어장에 넣어 줍니다"
            placeholder="단어나 문장을 보내 보세요…"
            onToolSuccess={(mutated) => { if (mutated === "vocab") setVocabKey((k) => k + 1); }}
          />
        </div>
      </ThreePane>
    </Shell>
  );
}
