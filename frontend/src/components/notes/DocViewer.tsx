import { Download, FileQuestion, ExternalLink } from "lucide-react";
import { api, DocKind } from "../../lib/api";
import { formatBytes } from "../../lib/format";

/**
 * 편집할 수 없는 문서(이미지·PDF·미디어·기타)의 열람 패널.
 * 브라우저 내장 기능만 쓰므로 추가 의존성이 없다.
 */
export function DocViewer({
  path,
  kind,
  size,
}: {
  path: string;
  kind: DocKind;
  size: number;
}) {
  const src = api.noteRawUrl(path);

  const toolbar = (
    <div className="flex items-center gap-2 border-b border-line px-3 py-2">
      <span className="label">{formatBytes(size)}</span>
      <div className="flex-1" />
      <a href={src} target="_blank" rel="noreferrer" className="btn btn-ghost h-8 px-2"
         title="새 탭에서 열기">
        <ExternalLink size={14} />
      </a>
      <a href={api.noteRawUrl(path, true)} download className="btn btn-secondary h-8">
        <Download size={14} /> 다운로드
      </a>
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      {toolbar}
      <div className="flex flex-1 items-center justify-center overflow-auto bg-subtle p-3">
        {kind === "image" ? (
          <img src={src} alt={path} className="max-h-full max-w-full object-contain" />
        ) : kind === "pdf" ? (
          // 브라우저 내장 PDF 뷰어 — 페이지 이동·확대·인쇄까지 그대로 쓴다
          <iframe src={src} title={path} className="h-full w-full rounded border border-line bg-white" />
        ) : kind === "video" ? (
          <video src={src} controls className="max-h-full max-w-full rounded" />
        ) : kind === "audio" ? (
          <audio src={src} controls className="w-full max-w-lg" />
        ) : (
          <div className="flex flex-col items-center gap-2 text-fg-muted">
            <FileQuestion size={30} />
            <span className="text-[13px]">미리보기를 지원하지 않는 형식입니다</span>
            <span className="text-[12px] text-fg-subtle">다운로드해서 확인하세요</span>
          </div>
        )}
      </div>
    </div>
  );
}
