import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, X, Ban, Trash2, Loader2, UserCheck, KeyRound, Copy } from "lucide-react";
import { api, AdminUser } from "../../lib/api";
import { toast } from "../../store/toast";

const STATUS_LABEL: Record<AdminUser["status"], string> = {
  pending: "승인 대기",
  active: "사용 중",
  rejected: "거절됨",
  disabled: "비활성",
};

/** 관리자 전용 계정 관리 — 가입 승인 대기열이 맨 위에 온다. */
export function AccountAdmin({ me }: { me: string }) {
  const [pending, setPending] = useState<AdminUser[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  //: 사용자 → 이번 달 토큰. 계정 목록과 따로 받아서, 사용량 집계가 실패해도
  //: 계정 관리 자체는 그대로 쓸 수 있게 둔다.
  const [tokens, setTokens] = useState<Record<string, number>>({});
  //: 방금 만든 임시 비밀번호 — 서버는 한 번만 돌려주고 어디에도 평문으로 남기지 않는다.
  //: 닫거나 화면을 떠나면 다시 볼 수 없다(다시 만들면 된다).
  const [issued, setIssued] = useState<{ username: string; password: string } | null>(null);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    try {
      const r = await api.adminUsers();
      setPending(r.pending);
      setUsers(r.users);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "계정 목록을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
    try {
      const u = await api.usageUsers();
      setTokens(Object.fromEntries(u.users.map((x) => [x.username, x.tokens])));
    } catch {
      /* 토큰을 못 받아도 목록은 보여 준다 */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (username: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(username);
    try {
      await fn();
      toast.ok(ok);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "처리에 실패했습니다.");
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-6 text-fg-muted">
        <Loader2 size={15} className="animate-spin" /> 불러오는 중…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section>
        <p className="label mb-2 flex items-center gap-1.5">
          <UserCheck size={13} /> 승인 대기 {pending.length > 0 && `(${pending.length})`}
        </p>
        {pending.length === 0 ? (
          <p className="rounded-md border border-dashed border-line py-6 text-center text-[13px] text-fg-muted">
            대기 중인 가입 신청이 없습니다
          </p>
        ) : (
          <ul className="space-y-2">
            {pending.map((u) => (
              <li key={u.username}
                  className="flex items-center gap-3 rounded-md border border-warning/30 bg-warning/5 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13.5px] font-medium">{u.display_name}</p>
                  <p className="truncate text-[11.5px] text-fg-muted">@{u.username}</p>
                </div>
                <button disabled={busy === u.username} className="btn btn-primary h-8"
                  onClick={() => act(u.username, () => api.adminApprove(u.username), `${u.username} 승인됨`)}>
                  <Check size={14} /> 승인
                </button>
                <button disabled={busy === u.username} className="btn btn-ghost h-8 hover:text-danger"
                  onClick={() => act(u.username, () => api.adminReject(u.username), `${u.username} 거절됨`)}>
                  <X size={14} /> 거절
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <p className="label mb-2">계정 {users.length}</p>
        {issued && (
          <div role="status" className="mb-3 rounded-md border border-accent/40 bg-accent-muted px-3 py-2.5 text-[13px]">
            <p>
              <span className="font-medium">@{issued.username}</span> 의 임시 비밀번호
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <code className="select-all rounded border border-line bg-surface px-2 py-1 font-mono text-[14px] tracking-wide">
                {issued.password}
              </code>
              <button className="btn btn-secondary h-8"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(issued.password);
                    toast.ok("복사했습니다");
                  } catch {
                    // 집 안 LAN(http)은 안전한 출처가 아니라 클립보드 API 가 없다 — 글자는 select-all 이다
                    toast.error("복사하지 못했습니다. 직접 선택해 복사하세요.");
                  }
                }}>
                <Copy size={14} /> 복사
              </button>
              <button className="btn btn-ghost h-8" aria-label="임시 비밀번호 닫기" onClick={() => setIssued(null)}>
                <X size={14} />
              </button>
            </div>
            <p className="mt-1.5 text-[12px] text-fg-muted">
              이 사람에게 전하고, 로그인한 뒤 설정 › 계정 › 로그인 비밀번호에서 자기 비밀번호로 바꾸게 하세요. 닫으면 다시 볼 수 없습니다.
            </p>
          </div>
        )}
        <ul className="divide-y divide-line">
          {users.map((u) => (
            <li key={u.username} className="flex items-center gap-3 py-2.5">
              {/* 이름을 누르면 그 사람의 **수치** 화면으로. 목록에는 이번 달
                  토큰 말고 아무 수치도 싣지 않는다(자료는 어느 쪽에도 없다). */}
              <button
                type="button"
                onClick={() => navigate(`/analytics?u=${encodeURIComponent(u.username)}`)}
                className="min-w-0 flex-1 rounded-md px-1 py-0.5 text-left hover:bg-hovered"
                title={`${u.username} 사용량 보기`}
              >
                <p className="truncate text-[13.5px] font-medium">
                  {u.display_name}
                  {u.username === me && <span className="ml-1.5 text-[11px] text-accent">(나)</span>}
                  <span className="ml-2 text-[11px] font-normal tabular-nums text-fg-muted">
                    {tokens[u.username] === undefined
                      ? "…"
                      : `이번 달 ${tokens[u.username].toLocaleString()} 토큰`}
                  </span>
                </p>
                <p className="truncate text-[11.5px] text-fg-muted">
                  @{u.username} · {u.role === "admin" ? "관리자" : "사용자"} · {STATUS_LABEL[u.status]}
                </p>
              </button>
              {u.status === "active" && (
                <button disabled={busy === u.username} className="btn btn-ghost h-8 hover:text-danger"
                  title="비활성화 (세션도 즉시 만료됩니다)"
                  onClick={() => act(u.username, () => api.adminDisable(u.username), `${u.username} 비활성화됨`)}>
                  <Ban size={14} />
                </button>
              )}
              {/* 서버 주인 계정(나·다른 주인)은 여기서 바꾸지 않는다 — 설정에서 지금 비밀번호로(서버도 400) */}
              {u.origin !== "bootstrap" && (
                <button disabled={busy === u.username} className="btn btn-ghost h-8"
                  title="임시 비밀번호 만들기 (그 사람은 모든 기기에서 로그아웃됩니다)"
                  aria-label={`${u.username} 임시 비밀번호 만들기`}
                  onClick={() => {
                    if (!confirm(
                      `'${u.username}' 에게 새 임시 비밀번호를 만들까요?\n\n` +
                      `지금 비밀번호는 더 이상 통하지 않고, 이 사람은 모든 기기에서 로그아웃됩니다.`,
                    )) return;
                    act(u.username, async () => {
                      const r = await api.adminResetPassword(u.username);
                      setIssued({ username: r.username, password: r.temporary_password });
                    }, `${u.username} 임시 비밀번호를 만들었습니다`);
                  }}>
                  <KeyRound size={14} />
                </button>
              )}
              {u.status !== "active" && (
                <button disabled={busy === u.username} className="btn btn-ghost h-8"
                  title="다시 승인"
                  onClick={() => act(u.username, () => api.adminApprove(u.username), `${u.username} 승인됨`)}>
                  <Check size={14} />
                </button>
              )}
              {/* 문구는 **실제 동작**을 말해야 한다. 예전에는 "문서는 남습니다"였는데,
                  지금은 그 사람의 벌트 전체가 앱 밖(deleted-users/)으로 옮겨진다 —
                  앱에서는 사라지고, 되돌리는 버튼도 없다. */}
              <button disabled={busy === u.username} className="btn btn-ghost h-8 hover:text-danger"
                title="계정 삭제 (문서·일정·할 일이 앱에서 사라집니다)"
                onClick={() => {
                  if (!confirm(
                    `'${u.username}' 계정을 삭제할까요?\n\n` +
                    `이 사람의 문서·일정·할 일·설정이 앱에서 사라집니다.\n` +
                    `서버에는 deleted-users/ 로 옮겨져 남지만, 앱에서 되돌릴 수는 없습니다.`,
                  )) return;
                  act(u.username, async () => {
                    const r = await api.adminDelete(u.username);
                    // 어디로 옮겼는지 알려 준다 — 되돌리려면 이 경로가 필요하다.
                    const moved = (r as { data_moved_to?: string } | undefined)?.data_moved_to;
                    if (moved) toast.ok(`데이터를 ${moved} 로 옮겼습니다`);
                    return r;
                  }, `${u.username} 삭제됨`);
                }}>
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
