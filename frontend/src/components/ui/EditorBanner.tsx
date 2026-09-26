import type { ReactNode } from "react";

/** 편집기 바로 위의 띠 — 저장이 멈춘 까닭을 알리고 고를 단추를 둔다(충돌·지워짐·남은 밑글).
 *
 *  문서 화면과 회의 화면이 같은 띠를 여섯 벌 손으로 적고 있었다(63차에 '지워짐' 띠가 둘 더 붙으며).
 *  모양이 한쪽만 바뀌면 같은 일을 두 화면이 다르게 말한다. 말(message)과 단추(children)만 넘긴다.
 *  role 은 넘긴 그대로 — 저장이 막혀 다른 문서로도 못 옮기는 띠(지워짐)만 alert 로 알린다.
 */
export function EditorBanner({ tone, role, message, children }: {
  tone: "danger" | "warning";
  role?: "alert";
  message: ReactNode;
  children: ReactNode;
}) {
  const bg = tone === "danger" ? "bg-[rgb(var(--danger)/0.1)]" : "bg-[rgb(var(--warning)/0.12)]";
  return (
    <div role={role} className={`flex flex-wrap items-center gap-2 border-b border-line ${bg} px-3 py-2 text-[12.5px]`}>
      <span className="min-w-0 flex-1">{message}</span>
      {children}
    </div>
  );
}
