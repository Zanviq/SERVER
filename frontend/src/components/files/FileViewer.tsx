import { useEffect, useState } from "react";
import { Sparkles, Download, Send, Loader2, FileText } from "lucide-react";
import { Modal } from "../ui/Modal";
import { api, FileEntry } from "../../lib/api";
import { isTextFile, formatBytes } from "../../lib/format";

interface Props {
  file: FileEntry | null;
  onClose: () => void;
  onError: (msg: string) => void;
}

export function FileViewer({ file, onClose, onError }: Props) {
  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState<string>("");
  const [busy, setBusy] = useState<"" | "summary" | "chat">("");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");

  const text = file ? isTextFile(file.name) : false;

  useEffect(() => {
    setContent("");
    setSummary("");
    setAnswer("");
    setQuestion("");
    if (!file || !isTextFile(file.name)) return;
    setLoading(true);
    fetch(api.downloadUrl(file.path))
      .then((r) => r.text())
      .then((t) => setContent(t.slice(0, 20000)))
      .catch(() => onError("미리보기를 불러오지 못했습니다."))
      .finally(() => setLoading(false));
  }, [file, onError]);

  const runSummary = async () => {
    if (!file) return;
    setBusy("summary");
    setSummary("");
    try {
      const r = await api.summarize(file.path);
      setSummary(r.result);
    } catch (e) {
      onError(e instanceof Error ? e.message : "요약 실패");
    } finally {
      setBusy("");
    }
  };

  const ask = async () => {
    if (!file || !question.trim()) return;
    setBusy("chat");
    setAnswer("");
    try {
      const r = await api.chat(file.path, question.trim());
      setAnswer(r.result);
    } catch (e) {
      onError(e instanceof Error ? e.message : "질문 실패");
    } finally {
      setBusy("");
    }
  };

  return (
    <Modal open={!!file} onClose={onClose} title={file?.name} width="max-w-3xl">
      {file && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="label-mono">{formatBytes(file.size)}</span>
            <a href={api.downloadUrl(file.path)} download className="btn">
              <Download size={13} /> Download
            </a>
            {text && (
              <button onClick={runSummary} disabled={busy !== ""} className="btn btn-accent">
                {busy === "summary" ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                AI 요약
              </button>
            )}
          </div>

          {summary && (
            <div className="rounded-lg border border-phosphor/20 bg-phosphor/[0.04] p-4">
              <div className="label-mono mb-2 flex items-center gap-1.5 text-phosphor">
                <Sparkles size={12} /> Gemini Summary
              </div>
              <pre className="whitespace-pre-wrap font-sans text-sm text-ash-100">{summary}</pre>
            </div>
          )}

          {text ? (
            <div className="max-h-[40vh] overflow-auto rounded-lg border border-white/[0.06] bg-carbon-900 p-4">
              {loading ? (
                <div className="flex items-center gap-2 text-ash-500">
                  <Loader2 size={14} className="animate-spin" /> 로딩…
                </div>
              ) : (
                <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-ash-300">
                  {content || "(빈 파일)"}
                </pre>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-white/[0.08] py-10 text-ash-500">
              <FileText size={28} />
              <span className="label-mono">미리보기 미지원 · 다운로드로 확인</span>
            </div>
          )}

          {text && (
            <div className="space-y-2">
              <div className="label-mono flex items-center gap-1.5">
                <Sparkles size={12} className="text-signal-cyan" /> 이 문서에게 질문
              </div>
              <div className="flex gap-2">
                <input
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && ask()}
                  placeholder="예: 핵심 결론이 뭐야?"
                  className="flex-1 rounded-lg border border-white/[0.08] bg-carbon-900 px-3 py-2 font-mono text-sm text-ash-100 outline-none placeholder:text-ash-700 focus:border-signal-cyan/50"
                />
                <button onClick={ask} disabled={busy !== "" || !question.trim()} className="btn">
                  {busy === "chat" ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
                </button>
              </div>
              {answer && (
                <div className="rounded-lg border border-signal-cyan/20 bg-signal-cyan/[0.04] p-4">
                  <pre className="whitespace-pre-wrap font-sans text-sm text-ash-100">{answer}</pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
