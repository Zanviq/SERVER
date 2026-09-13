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
    // 대화가 여럿이 됐으므로 **지금 대화만** 비운다고 분명히 말한다 —
    // "모두 지울까요?"라고 물어 놓고 하나만 비우면 거짓말이 된다.
    if (!confirm("지금 보고 있는 대화를 비울까요? (다른 대화는 그대로 남습니다)")) return;
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
      {/* 넓으면 왼쪽 대화 목록 · 가운데 채팅 · 오른쪽 대화 지도로 편다.
          좁아지면 목록은 채팅 위 드롭다운으로, 지도는 팝업으로 돌아간다.

          **폭을 묶지 않는다.** 예전에는 max-w 로 가운데 정렬해 두어서, 화면을
          축소하면(=CSS 픽셀이 넓어지면) 좌우에 빈 띠가 크게 남았다 — 다른 화면들은
          모두 꽉 채우는데 여기만 달랐다. */}
      <ChatPanel ref={chat} className="h-view-9 w-full"
        mode="assistant" space="assistant" sidebars />
    </Shell>
  );
}