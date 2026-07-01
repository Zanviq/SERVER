import { useEffect, useRef } from "react";
import { api, CalEvent } from "../lib/api";
import { toast } from "../store/toast";

const FIRED_KEY = "tw-fired-reminders";

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

/** 다가오는 일정 알림을 폴링해 시간이 되면 브라우저 알림/토스트로 안내. */
export function ReminderPoller() {
  const fired = useRef(loadFired());

  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }

    let alive = true;
    const check = async () => {
      if (document.hidden) return;
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
        if (Number.isNaN(remindTime)) continue;
        // 알림 시각이 지났고 아직 시작 전이며 미발화면 알림
        if (remindTime <= now && startTime > now && !fired.current.has(ev.id)) {
          fired.current.add(ev.id);
          saveFired(fired.current);
          const when = new Date(ev.start.replace(" ", "T")).toLocaleTimeString("ko-KR", {
            hour: "2-digit",
            minute: "2-digit",
          });
          const body = `${when} 시작`;
          if ("Notification" in window && Notification.permission === "granted") {
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
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return null;
}
