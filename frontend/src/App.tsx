import { lazyChunk } from "./lib/lazyChunk";
import { Suspense, useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { CloudOff, Loader2, RefreshCw } from "lucide-react";
import { useAuth } from "./store/auth";
import { useSettings } from "./store/settings";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { Toaster } from "./components/ui/Toaster";
import { ReminderPoller } from "./components/ReminderPoller";
import { SearchPalette } from "./components/search/SearchPalette";
import { startPageTiming, trackRoute } from "./lib/pageTiming";

// 무거운 라우트는 코드 분할(지연 로드) — 초기 번들 축소
// 라우트별 동적 import 썽크 — lazy()와 프리페치에 함께 사용
const loaders = {
  notes: () => import("./pages/Notes"),
  graph: () => import("./pages/Graph"),
  calendar: () => import("./pages/Calendar"),
  todo: () => import("./pages/Todo"),
  assistant: () => import("./pages/Assistant"),
  english: () => import("./pages/English"),
  papers: () => import("./pages/Papers"),
  meetings: () => import("./pages/Meetings"),
  settings: () => import("./pages/Settings"),
  profile: () => import("./pages/Profile"),
  trash: () => import("./pages/Trash"),
  context: () => import("./pages/Context"),
  analytics: () => import("./pages/Analytics"),
  terminal: () => import("./pages/Terminal"),
};

const Notes = lazyChunk(() => loaders.notes().then((m) => ({ default: m.Notes })));
const Graph = lazyChunk(() => loaders.graph().then((m) => ({ default: m.Graph })));
const Calendar = lazyChunk(() => loaders.calendar().then((m) => ({ default: m.Calendar })));
const Todo = lazyChunk(() => loaders.todo().then((m) => ({ default: m.Todo })));
const Assistant = lazyChunk(() => loaders.assistant().then((m) => ({ default: m.Assistant })));
const English = lazyChunk(() => loaders.english().then((m) => ({ default: m.English })));
const Papers = lazyChunk(() => loaders.papers().then((m) => ({ default: m.Papers })));
const Meetings = lazyChunk(() => loaders.meetings().then((m) => ({ default: m.Meetings })));
const Settings = lazyChunk(() => loaders.settings().then((m) => ({ default: m.Settings })));
const Profile = lazyChunk(() => loaders.profile().then((m) => ({ default: m.Profile })));
const Trash = lazyChunk(() => loaders.trash().then((m) => ({ default: m.Trash })));
const ContextPage = lazyChunk(() => loaders.context().then((m) => ({ default: m.Context })));
const TerminalPage = lazyChunk(() => loaders.terminal().then((m) => ({ default: m.TerminalPage })));
const Analytics = lazyChunk(() => loaders.analytics().then((m) => ({ default: m.Analytics })));

/** 로그인 후 유휴 시간에 모든 라우트 청크를 미리 로드 → 페이지 이동 지연 제거 */
function prefetchRoutes() {
  const run = () => Object.values(loaders).forEach((l) => l().catch(() => {}));
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback;
  if (ric) ric(run);
  else setTimeout(run, 1500);
}

function Spinner() {
  return (
    <div className="flex h-full items-center justify-center text-fg-muted">
      <Loader2 size={22} className="animate-spin" />
    </div>
  );
}

/** 화면 이동을 사용량에 기록한다(화면 이름과 머문 초만 나간다). */
function PageTiming() {
  const { pathname } = useLocation();
  useEffect(() => startPageTiming(), []);
  useEffect(() => { trackRoute(pathname); }, [pathname]);
  return null;
}

function AuthedRoutes() {
  // 대시보드·터미널은 .env로 만들어진 서버 주인 전용.
  // '/'는 catch-all의 목적지이기도 하므로, 주인이 아니면 두 경로 모두 문서로 보낸다.
  const isOwner = useAuth((st) => st.session?.origin === "bootstrap" && st.session?.role === "admin");
  const home = isOwner ? <Dashboard /> : <Navigate to="/notes" replace />;
  return (
    <Suspense fallback={<Spinner />}>
      <Routes>
        <Route path="/" element={home} />
        <Route path="/notes" element={<Notes />} />
        <Route path="/graph" element={<Graph />} />
        <Route path="/calendar" element={<Calendar />} />
        <Route path="/todo" element={<Todo />} />
        <Route path="/assistant" element={<Assistant />} />
        <Route path="/english" element={<English />} />
        <Route path="/papers" element={<Papers />} />
        <Route path="/meetings" element={<Meetings />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="/trash" element={<Trash />} />
        <Route path="/context" element={<ContextPage />} />
        {/* 사용량은 주인 전용이다 — 백엔드도 require_owner 로 다시 막는다 */}
        <Route path="/analytics" element={isOwner ? <Analytics /> : <Navigate to="/notes" replace />} />
        <Route path="/terminal" element={isOwner ? <TerminalPage /> : <Navigate to="/notes" replace />} />
        <Route path="*" element={<Navigate to={isOwner ? "/" : "/notes"} replace />} />
      </Routes>
    </Suspense>
  );
}

/**
 * 서버에 닿지 못했을 때. **로그인 화면을 보여 주면 안 된다** — 쿠키는 멀쩡한데
 * 사용자는 로그아웃된 줄 알고 비밀번호를 다시 치고, 그것도 실패하니 계정이
 * 잘못된 줄 안다. 배포할 때마다 컨테이너가 재시작하므로 드문 일도 아니다.
 */
function Offline({ onRetry }: { onRetry: () => void }) {
  const [busy, setBusy] = useState(false);
  const retry = async () => {
    setBusy(true);
    await onRetry();
    setBusy(false);
  };
  return (
    <div className="grid min-h-screen place-items-center bg-bg p-6">
      <div className="card w-full max-w-sm space-y-3 p-6 text-center">
        <CloudOff size={28} className="mx-auto text-fg-subtle" />
        <p className="text-[14px] font-semibold">서버에 닿지 못했습니다</p>
        <p className="text-[12.5px] leading-relaxed text-fg-muted">
          로그아웃된 것이 아닙니다. 서버가 다시 켜지는 중이거나 네트워크가 끊겼을 수 있습니다.
          잠시 뒤 다시 시도해 주세요.
        </p>
        <button type="button" onClick={retry} disabled={busy} className="btn btn-primary mx-auto gap-2">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} 다시 시도
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const { session, loading, offline, init, tick, refresh, retryInit } = useAuth();

  useEffect(() => {
    init();
  }, [init]);

  // 로그인되면 개인 설정 로드 + 라우트 프리페치
  useEffect(() => {
    if (session) {
      useSettings.getState().load();
      prefetchRoutes();
    }
  }, [session]);

  useEffect(() => {
    if (!session) return;
    const t = setInterval(tick, 1000);
    const r = setInterval(refresh, 60000);
    return () => {
      clearInterval(t);
      clearInterval(r);
    };
  }, [session, tick, refresh]);

  if (loading) return <Spinner />;
  if (offline) return <><Offline onRetry={retryInit} /><Toaster /></>;

  return (
    <>
      {session ? (
        <BrowserRouter>
          <AuthedRoutes />
          <PageTiming />
          {/* 화면마다 껍데기가 달라서(노트·논문은 Shell 을 쓰지 않는다) 여기에 둔다 */}
          <SearchPalette />
          <ReminderPoller />
        </BrowserRouter>
      ) : (
        <Login />
      )}
      <Toaster />
    </>
  );
}
