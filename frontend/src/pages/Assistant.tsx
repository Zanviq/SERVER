import { useRef } from "react";
import { Trash2 } from "lucide-react";
import { Shell } from "../components/layout/Shell";
import { ChatPanel, ChatPanelHandle } from "../components/ai/ChatPanel";
import { toast } from "../store/toast";

/**
 * AI 비서. 대화는 서버(chats/assistant.json)에 남는다 — 예전에는 브라우저에만
 * 있어서 새로고침하면 사라졌고, 다음 날 "어제 말한 그거"가 닿지 않았다.
 * 모델에 자동으로 들어가는 것은 최근 하루치이고, 그보다 옛날은 컨텍스트 스킬로 꺼낸다.
 */
export function Assistant() {
  const chat = useRef<ChatPanelHandle>(null);

  const clearChat = async () => {
    if (!confirm("비서와 나눈 대화를 모두 지울까요?")) return;
    try {
      await chat.current?.clear();
      toast.ok("대화를 비웠습니다");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "지우지 못했습니다");
    }
  };

  return (
    <Shell
      title="AI 비서"
      actions={
        <button onClick={clearChat} className="btn btn-ghost h-8 px-2" title="대화 비우기" aria-label="대화 비우기">
          <Trash2 size={15} />
        </button>
      }
    >
      <ChatPanel ref={chat} className="mx-auto h-view-9 max-w-3xl" mode="assistant" space="assistant" />
    </Shell>
  );
}