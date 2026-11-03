import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { wikiHref } from "./notePath";

/**
 * 문서 화면 밖의 읽기 보기(대화 말풍선·단어 카드·컨텍스트·입력칸 미리보기)가 `[[제목]]` 을 눌렀을 때 — 문서 화면의
 * 그 문서(와 섹션)로 간다. 다섯 곳이 같은 주소를 손으로 적고 있었다(섹션을 붙이려면 다섯 번 고쳐야 했다).
 * 값이 고정된 함수라 LazyMarkdownView 의 memo 를 깨지 않는다.
 */
export function useWikiOpener(): (title: string, section?: string | null) => void {
  const navigate = useNavigate();
  return useCallback((title: string, section?: string | null) => {
    const href = wikiHref(title, section);
    if (href) navigate(href);
  }, [navigate]);
}
