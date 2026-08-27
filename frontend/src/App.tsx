import { lazyChunk } from "./lib/lazyChunk";
import { Suspense, useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useAuth } from "./store/auth";
import { useSettings } from "./store/settings";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { Toaster } from "./components/ui/Toaster";
import { ReminderPoller } from "./components/ReminderPoller";

// 무거운 라우트는 코드 분할(지연 로드) — 초기 번들 축소
// 라우트별 동적 import 썽크 — lazy()와 프리페치에 함께 사용
const loaders = {
  notes: () => import("./pages/Notes"),
  graph: () => import("./pages/Graph"),
  calendar: () => import("./pages/Calendar"),
  assistant: () => import("./pages/Assistant"),
  settings: () => import("./pages/Settings"),
  profile: () => import("./pages/Profile"),
  trash: () => import("./pages/Trash"),
  terminal: () => import("./pages/Terminal"),
};

const Notes = lazyChunk(() => loaders.notes().then((m) => ({ default: m.Notes })));
const Graph = lazyChunk(() => loaders.graph().then((m) => ({ default: m.Graph })));
const Calendar = lazyChunk(() => loaders.calendar().then((m) => ({ default: m.Calendar })));
const Assistant = lazyChunk(() => loaders.assistant().then((m) => ({ default: m.Assistant })));
const Settings = lazyChunk(() => loaders.settings().then((m) => ({ default: m.Settings })));
const Profile = lazyChunk(() => loaders.profile().then((m) => ({ default: m.Profile })));
const Trash = lazyChunk(() => loaders.trash().then((m) => ({ default: m.Trash })));
const TerminalPage = lazyChunk(() => loaders.terminal().then((m) => ({ default: m.TerminalPage })));

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
        <Route path="/assistant" element={<Assistant />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="/trash" element={<Trash />} />
        <Route path="/terminal" element={isOwner ? <TerminalPage /> : <Navigate to="/notes" replace />} />
        <Route path="*" element={<Navigate to={isOwner ? "/" : "/notes"} replace />} />
      </Routes>
    </Suspense>
  );
}

export default function App() {
  const { session, loading, init, tick, refresh } = useAuth();

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

  return (
    <>
      {session ? (
        <BrowserRouter>
          <AuthedRoutes />
          <ReminderPoller />
        </BrowserRouter>
      ) : (
        <Login />
      )}
      <Toaster />
    </>
  );
}
