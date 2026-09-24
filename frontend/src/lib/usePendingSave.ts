import { DependencyList, useEffect, useRef } from "react";
import { PendingSave, flushWhenPageHides } from "./pendingSave";

/**
 * 모아 두었다 보내는 저장(PendingSave) 하나 — **떠날 때 보내고, 페이지가 숨겨질 때도
 * 보낸다.**
 *
 * 화면마다 이 두 가지를 따로 적었더니 한쪽을 빠뜨리기 쉬웠다(맨 타이머를 지우는
 * 정리 코드 때문에 지도 자리·읽던 쪽이 사라졌던 일). 이 훅을 쓰면 둘 다 붙는다.
 *
 * flushWhen 이 바뀔 때(다른 논문·다른 대화 공간으로 옮길 때)도 그 전에 보낸다 —
 * 예약된 저장은 옛 대상을 가리키고 있다.
 */
export function usePendingSave(flushWhen: DependencyList = []): PendingSave {
  const ref = useRef<PendingSave | null>(null);
  if (!ref.current) ref.current = new PendingSave();
  const pending = ref.current;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => { void pending.flush(); }, flushWhen);
  useEffect(() => flushWhenPageHides(pending), [pending]);
  return pending;
}
