/**
 * 자동저장 타이머와 '열기 순번' — 문서를 잃거나 되살리는 실수가 나던 두 자리.
 *
 * 노트 화면 안에 흩어져 있던 규칙을 여기로 모은다. 화면 안에 두면 React 상태에
 * 얽혀서 검사할 수가 없는데, **여기서 틀리면 사용자의 글이 사라지거나 지운
 * 문서가 되살아난다**. 실제로 났던 사고들:
 *
 *  - 타이머(기본 900ms)가 뜨기 전에 다른 문서로 옮기면 마지막 입력이 사라졌다.
 *  - 이름 변경·이동이 대기 중인 저장을 안 끊어서, 타이머가 옛 경로로 저장을
 *    보내 방금 이름을 바꾼 문서가 옛 이름으로 하나 더 생겼다.
 *  - 삭제가 타이머를 안 끊어서 휴지통으로 보낸 문서가 디스크에 다시 생겼다.
 *  - 문서를 빠르게 두 번 누르면 먼저 온 응답이 나중에 도착해 엉뚱한 본문을 덮었다.
 */

type Timers = {
  set: (fn: () => void, ms: number) => number;
  clear: (id: number) => void;
};

/** 어떻게 보내는가. keepalive 면 페이지가 닫혀도 브라우저가 요청을 끝까지 보낸다. */
export interface SendHow {
  keepalive: boolean;
}

/** 저장 한 건. `false` 를 돌려주거나 던지면 **실패**로 보고 다시 시도한다. */
type SaveJob = (how: SendHow) => unknown;

const REAL: Timers = {
  set: (fn, ms) => window.setTimeout(fn, ms),
  clear: (id) => window.clearTimeout(id),
};

/** 대기 중인 자동저장 **하나**를 다룬다(항상 최신 것 하나만 남는다). */
export class PendingSave {
  private id: number | null = null;
  private job: SaveJob | null = null;

  constructor(private timers: Timers = REAL) {}

  /** 아직 해내지 못한 저장이 있는가(예약 중이거나, 실패해서 다시 해야 하거나). */
  get scheduled(): boolean {
    return this.job !== null;
  }

  /** ms 뒤에 저장한다. 앞선 예약은 **덮어쓴다** — 마지막 것만 유효하다. */
  schedule(ms: number, job: SaveJob): void {
    if (this.id !== null) this.timers.clear(this.id);
    this.job = job;
    this.id = this.timers.set(() => {
      this.id = null;
      void this.run({ keepalive: false });
    }, ms);
  }

  /**
   * 예약된 저장을 실행한다. `false` 를 돌려주거나 던지면 실패로 본다.
   *
   * **실패한 저장은 버리지 않는다.** 버리면 그 글이 어디에도 남지 않는다 —
   * 타이머는 이미 소진됐고 다음 자동저장은 새 입력이 있어야 걸리므로, 잠깐
   * 끊겼다 돌아온 사이에 친 마지막 문단이 통째로 사라진다.
   */
  private async run(how: SendHow): Promise<boolean> {
    const job = this.job;
    if (!job) return true;
    let ok = false;
    try {
      ok = (await job(how)) !== false;
    } catch {
      ok = false;
    }
    if (ok) this.job = null;
    return ok;
  }

  /** 기다리지 않고 **지금** 저장한다. 문서를 옮기기 전에 부른다.
   *  돌려주는 값은 "이제 안 남았는가" — false 면 저장에 실패한 것이다. */
  async flush(how: SendHow = { keepalive: false }): Promise<boolean> {
    if (this.id !== null) {
      this.timers.clear(this.id);
      this.id = null;
    }
    return this.run(how);
  }

  /** 대기 중인 저장을 **버린다**. 문서를 지운 뒤에 부른다. */
  cancel(): boolean {
    const had = this.job !== null || this.id !== null;
    if (this.id !== null) this.timers.clear(this.id);
    this.id = null;
    this.job = null;
    return had;
  }
}

/**
 * 페이지가 숨겨지면(새로고침·탭 닫기·앱 전환) 남은 저장을 **keepalive 로** 보낸다.
 *
 * 화면을 떠날 때의 정리 코드(useEffect cleanup)는 앱 **안에서** 옮겨 갈 때만 돈다.
 * 새로고침이나 탭 닫기에서는 돌지 않고, 돌더라도 보통 요청은 페이지와 함께 끊긴다 —
 * 지도에서 노드를 끌고 곧바로 새로고침하면 옮긴 자리가 사라졌다(실측). keepalive
 * 요청은 페이지가 닫혀도 브라우저가 끝까지 보낸다(본문 64KB 까지).
 *
 * 돌려주는 함수를 부르면 떼어 낸다(useEffect 의 정리로 쓴다).
 */
export function flushWhenPageHides(pending: PendingSave): () => void {
  const onHide = () => { void pending.flush({ keepalive: true }); };
  const onVisibility = () => { if (document.visibilityState === "hidden") onHide(); };
  window.addEventListener("pagehide", onHide);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    window.removeEventListener("pagehide", onHide);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

/**
 * '가장 마지막에 시작한 것만 유효' 규칙.
 *
 * 순번은 **누른 순서대로** 매겨야 한다. 기다린 뒤에 매기면, 저장할 게 없어
 * 곧바로 돌아온 나중 클릭이 더 낮은 번호를 받아 순서 뒤집힘 방어가 거꾸로
 * 동작한다(먼저 누른 문서가 이긴다).
 */
export class LatestWins {
  private n = 0;

  /** 새 작업을 시작하고 표를 받는다. 시작하는 **즉시** 부른다. */
  begin(): number {
    return ++this.n;
  }

  /** 이 표가 아직 최신인가. 응답을 반영하기 전에 확인한다. */
  isCurrent(token: number): boolean {
    return token === this.n;
  }

  /** 진행 중인 것을 모두 무효로 만든다(문서를 닫을 때). */
  abandonAll(): void {
    this.n++;
  }
}
