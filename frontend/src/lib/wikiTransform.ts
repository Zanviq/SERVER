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

  // 인라인 코드는 **한 문단 안에서** 줄을 넘을 수 있다(마크다운 규칙).
  //   앞 `열고
  //   [[제목]]
  //   뒤 ` 닫음
  // 을 줄마다 따로 보면 가운데 [[제목]]이 링크로 바뀌는데, 실제 렌더러는 그
  // 구간을 코드로 그린다 — 화면에 보이는 코드가 사용자가 쓴 것과 달라진다.
  // 그래서 이어지는 보통 줄을 모았다가 한꺼번에 훑는다. 빈 줄에서 끊는다
  // (문단이 바뀌면 코드 구간도 거기서 끝난다 — 백엔드 notes_graph 와 같은 규칙).
  let para: string[] = [];
  const flush = () => {
    if (!para.length) return;
    out.push(mapOutsideInlineCode(para.join("\n"), fn));
    para = [];
  };

  // 들여쓴 코드블록 판정에 필요한 문맥. 4칸 들여쓰기를 무조건 코드로 보면
  // `- 상위 / (4칸)- 하위` 같은 흔한 중첩 목록의 [[링크]]가 글자로만 남는다.
  let prevBlank = true; // 들여쓴 코드는 문단을 끊고 들어올 수 없다
  let inCode = false;   // 들여쓴 코드블록이 이어지는 중
  let inList = false;   // 목록 안의 들여쓰기는 코드가 아니라 하위 항목이다

  for (const line of lines) {
    // 인용문·목록 안에도 코드블록이 있다(`> ```` `, `- ```` `). 앞의 인용 기호와
    // 들여쓰기를 걷어낸 뒤에 울타리를 본다 — 예전에는 줄 맨 앞 공백 3칸까지만
    // 인정해서 그런 코드블록 안의 `[[제목]]` 이 링크로 바뀌었다.
    const body = line.replace(/^[\s>]*(?:[-*+]\s+|\d+[.)]\s+)?/, "");
    const open = body.match(/^(`{3,}|~{3,})/);
    if (fence) {
      out.push(line);
      // 같은 종류의 울타리가 같은 길이 이상이면 닫힌다
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length) fence = null;
      continue;
    }
    if (open) {
      flush();
      fence = open[1];
      out.push(line);
      prevBlank = false;
      inCode = false;
      continue;
    }
    if (!line.trim()) {
      // 빈 줄 = 문단 끝. 여기서 끊어야 짝 안 맞는 백틱이 문서 뒤쪽까지 번지지 않는다.
      flush();
      out.push(line);
      prevBlank = true;
      inCode = false;
      continue;
    }
    if (/^\s*(?:[-*+]\s|\d+[.)]\s)/.test(line)) inList = true;
    else if (!/^\s/.test(line)) inList = false; // 들여쓰기 없는 줄이 나오면 목록이 끝난다
    // 4칸 이상 들여쓴 줄도 코드블록이다(울타리 없는 옛 표기). 단 문단 도중에는
    // 코드가 될 수 없고, 목록 안에서는 하위 항목이다.
    if (/^(?: {4}|\t)/.test(line) && !inList && (prevBlank || inCode)) {
      flush();
      out.push(line);
      inCode = true;
      continue;
    }
    para.push(line);
    prevBlank = false;
    inCode = false;
  }
  flush();
  return out.join("\n");
}

/** 한 문단 안에서 인라인 코드 구간을 건너뛰고 나머지만 fn 에 넘긴다. */
function mapOutsideInlineCode(para: string, fn: (chunk: string) => string): string {
  // 백틱 묶음은 같은 개수로 닫힌다(``a`b`` 같은 형태도 지킨다).
  // 줄바꿈은 넘되 빈 줄은 못 넘는다 — 부르는 쪽이 이미 문단으로 끊어 준다.
  const re = /(`+)([\s\S]*?)\1/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(para)) !== null) {
    out += fn(para.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + fn(para.slice(last));
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
