import { useEffect, useRef, useState } from "react";

interface PollState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/** intervalMs 마다 fn을 호출해 최신 데이터를 유지하는 훅. */
export function usePolling<T>(
  fn: () => Promise<T>,
  intervalMs: number,
): PollState<T> {
  const [state, setState] = useState<PollState<T>>({
    data: null,
    error: null,
    loading: true,
  });
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      // 탭이 숨겨져 있으면 네트워크 요청을 건너뜀 (Pi 부하 절감)
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const data = await fnRef.current();
        if (alive) setState({ data, error: null, loading: false });
      } catch (e) {
        if (alive)
          setState((s) => ({
            ...s,
            error: e instanceof Error ? e.message : "error",
            loading: false,
          }));
      }
    };
    tick();
    const id = setInterval(tick, intervalMs);
    // 다시 보일 때 즉시 갱신
    const onVis = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [intervalMs]);

  return state;
}
