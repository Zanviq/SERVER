import { create } from "zustand";
import { api, VocabJob } from "../lib/api";
import { toast } from "./toast";

/**
 * 단어장 백그라운드 정리 작업 추적.
 *
 * 후보를 골라 넣거나 글을 붙여 넣어 정리하면 서버가 스레드에서 사전 내용을
 * 채운다. 그 사이에도 계속 공부할 수 있어야 하므로 화면을 막지 않고, 대신
 * 여기서 상태만 지켜본다. 끝나면 version 이 올라가고 단어장 패널이 다시 받는다.
 *
 * 작업은 서버 메모리에만 있어서 새로고침하면 추적이 끊긴다 — 그래도 이미 들어간
 * 항목은 단어장에 남는다(다음 로드 때 그냥 보인다).
 */
interface VocabJobsState {
  /** 지켜보는 중인 작업 (진행 중인 것만) */
  jobs: VocabJob[];
  /** 작업이 끝날 때마다 올라간다. 단어장 패널이 이걸 보고 다시 받는다. */
  version: number;
  /** 방금 시작한 작업을 등록하고 폴링을 켠다 */
  track: (job: VocabJob) => void;
}

const POLL_MS = 2000;
let timer: number | null = null;

export const useVocabJobs = create<VocabJobsState>((set) => ({
  jobs: [],
  version: 0,
  track: (job) => {
    if (job.status !== "pending") {
      // 서버가 즉시 끝냈다(키가 없거나 잘못된 요청) — 결과만 알린다
      announce(job);
      set((s) => ({ version: s.version + 1 }));
      return;
    }
    set((s) => (s.jobs.some((j) => j.id === job.id) ? s : { jobs: [...s.jobs, job] }));
    if (timer === null) timer = window.setInterval(() => void tick(), POLL_MS);
  },
}));

function announce(job: VocabJob) {
  if (job.status === "failed") {
    toast.error(job.error || "단어장 정리에 실패했습니다");
    return;
  }
  const n = job.added.length + job.merged.length;
  const bits: string[] = [];
  if (job.added.length) bits.push(`${job.added.length}개 추가`);
  if (job.merged.length) bits.push(`${job.merged.length}개 합침`);
  if (job.failed.length) bits.push(`${job.failed.length}개 실패`);
  if (n === 0 && job.failed.length === 0) {
    toast.error("단어장에 넣지 못했습니다");
    return;
  }
  toast.ok(`단어장 — ${bits.join(" · ")}`);
  if (job.error) toast.error(job.error);
}

async function tick() {
  const watching = useVocabJobs.getState().jobs;
  if (watching.length === 0) {
    stop();
    return;
  }
  let rows: VocabJob[];
  try {
    rows = (await api.vocabJobs()).jobs;
  } catch {
    return; // 잠깐 못 받은 것뿐이다 — 다음 차례에 다시 본다
  }
  const byId = new Map(rows.map((j) => [j.id, j]));
  const still: VocabJob[] = [];
  let finished = 0;
  for (const w of watching) {
    const cur = byId.get(w.id);
    if (!cur) continue; // 서버가 재시작돼 기록이 사라졌다 — 추적만 접는다
    if (cur.status === "pending") {
      still.push(cur);
      continue;
    }
    announce(cur);
    finished++;
  }
  useVocabJobs.setState((s) => ({
    jobs: still,
    version: finished ? s.version + 1 : s.version,
  }));
  if (still.length === 0) stop();
}

function stop() {
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
}

export const vocabJobs = {
  track: (job: VocabJob) => useVocabJobs.getState().track(job),
};
