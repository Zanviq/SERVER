// pdf.js 는 크다(~1MB). 논문 화면에서 처음 PDF 를 열 때만 받는다.
// 워커는 Vite 가 별도 파일로 뽑아 주고(?url) 그 주소를 pdf.js 에 알려 준다.
export type PdfJs = typeof import("pdfjs-dist");

let loading: Promise<PdfJs> | null = null;

export function loadPdfJs(): Promise<PdfJs> {
  if (!loading) {
    loading = Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
    ]).then(([mod, worker]) => {
      mod.GlobalWorkerOptions.workerSrc = worker.default;
      return mod;
    });
    loading.catch(() => { loading = null; });
  }
  return loading;
}
