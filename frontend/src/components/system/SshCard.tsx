import { useEffect, useState } from "react";
import { Check, Copy, TerminalSquare } from "lucide-react";
import { api, SshAccess } from "../../lib/api";
import { toast } from "../../store/toast";

/**
 * 외부 SSH 접속 안내(주인 전용). 서버는 Cloudflare Tunnel 로 22번을 내보내고
 * (포트 개방 없음), 클라이언트는 cloudflared 를 ProxyCommand 로 써서 들어온다.
 */
export function SshCard() {
  const [info, setInfo] = useState<SshAccess | null>(null);
  const [copied, setCopied] = useState<"config" | "cmd" | null>(null);

  useEffect(() => {
    api.sshAccess().then(setInfo).catch(() => setInfo(null));
  }, []);
  if (!info) return null;

  const copy = async (what: "config" | "cmd", text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      toast.error("복사하지 못했습니다. 직접 선택해 복사하세요.");
    }
  };

  return (
    <section className="card overflow-hidden">
      <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <span className="flex items-center gap-1.5 text-sm font-semibold">
          <TerminalSquare size={15} className="text-accent" /> 외부 SSH 접속
        </span>
        <span className={`badge ${info.configured ? "badge-accent" : ""}`}>
          {info.configured ? info.hostname : "미설정"}
        </span>
      </header>
      <div className="space-y-3 p-4 text-[12.5px]">
        {info.configured ? (
          <>
            <p className="text-fg-muted">
              아래를 <code className="rounded bg-subtle px-1">~/.ssh/config</code> 에 넣고{" "}
              <code className="rounded bg-subtle px-1">{info.command}</code> 로 접속합니다.
              클라이언트에 <code className="rounded bg-subtle px-1">cloudflared</code> 가 설치돼 있어야 합니다.
            </p>
            <div className="relative">
              <pre className="overflow-x-auto rounded-md border border-line bg-subtle p-3 font-mono text-[12px] leading-relaxed">{info.ssh_config}</pre>
              <button type="button" onClick={() => copy("config", info.ssh_config)}
                className="btn btn-ghost absolute right-1.5 top-1.5 h-7 gap-1 px-2 text-[11px]" title="설정 복사">
                {copied === "config" ? <Check size={12} className="text-positive" /> : <Copy size={12} />} 복사
              </button>
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded-md border border-line bg-subtle px-3 py-1.5 font-mono text-[12px]">{info.command}</code>
              <button type="button" onClick={() => copy("cmd", info.command)} className="btn btn-secondary h-8 gap-1 px-2 text-[11.5px]">
                {copied === "cmd" ? <Check size={12} className="text-positive" /> : <Copy size={12} />} 복사
              </button>
            </div>
            <p className="text-[11.5px] text-fg-subtle">
              터널은 <code>{info.service}</code> 로 라즈베리파이의 sshd 를 가리킵니다(포트포워딩 없음). 키 파일 이름이 다르면 IdentityFile 을 고치세요.
            </p>
          </>
        ) : (
          <ol className="list-decimal space-y-1 pl-5 text-fg-muted">
            <li>Cloudflare 대시보드 → 터널 → Public Hostname 에 <code className="rounded bg-subtle px-1">ssh.&lt;도메인&gt;</code> → <code className="rounded bg-subtle px-1">{info.service}</code> 를 추가합니다.</li>
            <li><code className="rounded bg-subtle px-1">.env</code> 에 <code className="rounded bg-subtle px-1">SSH_PUBLIC_HOSTNAME</code>·<code className="rounded bg-subtle px-1">SSH_USER</code> 를 적고 백엔드를 다시 띄우면 여기에 클라이언트 설정이 뜹니다.</li>
            <li>클라이언트에는 <code className="rounded bg-subtle px-1">cloudflared</code> 를 설치합니다(ProxyCommand 로 씁니다).</li>
          </ol>
        )}
      </div>
    </section>
  );
}
