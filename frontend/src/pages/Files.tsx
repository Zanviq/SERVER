import { useState } from "react";
import { Users, User } from "lucide-react";
import { Shell } from "../components/layout/Shell";
import { FileExplorer } from "../components/files/FileExplorer";
import { Scope } from "../lib/api";
import { toast } from "../store/toast";
import { useSettings } from "../store/settings";

export function Files() {
  const defaultScope = useSettings((s) => s.settings?.files.default_scope);
  const [scope, setScope] = useState<Scope>((defaultScope as Scope) || "common");
  return (
    <Shell
      title="파일"
      actions={
        <div className="inline-flex rounded-md border border-line bg-subtle p-0.5">
          <button
            onClick={() => setScope("common")}
            className={`inline-flex items-center gap-1.5 rounded-sm px-3 py-1 text-[13px] font-medium transition-colors ${
              scope === "common" ? "bg-surface text-accent shadow-sm" : "text-fg-muted hover:text-fg"
            }`}
          >
            <Users size={14} /> 공통
          </button>
          <button
            onClick={() => setScope("me")}
            className={`inline-flex items-center gap-1.5 rounded-sm px-3 py-1 text-[13px] font-medium transition-colors ${
              scope === "me" ? "bg-surface text-accent shadow-sm" : "text-fg-muted hover:text-fg"
            }`}
          >
            <User size={14} /> 내 폴더
          </button>
        </div>
      }
    >
      <FileExplorer key={scope} scope={scope} onError={toast.error} onToast={toast.ok} />
    </Shell>
  );
}
