import { useEffect, useState } from "react";
import { Download, Loader2, FileText } from "lucide-react";
import { Modal } from "../ui/Modal";
import { api, FileEntry, Scope } from "../../lib/api";
import { isTextFile, fileKind, formatBytes } from "../../lib/format";

export function FileViewer({
  scope,
  file,
  onClose,
  onError,
}: {
  scope: Scope;
  file: FileEntry | null;
  onClose: () => void;
  onError: (m: string) => void;
}) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);

  const isText = file ? isTextFile(file.name) : false;
  const isImg = file ? fileKind(file.name) === "img" : false;

  useEffect(() => {
    setText("");
    if (!file || !isTextFile(file.name)) return;
    setLoading(true);
    fetch(api.downloadUrl(scope, file.path), { credentials: "include" })
      .then((r) => r.text())
      .then((t) => setText(t.slice(0, 50000)))
      .catch(() => onError("미리보기를 불러오지 못했습니다."))
      .finally(() => setLoading(false));
  }, [file, scope, onError]);

  return (
    <Modal open={!!file} onClose={onClose} title={file?.name} width="max-w-3xl">
      {file && (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <span className="label">{formatBytes(file.size)}</span>
            <a href={api.downloadUrl(scope, file.path)} download className="btn btn-secondary h-8">
              <Download size={14} /> 다운로드
            </a>
          </div>

          {isText ? (
            <div className="max-h-[55vh] overflow-auto rounded-md border border-line bg-subtle p-3">
              {loading ? (
                <div className="flex items-center gap-2 text-fg-muted">
                  <Loader2 size={14} className="animate-spin" /> 로딩…
                </div>
              ) : (
                <pre className="whitespace-pre-wrap break-words font-mono text-[12.5px] leading-relaxed text-fg2">
                  {text || "(빈 파일)"}
                </pre>
              )}
            </div>
          ) : isImg ? (
            <div className="flex justify-center rounded-md border border-line bg-subtle p-2">
              <img
                src={api.downloadUrl(scope, file.path)}
                alt={file.name}
                className="max-h-[55vh] max-w-full rounded"
              />
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-line py-10 text-fg-muted">
              <FileText size={28} />
              <span className="text-[13px]">미리보기 미지원 · 다운로드로 확인</span>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
