import { ComponentType, lazy } from "react";

/**
 * 배포로 사라진 옛 청크를 만나면 한 번만 자동 새로고침하는 lazy().
 *
 * 해시가 붙은 청크는 배포될 때마다 파일명이 바뀌고 옛 파일은 사라진다.
 * 오래 열어둔 탭이 그 파일을 요청하면 nginx가 404를 주고(의도된 설정이다 —
 * index.html로 폴백하면 브라우저가 JS 자리에서 HTML을 받아 더 이상하게 깨진다),
 * 지연 import가 거부되면서 렌더 도중 예외가 되어 화면 전체가 ErrorBoundary로 떨어진다.
 * 실제로 "문서를 만들 때마다 새로고침하라는 오류"로 보고됐다(편집기가 지연 로딩된다).
 * 서버 로그에도 `GET /assets/LiveEditor-<옛해시>.js 404` 뒤에 새 해시 200이 찍혔다.
 *
 * 새 index.html을 받으면 해결되므로 스스로 새로고침한다.
 */
const FLAG = "chunk-auto-reloaded";

/** 이 페이지가 '자동 새로고침의 결과'로 뜬 것이라면 그 시각. 아니면 0. */
let reloadedAt = 0;
try {
  if (sessionStorage.getItem(FLAG)) {
    reloadedAt = Date.now();
    sessionStorage.removeItem(FLAG); // 표식은 한 번만 쓰고 지운다
  }
} catch {
  /* 프라이빗 모드 등에서 sessionStorage가 막힐 수 있다 */
}

/** 새로고침 직후 얼마 안 돼 또 실패하면 배포 문제가 아니라 진짜 오류로 본다. */
const GRACE_MS = 60_000;

function mayReload(): boolean {
  // 성공한 청크가 있다고 해서 카운터를 되돌리면 안 된다 — 다른 청크는 잘 받아지므로
  // 곧바로 초기화되어 같은 실패에서 무한히 새로고침한다(실제로 그렇게 돌았다).
  return !(reloadedAt && Date.now() - reloadedAt < GRACE_MS);
}

// React.lazy와 같은 제약을 그대로 쓴다(어떤 props든 받는 컴포넌트).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyChunk<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
) {
  return lazy(() =>
    factory().catch((err) => {
      if (mayReload()) {
        try {
          sessionStorage.setItem(FLAG, "1");
        } catch {
          /* 표식을 못 남기면 재시도 억제만 못 한다 */
        }
        window.location.reload();
        // 새로고침이 끝날 때까지 렌더를 멈춘다(여기서 throw하면 오류 화면이 번쩍인다)
        return new Promise<never>(() => {});
      }
      // 새로고침하고도 곧바로 실패 = 진짜 오류. ErrorBoundary가 받게 둔다.
      throw err;
    }),
  );
}
