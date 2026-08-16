import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { useTheme, attachThemeListener } from "./store/theme";
import { ErrorBoundary } from "./components/ErrorBoundary";

// 저장된 테마 적용 + 시스템 변경 구독
useTheme.getState().apply();
attachThemeListener();

// 제거된 로컬 연동이 남긴 IndexedDB 정리(1회성).
// 코드를 지워도 사용자 브라우저의 DB는 남으므로 여기서 치운다.
// 다음 릴리스에서 이 블록을 삭제할 것.
try {
  indexedDB.deleteDatabase("server-sync");
} catch {
  /* 지원하지 않는 브라우저면 무시 */
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
