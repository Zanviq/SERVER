/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Mission Control Deck — near-black carbon + phosphor lime
        carbon: {
          900: "#08090b",
          800: "#0c0e11",
          700: "#121519",
          600: "#191d23",
          500: "#22272e",
        },
        phosphor: {
          DEFAULT: "#c6f432",
          dim: "#9bbf2a",
          glow: "#d7ff5a",
        },
        signal: {
          amber: "#ffb84d",
          red: "#ff5d5d",
          cyan: "#54e6ff",
        },
        ash: {
          100: "#e9edf2",
          300: "#aab3bf",
          500: "#6b7480",
          700: "#3a4048",
        },
      },
      fontFamily: {
        display: ['"Archivo"', "system-ui", "sans-serif"],
        sans: ['"IBM Plex Sans"', "system-ui", "sans-serif"],
        mono: ['"IBM Plex Mono"', "ui-monospace", "monospace"],
      },
      keyframes: {
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(12px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "scan": {
          "0%": { transform: "translateY(-100%)" },
          "100%": { transform: "translateY(100%)" },
        },
        "pulse-dot": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.25" },
        },
        "sweep": {
          "0%": { strokeDashoffset: "var(--circ)" },
          "100%": { strokeDashoffset: "var(--target)" },
        },
      },
      animation: {
        "fade-up": "fade-up 0.6s cubic-bezier(0.16,1,0.3,1) both",
        scan: "scan 4s linear infinite",
        "pulse-dot": "pulse-dot 1.6s ease-in-out infinite",
      },
      boxShadow: {
        glow: "0 0 24px -4px rgba(198,244,50,0.35)",
        panel: "0 1px 0 0 rgba(255,255,255,0.03) inset, 0 16px 40px -24px rgba(0,0,0,0.9)",
      },
    },
  },
  plugins: [],
};
