import { FormEvent, useState } from "react";
import { Lock, Loader2, ServerCog } from "lucide-react";
import { useAuth } from "../store/auth";
import { ThemeToggle } from "../components/layout/ThemeToggle";

export function Login() {
  const { login, error, clearError } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    await login(username.trim(), password);
    setBusy(false);
  };

  return (
    <div className="flex h-full items-center justify-center bg-bg px-4">
      <div className="absolute right-5 top-5">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm animate-in">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 grid h-14 w-14 place-items-center rounded-xl bg-accent text-accent-contrast shadow-md">
            <ServerCog size={26} />
          </div>
          <h1 className="text-xl font-bold tracking-tight">TwoMES</h1>
          <p className="mt-1 text-[13px] text-fg-muted">개인 홈서버 워크스페이스</p>
        </div>

        <form onSubmit={submit} className="card p-6 shadow-md">
          <label className="label mb-1 block">아이디</label>
          <input
            className="input mb-3"
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              if (error) clearError();
            }}
            autoFocus
            autoComplete="username"
            placeholder="아이디"
          />
          <label className="label mb-1 block">비밀번호</label>
          <div className="relative">
            <Lock
              size={15}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle"
            />
            <input
              type="password"
              className="input mb-3 pl-9"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              placeholder="비밀번호"
            />
          </div>

          {error && (
            <p className="mb-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy || !username || !password}
            className="btn btn-primary w-full"
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Lock size={15} />}
            로그인
          </button>
        </form>

        <p className="mt-4 text-center text-[11px] text-fg-subtle">
          계정은 서버 관리자가 .env에서 설정합니다.
        </p>
      </div>
    </div>
  );
}
