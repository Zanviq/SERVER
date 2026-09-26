import { InputHTMLAttributes, ReactNode, useState } from "react";
import { Eye, EyeOff } from "lucide-react";

/**
 * 비밀번호 칸 + 보기/숨기기 눈(디자인 11차). 휴대폰 자판으로 긴 비밀번호를 **보지 않고** 치다 한 글자 틀리면 무엇이
 * 틀렸는지 알 길이 없었다 — 로그인·비밀번호 바꾸기 모두. 눈은 `type="button"` 이라 form 안에서도 제출하지 않는다.
 * 보일 때는 글자 칸이 되므로 자판의 자동 대문자·고침·맞춤법 밑줄을 끈다(비밀번호가 "고쳐지면" 안 된다).
 *
 * `leading` 은 칸 왼쪽의 장식(자물쇠 아이콘 등, absolute 로 놓는다).
 */
export function PasswordInput({ className = "", wrapClassName = "", leading, ...rest }:
  Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { wrapClassName?: string; leading?: ReactNode }) {
  const [shown, setShown] = useState(false);
  return (
    <div className={`relative ${wrapClassName}`}>
      {leading}
      <input {...rest} type={shown ? "text" : "password"} autoCapitalize="none" autoCorrect="off" spellCheck={false}
        className={`${className} pr-10`} />
      <button type="button" onClick={() => setShown((v) => !v)} aria-pressed={shown}
        aria-label={shown ? "비밀번호 숨기기" : "비밀번호 보기"} title={shown ? "비밀번호 숨기기" : "비밀번호 보기"}
        className="absolute right-1.5 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded text-fg-subtle hover:text-fg coarse:h-9 coarse:w-9">
        {shown ? <EyeOff size={15} /> : <Eye size={15} />}
      </button>
    </div>
  );
}
