/**
 * 읽기 뷰 살균 규칙 — 문서 내용은 전부 "남이 준 HTML"이라고 보고 다룬다.
 *
 * 문서는 사용자가 직접 쓰기도 하지만 AI가 웹에서 가져온 내용을 붙여 넣기도 하고,
 * 공유받은 파일을 열기도 한다. 그래서 인라인 HTML/SVG를 허용하되 여기서 한 번
 * 걸러야 한다 — 통과 목록에 없는 태그·속성·프로토콜은 전부 버린다.
 *
 * 규칙을 컴포넌트에서 떼어 둔 이유는 **테스트 때문**이다(test/sanitize.test.mjs).
 * 통과 목록에 태그를 하나 더 넣는 일은 쉽고, 그게 위험한지 눈으로 판단하기는
 * 어렵다. 실제로 돌려 보고 확인할 수 있어야 한다.
 */
import { defaultSchema } from "rehype-sanitize";

// 인라인 SVG/HTML을 허용하되 script·이벤트 핸들러·위험 프로토콜은 계속 차단.
// foreignObject(임의 HTML 삽입)·animate/set(속성을 나중에 바꿔치기) 등은 제외.
const SVG_TAGS = [
  "svg", "g", "path", "circle", "ellipse", "line", "polyline", "polygon", "rect",
  "text", "tspan", "defs", "linearGradient", "radialGradient", "stop", "use",
  "marker", "clipPath", "mask", "pattern", "image", "title", "desc", "symbol",
];

// hast는 SVG 속성을 property-information의 camelCase 프로퍼티로 다룬다(하이픈 이름은 매칭 안 됨).
const SVG_ATTRS = [
  "viewBox", "xmlns", "fill", "stroke", "strokeWidth", "strokeLinecap", "strokeLinejoin",
  "strokeDasharray", "strokeDashoffset", "strokeOpacity", "fillOpacity", "fillRule",
  "clipRule", "clipPath", "d", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "x2", "y1", "y2",
  "width", "height", "points", "transform", "offset", "stopColor", "stopOpacity",
  "gradientUnits", "gradientTransform", "preserveAspectRatio", "opacity", "textAnchor",
  "fontSize", "fontFamily", "dominantBaseline", "markerEnd", "markerStart", "role",
  "href", // svg <a>/<use> href — 아래 protocols로 javascript: 등 차단
];

const SAFE_PROTOCOLS = defaultSchema.protocols?.href ?? ["http", "https", "mailto", "tel"];

export const mdSanitizeSchema = {
  ...defaultSchema,
  // mark = 형광펜(==강조==), details/summary = 토글.
  // 기본 스키마에 없어 그냥 두면 살균 단계에서 조용히 사라진다.
  tagNames: [...(defaultSchema.tagNames ?? []), "mark", "details", "summary", ...SVG_TAGS],
  // 각주 id 접두사를 여기서 한 번 더 붙이지 않는다.
  //
  // remark-gfm 이 이미 `user-content-fn-1` 처럼 이름을 붙여 두는데, 살균이 id 에만
  // 접두사를 또 붙이고 href 는 그대로 두어 `#user-content-fn-1` 이 아무 데도 닿지
  // 않았다(각주를 눌러도 안 움직인다). 접두사는 remark-gfm 것 하나로 충분하다.
  clobberPrefix: "",
  protocols: {
    ...defaultSchema.protocols,
    href: SAFE_PROTOCOLS,
    xlinkHref: SAFE_PROTOCOLS, // 방어: 혹시 남아도 위험 프로토콜 차단
    // <use href>·<image href>는 위 href 규칙을 함께 받는다.
    src: defaultSchema.protocols?.src ?? ["http", "https"],
  },
  attributes: {
    ...defaultSchema.attributes,
    // className 을 모든 태그에 허용하면 안 된다. 이 앱은 Tailwind 유틸리티 클래스가
    // 전역에 깔려 있어서, `<div class="fixed inset-0 z-50 bg-white">` 한 줄이면
    // style 속성 없이도 화면 전체를 덮는 가짜 화면을 만들 수 있다(막았다고 확인한
    // style="position:fixed" 와 결과가 같다). 코드블록의 `language-*` 는 기본
    // 스키마가 code 태그에 한정해 허용하므로 문법 강조는 그대로 동작한다.
    "*": [...(defaultSchema.attributes?.["*"] ?? []), ...SVG_ATTRS],
  },
};
