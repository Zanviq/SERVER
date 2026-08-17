/**
 * 문서 트리 드래그를 식별하는 전용 MIME 타입.
 *
 * `text/plain`으로 판별하면 안 된다 — CodeMirror는 에디터 안에서 선택 영역을 끌 때
 * 그 텍스트를 text/plain으로 싣고(handlers.dragstart), 우리 drop 핸들러가 CM 내장보다
 * **먼저** 돈다. 그래서 text/plain을 보고 preventDefault하면 텍스트 드래그-이동이
 * 죽고 대신 `[[텍스트]]`가 박힌다. 다른 탭에서 끌어온 문장·URL도 마찬가지다.
 *
 * LiveEditor는 지연 로딩(CodeMirror 번들) 대상이라 이 상수를 거기서 export하면
 * Notes.tsx가 값으로 import하는 순간 코드 분할이 무너진다. 그래서 별도 모듈이다.
 */
export const NOTE_PATH_MIME = "application/x-note-path";

/** 이 드래그를 노트 편집기가 처리해야 하는가(트리 항목이거나 OS 파일인가). */
export function isOurDrag(dt: DataTransfer): boolean {
  return dt.types.includes(NOTE_PATH_MIME) || dt.types.includes("Files");
}
