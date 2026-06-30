import { lazy, Suspense, useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useAuth } from "./store/auth";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { Files } from "./pages/Files";
import { Toaster } from "./components/ui/Toaster";

// 무거운 라우트는 코드 분할(지연 로드) — 초기 번들 축소
const Notes = lazy(() => import("./pages/Notes").then((m) => ({ default: m.Notes })));
const Graph = lazy(() => import("./pages/Graph").then((m) => ({ default: m.Graph })));
const Calendar = lazy(() => import("./pages/Calendar").then((m) => ({ default: m.Calendar })));
const Assistant = lazy(() => import("./pages/Assistant").then((m) => ({ default: m.Assistant })));
const Settings = lazy(() => import("./pages/Settings").then((m) => ({ default: m.Settings })));
const Profile = lazy(() => import("./pages/Profile").then((m) => ({ default: m.Profile })));

function Spinner() {
  return (
    <div className="flex h-full items-center justify-center text-fg-muted">
      <Loader2 size={22} className="animate-spin" />
    </div>
  );
}

function AuthedRoutes() {
  return (
    <Suspense fallback={<Spinner />}>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/files" element={<Files />} />
        <Route path="/notes" element={<Notes />} />
        <Route path="/graph" element={<Graph />} />
        <Route path="/calendar" element={<Calendar />} />
        <Route path="/assistant" element={<Assistant />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}

export default function App() {
  const { session, loading, init, tick, refresh } = useAuth();

  useEffect(() => {
    init();
  }, [init]);

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
        </BrowserRouter>
      ) : (
        <Login />
      )}
      <Toaster />
    </>
  );
}
