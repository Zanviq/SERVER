import { api } from "./api";

/** 화면에 머문 시간을 재서 서버에 보낸다.
 *
 *  보내는 것은 **화면 이름과 초, 어디서 왔는지**뿐이다. 주소의 물음표 뒤(논문
 *  id·문서 경로 같은 것)는 여기서 잘라 버리고, 서버도 아는 라우트가 아니면
 *  '기타'로 접는다 — 통계라는 이름으로 남의 자료가 새지 않게 두 겹으로 막는다.
 *
 *  탭이 숨으면 시간을 멈춘다. 켜 놓고 잔 시간까지 '사용'으로 세면 하루가
 *  24시간을 넘고, 그 뒤로는 어떤 비교도 뜻이 없어진다.
 */
let route = "";
let from = "";
let since = 0;
let visible = true;

const now = () => Date.now();
const clean = (path: string) => (path || "/").split("?")[0].split("#")[0];

/** 지금까지 잰 시간을 보내고 시계를 리셋한다. */
function flush(keepalive = false): void {
  if (!route || !since) return;
  const seconds = (now() - since) / 1000;
  since = visible ? now() : 0;
  if (seconds < 1) return;   // 스쳐 지나간 화면은 세지 않는다
  const body = { route, seconds, came_from: from };
  // 탭이 닫히는 중에는 보통 fetch 가 취소된다. sendBeacon 은 그때도 나간다.
  if (keepalive && navigator.sendBeacon) {
    try {
      navigator.sendBeacon("/api/usage/page",
        new Blob([JSON.stringify(body)], { type: "application/json" }));
      return;
    } catch {
      /* 아래 평소 경로로 */
    }
  }
  void api.usagePage(body).catch(() => {});
}

/** 라우트가 바뀔 때마다 부른다. */
export function trackRoute(path: string): void {
  const next = clean(path);
  if (next === route) return;
  flush();
  from = route;
  route = next;
  since = visible ? now() : 0;
}

/** 앱이 뜰 때 한 번. 탭 숨김·닫힘을 따라간다. */
export function startPageTiming(): () => void {
  const onVisible = () => {
    if (document.hidden) {
      visible = false;
      flush();
      since = 0;
    } else {
      visible = true;
      since = now();
    }
  };
  const onLeave = () => flush(true);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("pagehide", onLeave);
  return () => {
    flush(true);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("pagehide", onLeave);
  };
}
