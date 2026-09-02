/**
 * 테스트에서 TypeScript 원본을 불러오는 한 가지 방법.
 *
 * 같은 7줄이 테스트 파일마다 복사돼 있었고, 주석은 "셸을 거치지 않으므로 경로에
 * 공백이 있어도 안전하다"고 했지만 실제로는 `shell: true` 였다 — 윈도우에서 npx 를
 * 부르려면 셸이 필요한데, 셸을 거치면 인자가 따옴표 없이 이어 붙는다. 사용자
 * 이름이나 임시폴더 경로에 공백이 하나만 있어도 그 순간 전부 깨진다.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

/** 셸이 인자를 다시 쪼개지 않도록 감싼다. */
const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;

/**
 * `src/lib/x.ts` 같은 프런트 소스를 묶어서 import 한다.
 *
 * @param {string} relFromSrcRoot frontend/ 기준 상대경로 (예: "src/lib/mdTable.ts")
 * @returns 묶인 모듈
 */
export async function bundle(relFromSrcRoot) {
  const src = join(TEST_DIR, "..", relFromSrcRoot);
  const dir = mkdtempSync(join(tmpdir(), "bundle-"));
  const out = join(dir, "bundled.mjs");
  execFileSync(
    "npx",
    ["esbuild", q(src), "--bundle", "--format=esm", `--outfile=${q(out)}`],
    { stdio: "pipe", shell: true },
  );
  const mod = await import(pathToFileURL(out).href);
  // import 가 끝나면 파일은 더 필요 없다. 남기면 임시폴더가 계속 쌓인다.
  rmSync(dir, { recursive: true, force: true });
  return mod;
}
