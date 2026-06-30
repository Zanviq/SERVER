import { useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useAuth } from "./store/auth";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { Files } from "./pages/Files";
import { Notes } from "./pages/Notes";
import { Graph } from "./pages/Graph";
import { Placeholder } from "./pages/Placeholder";
import { Toaster } from "./components/ui/Toaster";

function AuthedRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/files" element={<Files />} />
      <Route path="/notes" element={<Notes />} />
      <Route path="/graph" element={<Graph />} />
      <Route path="/calendar" element={<Placeholder title="캘린더" />} />
      <Route path="/assistant" element={<Placeholder title="AI 비서" />} />
      <Route path="/settings" element={<Placeholder title="설정" />} />
      <Route path="/profile" element={<Placeholder title="프로필" />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  const { session, loading, init, tick, refresh } = useAuth();

  useEffect(() => {
    init();
  }, [init]);

  // 1초 카운트다운 + 60초마다 서버 동기화
  useEffect(() => {
    if (!session) return;
    const t = setInterval(tick, 1000);
    const r = setInterval(refresh, 60000);
    return () => {
      clearInterval(t);
      clearInterval(r);
    };
  }, [session, tick, refresh]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-fg-muted">
        <Loader2 size={22} className="animate-spin" />
      </div>
    );
  }

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
