import { useEffect, useRef } from "react";
import { api, CalEvent } from "../lib/api";
import { toast } from "../store/toast";

const FIRED_KEY = "tw-fired-reminders";
//: 이미 시작한 일정도 이만큼까지는 알린다. 앱이 닫혀 있었거나 화면이 잠들어
//: 알림 시각을 놓쳤을 때, "이미 시작했습니다"라도 아는 편이 침묵보다 낫다.
const GRACE_MS = 10 * 60 * 1000;

function loadFired(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(FIRED_KEY) || "[]"));
  } catch {
    return new Set();
  }
}
function saveFired(s: Set<string>) {
  // 최근 200개만 유지
  const arr = [...s].slice(-200);
  localStorage.setItem(FIRED_KEY, JSON.stringify(arr));
}

function canNotify(): boolean {
  return "Notification" in window && Notification.permission === "granted";
}

/** 다가오는 일정 알림을 폴링해 시간이 되면 브라우저 알림/토스트로 안내. */
export function ReminderPoller() {
  const fired = useRef(loadFired());

  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }

    let alive = true;
    const check = async () => {
      // 예전에는 `document.hidden` 이면 그냥 돌아갔다. 알림이 가장 필요한 때가
      // 바로 다른 창을 보고 있을 때인데, 그 사이를 통째로 건너뛰고 돌아왔을
      // 때는 이미 시작한 일정이라 조건(startTime > now)에서 빠져 **영영 울리지
      // 않았다.** 브라우저 알림 권한이 있으면 숨어 있어도 그대로 띄운다.
      // 권한이 없어 토스트만 띄울 수 있는 경우에만 미룬다 — 안 보이는 토스트를
      // 띄우고 '알렸다'고 표시해 버리면 그것도 못 본 알림이 된다.
      if (document.hidden && !canNotify()) return;
      let list: CalEvent[] = [];
      try {
        list = await api.calReminders(1440);
      } catch {
        return;
      }
      if (!alive) return;
      const now = Date.now();
      for (const ev of list) {
        if (!ev.remind_at) continue;
        const remindTime = new Date(ev.remind_at.replace(" ", "T")).getTime();
        const startTime = new Date(ev.start.replace(" ", "T")).getTime();
        if (Number.isNaN(remindTime) || Number.isNaN(startTime)) continue;
        // 알림 시각이 지났고, 시작한 지 얼마 안 됐고, 아직 안 알린 것
        if (remindTime <= now && now < startTime + GRACE_MS && !fired.current.has(ev.id)) {
          fired.current.add(ev.id);
          saveFired(fired.current);
          const when = new Date(ev.start.replace(" ", "T")).toLocaleTimeString("ko-KR", {
            hour: "2-digit",
            minute: "2-digit",
          });
          // 늦게 알리는 것이면 그렇다고 말한다. "14:00 시작"만 보이면 사용자는
          // 아직 시간이 남은 줄 안다.
          const body = now >= startTime ? `${when} 시작 — 이미 시작했습니다` : `${when} 시작`;
          if (canNotify()) {
            try {
              new Notification(`🔔 ${ev.title}`, { body });
            } catch {
              toast.ok(`🔔 ${ev.title} · ${body}`);
            }
          } else {
            toast.ok(`🔔 ${ev.title} · ${body}`);
          }
        }
      }
    };

    check();
    const id = setInterval(check, 30000);
    // 돌아왔을 때 30초를 더 기다리지 않는다(자고 일어난 노트북은 그 사이가 길다)
    const onVisible = () => {
      if (!document.hidden) check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return null;
}
