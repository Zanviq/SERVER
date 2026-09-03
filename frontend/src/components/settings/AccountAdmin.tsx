import { useCallback, useEffect, useState } from "react";
import { Check, X, Ban, Trash2, Loader2, UserCheck } from "lucide-react";
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
        <ul className="divide-y divide-line">
          {users.map((u) => (
            <li key={u.username} className="flex items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13.5px] font-medium">
                  {u.display_name}
                  {u.username === me && <span className="ml-1.5 text-[11px] text-accent">(나)</span>}
                </p>
                <p className="truncate text-[11.5px] text-fg-muted">
                  @{u.username} · {u.role === "admin" ? "관리자" : "사용자"} · {STATUS_LABEL[u.status]}
                </p>
              </div>
              {u.status === "active" && (
                <button disabled={busy === u.username} className="btn btn-ghost h-8 hover:text-danger"
                  title="비활성화 (세션도 즉시 만료됩니다)"
                  onClick={() => act(u.username, () => api.adminDisable(u.username), `${u.username} 비활성화됨`)}>
                  <Ban size={14} />
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
