// 하이드레이션 전에 테마 적용 — 잘못된 테마 깜빡임 방지.
// index.html 안에 인라인으로 두면 보안 정책(CSP)의 script-src 'self' 에 막힌다 — 같은 출처의 파일로
// 둔다(34차). <head> 의 보통(블로킹) 스크립트라 첫 그림 전에 돈다.
(function () {
  try {
    var raw = localStorage.getItem("tw-theme");
    var mode = raw ? JSON.parse(raw).state.mode : "system";
    var resolved =
      mode === "system"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : mode;
    document.documentElement.setAttribute("data-theme", resolved);
  } catch (e) {
    document.documentElement.setAttribute("data-theme", "light");
  }
})();
