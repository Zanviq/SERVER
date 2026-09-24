/**
 * AI 대화 스트림(SSE)을 읽는다 — **끝까지 받았는지** 함께 따진다.
 *
 * 서버는 한 차례를 끝낼 때 반드시 `done`(실패면 `error`)을 보낸다(orchestrator 의 모든
 * 끝 경로). 그 신호 없이 스트림이 끝나면 **잘린 것**이다 — 배포로 서버가 다시 뜨거나,
 * 프록시가 연결을 닫거나, 휴대폰 망이 바뀐 경우다. 예전에는 그렇게 끝나도 정상 종료로
 * 보고 받은 데까지를 **다 쓴 답처럼** 보여 줬다. 읽는 도중 연결이 끊긴 경우(네트워크
 * 오류)도 같은 일로 본다.
 *
 * 사용자가 '중단'을 눌러 끊은 것은 잘림이 아니다 — 받은 데까지로 조용히 끝난다.
 */

/** 이 둘 중 하나가 와야 차례가 끝난 것이다. */
const TERMINAL = new Set(["done", "error"]);

export class StreamCut extends Error {
  constructor(message = "응답이 도중에 끊겼습니다(연결이 끊겼거나 서버가 다시 시작됨).") {
    super(message);
    this.name = "StreamCut";
  }
}

/** `data: {...}\n\n` 덩어리를 차례로 onEvent 에 넘긴다. 잘렸으면 StreamCut 을 던진다. */
export async function readSse<E extends { type?: string }>(
  body: ReadableStream<Uint8Array>,
  onEvent: (e: E) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let finished = false;
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        if (signal?.aborted) return; // 중단 버튼 — 여기까지 받은 것으로 끝낸다
        throw new StreamCut();
      }
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const part of parts) {
        const line = part.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        let ev: E;
        try {
          ev = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        if (TERMINAL.has(String(ev?.type))) finished = true;
        try {
          onEvent(ev);
        } catch {
          /* 화면 쪽 처리 실패가 스트림 읽기를 멈추지 않게 */
        }
      }
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  if (!finished && !signal?.aborted) throw new StreamCut();
}
