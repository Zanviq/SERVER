import { Moon, Sun, Monitor } from "lucide-react";
import { ThemeMode, useTheme } from "../../store/theme";

const OPTS: { mode: ThemeMode; icon: typeof Sun; label: string }[] = [
  { mode: "light", icon: Sun, label: "라이트" },
  { mode: "dark", icon: Moon, label: "다크" },
  { mode: "system", icon: Monitor, label: "시스템" },
];

export function ThemeToggle() {
  const { mode, setMode } = useTheme();
  return (
    <div className="inline-flex rounded-md border border-line bg-subtle p-0.5">
      {OPTS.map(({ mode: m, icon: Icon, label }) => (
        <button
          key={m}
          onClick={() => setMode(m)}
          title={label}
          aria-label={label}
          className={`grid h-7 w-7 place-items-center rounded-sm transition-colors coarse:h-9 coarse:w-10 ${
            mode === m
              ? "bg-surface text-accent shadow-sm"
              : "text-fg-muted hover:text-fg"
          }`}
        >
          <Icon size={14} />
        </button>
      ))}
    </div>
  );
}
