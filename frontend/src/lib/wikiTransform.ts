/**
 * `![[대상]]` 임베드와 `[[제목]]` 링크를 표준 마크다운으로 바꾼다.
 *
 * 마크다운 파서에 넣기 **전에** 원문을 손대는 일이라, 코드 안까지 바꾸지 않도록
 * 조심해야 한다. 문서에 위키링크 문법을 설명하려고 코드로 적어 둔 `[[제목]]` 이
 * 진짜 링크로 바뀌어 버리면, 화면에 보이는 코드가 사용자가 쓴 것과 달라진다.
 *
 * 컴포넌트에서 떼어 둔 이유는 테스트 때문이다(test/wiki.test.mjs).
 */
import { EmbedResolver, parseWikiEmbed } from "./embeds";

/** 코드가 아닌 구간만 바꾼다. 울타리(```)와 인라인 코드(`…`)는 건드리지 않는다. */
function mapOutsideCode(text: string, fn: (chunk: string) => string): string {
  const out: string[] = [];
  const lines = text.split("\n");
  let fence: string | null = null; // 열려 있는 울타리 표시(``` 또는 ~~~)

  for (const line of lines) {
    const open = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      out.push(line);
      // 같은 종류의 울타리가 같은 길이 이상이면 닫힌다
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length) fence = null;
      continue;
    }
    if (open) {
      fence = open[1];
      out.push(line);
      continue;
    }
    // 한 줄 안에서 인라인 코드를 건너뛴다
    out.push(mapOutsideInlineCode(line, fn));
  }
  return out.join("\n");
}

function mapOutsideInlineCode(line: string, fn: (chunk: string) => string): string {
  // 백틱 묶음은 같은 개수로 닫힌다(``a`b`` 같은 형태도 지킨다)
  const re = /(`+)([\s\S]*?)\1/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    out += fn(line.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + fn(line.slice(last));
}

/**
 * 임베드를 **먼저** 처리해야 한다 — `![[x]]`의 뒷부분이 `[[x]]`와 겹쳐서,
 * 링크를 먼저 바꾸면 임베드가 `![링크]`로 망가진다.
 */
export function transformWiki(text: string, resolve?: EmbedResolver): string {
  return mapOutsideCode(text, (chunk) => {
    const withEmbeds = chunk.replace(/!\[\[([^\[\]]+?)\]\]/g, (_m, inner: string) => {
      const e = parseWikiEmbed(inner);
      const hit = resolve?.(e.target);
      // 자리표시자에 `[[ ]]` 를 남기면 아래 링크 치환에 다시 걸려서, 사용자에게
      // "파일 없음" 대신 퍼센트 인코딩된 링크 문법이 보인다.
      if (!hit) return `\`(그림 없음: ${e.target})\``;
      const title = e.width ? `${e.target}|${e.width}` : e.target;
      return `![${title}](${hit.url})`;
    });
    return withEmbeds.replace(/\[\[([^\[\]]+?)\]\]/g, (_m, inner: string) => {
      const [target, alias] = inner.split("|");
      const t = target.split("#")[0].trim();
      return `[${(alias ?? target).trim()}](#wiki/${encodeURIComponent(t)})`;
    });
  });
}
