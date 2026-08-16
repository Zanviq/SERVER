import { FormEvent, useState } from "react";
import { Lock, Loader2, ServerCog, UserPlus, CheckCircle2 } from "lucide-react";
import { useAuth } from "../store/auth";
import { ThemeToggle } from "../components/layout/ThemeToggle";
import { api } from "../lib/api";

type Mode = "login" | "signup";

export function Login() {
  const { login, error, clearError } = useAuth();
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [signupError, setSignupError] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const switchMode = (m: Mode) => {
    setMode(m);
    setPassword("");
    setSignupError("");
    clearError();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    if (mode === "login") {
      await login(username.trim(), password);
    } else {
      setSignupError("");
      try {
        await api.signup(username.trim().toLowerCase(), password, displayName.trim());
        setSubmitted(true);
      } catch (err) {
        setSignupError(err instanceof Error ? err.message : "가입 신청에 실패했습니다.");
      }
    }
    setBusy(false);
  };

  const shell = (children: React.ReactNode) => (
    <div className="flex h-full items-center justify-center bg-bg px-4">
      <div className="absolute right-5 top-5">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm animate-in">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 grid h-14 w-14 place-items-center rounded-xl bg-accent text-accent-contrast shadow-md">
            <ServerCog size={26} />
          </div>
          <h1 className="text-xl font-bold tracking-tight">SERVER</h1>
          <p className="mt-1 text-[13px] text-fg-muted">개인 홈서버 워크스페이스</p>
        </div>
        {children}
      </div>
    </div>
  );

  // 신청 완료 — 승인 전에는 로그인할 수 없으므로 그 사실을 분명히 알린다
  if (submitted) {
    return shell(
      <div className="card p-6 text-center shadow-md">
        <CheckCircle2 size={30} className="mx-auto mb-3 text-positive" />
        <p className="text-[14px] font-medium">가입 신청이 접수되었습니다</p>
        <p className="mt-2 text-[13px] leading-relaxed text-fg-muted">
          관리자가 승인하면 로그인할 수 있습니다.
          <br />
          승인 전까지는 로그인이 거부됩니다.
        </p>
        <button
          onClick={() => {
            setSubmitted(false);
            switchMode("login");
          }}
          className="btn btn-secondary mt-4 w-full"
        >
          로그인으로 돌아가기
        </button>
      </div>,
    );
  }

  const shown = mode === "login" ? error : signupError;

  return shell(
    <>
      <div className="mb-3 inline-flex w-full rounded-md border border-line bg-subtle p-0.5">
        {(["login", "signup"] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => switchMode(m)}
            className={`flex-1 rounded-sm px-3 py-1.5 text-[13px] font-medium transition-colors ${
              mode === m ? "bg-surface text-accent shadow-sm" : "text-fg-muted hover:text-fg"
            }`}
          >
            {m === "login" ? "로그인" : "회원가입"}
          </button>
        ))}
      </div>

      <form onSubmit={submit} className="card p-6 shadow-md">
        <label className="label mb-1 block">아이디</label>
        <input
          className="input mb-3"
          value={username}
          onChange={(e) => {
            setUsername(e.target.value);
            if (error) clearError();
            setSignupError("");
          }}
          autoFocus
          autoComplete="username"
          placeholder={mode === "signup" ? "영문 소문자·숫자·_·- 3~32자" : "아이디"}
        />

        {mode === "signup" && (
          <>
            <label className="label mb-1 block">표시 이름 (선택)</label>
            <input
              className="input mb-3"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="비워두면 아이디를 사용합니다"
            />
          </>
        )}

        <label className="label mb-1 block">비밀번호</label>
        <div className="relative">
          <Lock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <input
            type="password"
            className="input mb-3 pl-9"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            placeholder={mode === "signup" ? "8자 이상" : "비밀번호"}
          />
        </div>

        {shown && (
          <p className="mb-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">
            {shown}
          </p>
        )}

        <button
          type="submit"
          disabled={busy || !username || !password}
          className="btn btn-primary w-full"
        >
          {busy ? (
            <Loader2 size={15} className="animate-spin" />
          ) : mode === "login" ? (
            <Lock size={15} />
          ) : (
            <UserPlus size={15} />
          )}
          {mode === "login" ? "로그인" : "가입 신청"}
        </button>
      </form>

      <p className="mt-4 text-center text-[11px] leading-relaxed text-fg-subtle">
        개인 서버입니다. 가입은 신청만 가능하며 관리자 승인 후 이용할 수 있습니다.
      </p>
    </>,
  );
}
