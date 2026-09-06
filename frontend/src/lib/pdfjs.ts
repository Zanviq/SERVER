// pdf.js 는 크다(~1MB). 논문 화면에서 처음 PDF 를 열 때만 받는다.
// 워커는 Vite 가 별도 파일로 뽑아 주고(?url) 그 주소를 pdf.js 에 알려 준다.
export type PdfJs = typeof import("pdfjs-dist");

let loading: Promise<PdfJs> | null = null;

/** 워커 소스를 **미리 받아** blob 주소로 만든다.
 *
 * 예전에는 주소만 넘겼다. 그러면 pdf.js 가 PDF 를 **열 때** 그 주소를 직접
 * 불러오는데(모듈 워커, 실패하면 메인 스레드 동적 import), 그 한 번이 실패하면
 * 곧바로 끝이었다 —
 *
 *   Setting up fake worker failed: "Failed to fetch dynamically imported module:
 *   https://…/assets/pdf.worker.min-*.mjs"
 *
 * 배포 중 컨테이너가 교체되는 몇 초, 회선이 끊긴 순간, 확장 프로그램·중간
 * 프록시가 그 주소를 막는 경우, MIME 이 어긋난 서버 — 어느 것이든 같은 화면이
 * 된다. 개발 서버에서는 localhost 라 사실상 안 나고, 그래서 **배포에서만**
 * 드러났다.
 *
 * 미리 받아 두면 그 한 번이 사라진다. 이미 메모리에 있으므로 열 때 네트워크를
 * 타지 않고, blob 은 우리가 `text/javascript` 로 만들므로 MIME 검사에도 걸리지
 * 않으며, 실패하면 우리가 다시 시도할 수 있다. 모듈 워커를 못 만드는 브라우저가
 * 쓰는 '가짜 워커' 경로(메인 스레드 import)도 같은 blob 을 쓴다.
 *
 * blob 으로 옮겨도 되는 이유: `pdf.worker.min.mjs` 는 정적 import 가 하나도 없는
 * 자기완결 번들이다(실측). 상대 경로 import 가 있었다면 blob 안에서 풀 수 없다.
 */
async function toBlobUrl(url: string): Promise<string> {
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { credentials: "same-origin" });
      if (!res.ok) throw new Error(`워커를 받지 못했습니다 (${res.status})`);
      const code = await res.blob();
      return URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    } catch (e) {
      last = e; // 배포 중 교체처럼 잠깐인 실패가 많다 — 한 번은 더 해 본다
    }
  }
  throw last instanceof Error ? last : new Error("워커를 받지 못했습니다");
}

export function loadPdfJs(): Promise<PdfJs> {
  if (!loading) {
    loading = (async () => {
      const [mod, workerUrl] = await Promise.all([
        import("pdfjs-dist"),
        import("pdfjs-dist/build/pdf.worker.min.mjs?url").then((m) => m.default as string),
      ]);
      try {
        mod.GlobalWorkerOptions.workerSrc = await toBlobUrl(workerUrl);
      } catch {
        // 미리 받기가 실패해도 PDF 를 포기하지는 않는다. 주소를 그대로 넘기면
        // 적어도 예전만큼은 된다(pdf.js 가 자기 방식으로 한 번 더 시도한다).
        mod.GlobalWorkerOptions.workerSrc = workerUrl;
      }
      return mod;
    })();
    // 실패한 약속을 들고 있으면 다시 눌러도 같은 실패가 되돌아온다
    loading.catch(() => { loading = null; });
  }
  return loading;
}
