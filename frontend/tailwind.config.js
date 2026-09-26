/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['selector', '[data-theme="dark"]'],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "rgb(var(--bg) / <alpha-value>)",
        surface: "rgb(var(--bg-elevated) / <alpha-value>)",
        subtle: "rgb(var(--bg-subtle) / <alpha-value>)",
        muted: "rgb(var(--bg-muted) / <alpha-value>)",
        hovered: "rgb(var(--bg-hover) / <alpha-value>)",
        sidebar: "rgb(var(--sidebar) / <alpha-value>)",
        "sidebar-fg": "rgb(var(--sidebar-fg) / <alpha-value>)",
        "sidebar-fg-active": "rgb(var(--sidebar-fg-active) / <alpha-value>)",
        line: "rgb(var(--line) / <alpha-value>)",
        "line-strong": "rgb(var(--line-strong) / <alpha-value>)",
        fg: "rgb(var(--fg) / <alpha-value>)",
        fg2: "rgb(var(--fg2) / <alpha-value>)",
        "fg-muted": "rgb(var(--fg-muted) / <alpha-value>)",
        "fg-subtle": "rgb(var(--fg-subtle) / <alpha-value>)",
        accent: "rgb(var(--accent) / <alpha-value>)",
        "accent-hover": "rgb(var(--accent-hover) / <alpha-value>)",
        "accent-soft": "rgb(var(--accent-soft) / <alpha-value>)",
        "accent-muted": "rgb(var(--accent-muted) / <alpha-value>)",
        "accent-fg": "rgb(var(--accent-fg) / <alpha-value>)",
        "accent-contrast": "rgb(var(--accent-contrast) / <alpha-value>)",
        positive: "rgb(var(--positive) / <alpha-value>)",
        warning: "rgb(var(--warning) / <alpha-value>)",
        danger: "rgb(var(--danger) / <alpha-value>)",
        info: "rgb(var(--info) / <alpha-value>)",
      },
      fontFamily: {
        sans: ['"Pretendard Variable"', "Pretendard", "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "monospace"],
      },
      borderRadius: {
        xs: "4px",
        sm: "6px",
        md: "10px",
        lg: "14px",
        xl: "18px",
      },
      boxShadow: {
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0", transform: "translateY(4px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        slideInRight: {
          "0%": { opacity: "0", transform: "translateX(12px)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
      },
      animation: {
        in: "fadeIn 0.18s ease-out both",
        "in-right": "slideInRight 0.22s cubic-bezier(0.32,0.72,0,1) both",
      },
    },
  },
  plugins: [
    // `coarse:` — 손가락으로 쓰는 화면에서만(마우스 화면의 모양은 그대로 둔다). 목록 줄·작은 단추를 손가락 크기로
    // 넓힐 때 쓴다 — 화면 너비(sm:)로 가르면 넓은 태블릿은 마우스 크기로, 좁은 창의 마우스는 손가락 크기로 갈린다.
    ({ addVariant }) => addVariant("coarse", "@media (pointer: coarse)"),
    // `hoverable:` — 마우스처럼 **올려 둘 수 있는** 화면에서만. '올리면 보이는' 단추는 이것으로 숨긴다. 화면 너비(sm:)로
    // 숨기던 때는 태블릿(넓지만 손가락)에서 문서 트리의 … 가 보이지 않은 채 눌렸다 — 이름 바꾸기·옮기기의 유일한 길인데
    // (디자인 8차).
    ({ addVariant }) => addVariant("hoverable", "@media (hover: hover) and (pointer: fine)"),
  ],
};
