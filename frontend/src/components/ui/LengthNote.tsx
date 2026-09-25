/**
 * 긴 글 칸의 글자 수 알림 — 상한의 90% 를 넘으면 "N / 상한자", 다 차면 full 문구를 붙인다.
 *
 * 칸에는 서버와 같은 maxLength 를 두는데, 그것만으로는 왜 더 안 쳐지는지 모른다(키가 먹지 않는 것처럼
 * 보인다). 논문 메모·하루 기록이 같은 알림을 한 벌씩 적고 있었다 — 새 긴 글 칸이 알림을 빠뜨리지 않게
 * 하나로 둔다. 상한을 넘기지 않으면 아무것도 그리지 않는다.
 */
export function LengthNote({ length, max, full }: { length: number; max: number; full: string }) {
  if (length <= max * 0.9) return null;
  return (
    <p className="mt-1 text-[11px] text-fg-muted">
      {length.toLocaleString()} / {max.toLocaleString()}자
      {length >= max && ` — ${full}`}
    </p>
  );
}
