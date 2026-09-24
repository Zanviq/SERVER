import { forwardRef, TextareaHTMLAttributes, useImperativeHandle, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Eye, Pencil } from "lucide-react";
import { MarkdownView } from "../notes/LazyMarkdownView";
import { useMarkdownInput } from "./useMarkdownInput";

type Props = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  /**
   * 오른쪽 아래에 편집/미리보기 단추를 둔다. 이 글이 **다른 곳에 따로 보이지
   * 않는** 칸(일정 설명·할 일 설명·일기·논문 메모)에서, 적은 마크다운과 링크가
   * 어떻게 보이는지 확인하는 유일한 길이다.
   */
  preview?: boolean;
  /** 감싸는 칸의 클래스. flex 자식이면 flex-1 같은 배치 클래스는 여기에 준다. */
  wrapClassName?: string;
};

/**
 * 마크다운 + `[note/…]` 링크를 쓸 수 있는 여러 줄 입력칸.
 *
 * 보통 `<textarea>` 와 똑같이 쓴다(value/onChange 도, defaultValue/onBlur 도 된다).
 * `[` 를 치면 입력칸 위로 링크 후보가 뜬다(useMarkdownInput).
 */
export const LinkTextarea = forwardRef<HTMLTextAreaElement, Props>(function LinkTextarea(
  { preview = false, wrapClassName = "", className = "", ...rest },
  outer,
) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(outer, () => ref.current as HTMLTextAreaElement, []);
  const panel = useMarkdownInput(ref);
  const navigate = useNavigate();
  const [showing, setShowing] = useState(false);
  // 미리보기로 바꿀 때의 글. 제어되지 않는 칸(defaultValue)도 있어서 DOM 에서 읽는다.
  const [text, setText] = useState("");

  if (!preview) {
    return (
      <>
        <textarea ref={ref} className={className} {...rest} />
        {panel}
      </>
    );
  }

  const toggle = () => {
    if (!showing) setText(ref.current?.value ?? "");
    setShowing((v) => !v);
    if (showing) window.setTimeout(() => ref.current?.focus(), 0);
  };

  return (
    <div className={`relative ${wrapClassName}`}>
      {/* 미리보기 중에도 입력칸은 **내려 두지 않는다**. 내리면 제어되지 않는 칸은
          다시 올라올 때 처음 값으로 돌아가 고친 것이 사라진다. */}
      <textarea ref={ref} className={`${className} ${showing ? "hidden" : ""}`} {...rest} />
      {showing && (
        <div
          className={`${className} cursor-text overflow-auto`}
          onDoubleClick={toggle}
          title="두 번 누르면 고치기"
        >
          {text.trim() ? (
            <MarkdownView
              content={text}
              onWikiClick={(t) => navigate(`/notes?open=${encodeURIComponent(t)}&create=0`)}
            />
          ) : (
            <p className="text-fg-subtle">(비어 있음)</p>
          )}
        </div>
      )}
      <button
        type="button"
        onClick={toggle}
        title={showing ? "고치기" : "미리보기(마크다운·링크가 어떻게 보이는지)"}
        aria-label={showing ? "고치기" : "미리보기"}
        className="absolute bottom-1.5 right-1.5 grid h-6 w-6 place-items-center rounded-md border border-line bg-surface/90 text-fg-muted opacity-70 transition-opacity hover:text-fg hover:opacity-100"
      >
        {showing ? <Pencil size={12} /> : <Eye size={12} />}
      </button>
      {panel}
    </div>
  );
});
