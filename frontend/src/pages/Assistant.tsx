import { Shell } from "../components/layout/Shell";
import { ChatPanel } from "../components/ai/ChatPanel";

export function Assistant() {
  return (
    <Shell title="AI 비서">
      <ChatPanel className="mx-auto h-view-9 max-w-3xl" />
    </Shell>
  );
}
