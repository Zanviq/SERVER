/**
 * 노드가 확장자 없는 import 를 찾게 해 준다.
 *
 * 소스는 Vite 규칙으로 `./embeds` 처럼 확장자 없이 서로를 부르는데, 노드는
 * 그걸 못 찾는다. 그래서 테스트가 **진짜 모듈**을 못 불러오고 규칙을 베껴 적게
 * 되는데, 베껴 적은 규칙은 원본이 바뀌어도 조용히 통과한다.
 *
 * 쓰는 법: node --experimental-strip-types --import ./test/tsResolve.mjs ...
 */
import { register } from "node:module";

// 기준을 **이 파일**로 잡는다. 현재 폴더를 기준으로 하면 어디서 실행하느냐에 따라
// 경로가 달라져 못 찾는다.
register("./tsResolveHooks.mjs", import.meta.url);
