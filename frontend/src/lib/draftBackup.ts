/**
 * 저장되지 못한 편집을 브라우저에 잠깐 남겨 둔다.
 *
 * 자동저장은 900ms 뒤에 서버로 간다. 그 사이에 파이가 잠깐 끊기거나(집 서버는
 * 실제로 끊긴다) 탭이 닫히면, 화면에만 있던 글은 어디에도 없다. 저장 실패는
 * 토스트로 알리지만 사용자가 계속 쓰고 있으면 그 글이 쌓이기만 한다.
 *
 * 규칙은 단순하다 — **저장에 성공하면 지운다.** 그래서 밑글이 남아 있다는 것은
 * "서버에 닿지 못한 편집이 있다"와 같은 뜻이고, 되살릴지는 사용자가 고른다.
 * 우리가 몰래 덮어쓰지 않는다(다른 기기에서 고쳤을 수도 있다).
 */
const PREFIX = "note-draft:";
/** 문서 하나가 저장소를 다 먹지 않게. localStorage 는 대개 5MB 남짓이다. */
const MAX_CHARS = 200_000;
/** 오래된 밑글은 되살릴 값보다 헷갈릴 값이 크다. */
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

export interface Draft {
  text: string;
  at: number;
}

const key = (path: string) => PREFIX + path;

/** 저장소가 꽉 찼거나(quota) 브라우저가 막아 둔 경우 — 조용히 넘긴다.
 *  밑글은 보조 장치다. 이것 때문에 편집이 멈추면 안 된다. */
function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

export function keepDraft(path: string, text: string): void {
  if (!path || text.length > MAX_CHARS) return;
  safe(() => localStorage.setItem(key(path), JSON.stringify({ text, at: Date.now() })));
}

export function dropDraft(path: string): void {
  if (!path) return;
  safe(() => localStorage.removeItem(key(path)));
}

/** 이 문서에 되살릴 밑글이 있는가. 서버 본문과 같으면 없는 것과 같다. */
export function readDraft(path: string, serverText: string): Draft | null {
  if (!path) return null;
  const raw = safe(() => localStorage.getItem(key(path)));
  if (!raw) return null;
  const d = safe(() => JSON.parse(raw) as Draft);
  if (!d || typeof d.text !== "string" || typeof d.at !== "number") {
    dropDraft(path);
    return null;
  }
  if (d.text === serverText || Date.now() - d.at > MAX_AGE_MS) {
    dropDraft(path);
    return null;
  }
  return d;
}

/** 경로가 바뀌면(이름 변경·이동) 밑글도 따라간다. 안 옮기면 옛 경로에 고아로 남는다. */
export function moveDraft(from: string, to: string): void {
  const raw = safe(() => localStorage.getItem(key(from)));
  if (!raw) return;
  safe(() => {
    localStorage.setItem(key(to), raw);
    localStorage.removeItem(key(from));
  });
}

export function draftAgeText(at: number): string {
  const min = Math.floor((Date.now() - at) / 60000);
  if (min < 1) return "방금";
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  return `${Math.floor(hr / 24)}일 전`;
}
