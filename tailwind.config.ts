import type { Config } from "tailwindcss";
import tailwindcssAnimate from "tailwindcss-animate";

const config: Config = {
  darkMode: "class",
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
    "./src/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        surface: {
          DEFAULT: "var(--surface)",
          2: "var(--surface-2)",
          3: "var(--surface-3)",
        },
        border: {
          DEFAULT: "var(--border)",
          soft: "var(--border-soft)",
        },
        fg: "var(--fg)",
        muted: "var(--muted)",
        faint: "var(--faint)",
        accent: {
          DEFAULT: "var(--accent)",
          soft: "var(--accent-soft)",
          line: "var(--accent-line)",
        },
        ok: { DEFAULT: "var(--ok)", bg: "var(--ok-bg)" },
        run: { DEFAULT: "var(--run)", bg: "var(--run-bg)" },
        warn: { DEFAULT: "var(--warn)", bg: "var(--warn-bg)" },
        err: { DEFAULT: "var(--err)", bg: "var(--err-bg)" },
        idle: { DEFAULT: "var(--idle)", bg: "var(--idle-bg)" },
      },
      borderColor: {
        DEFAULT: "var(--border)",
      },
      borderRadius: {
        sm: "var(--r-sm)",
        md: "var(--r-md)",
        lg: "var(--r-lg)",
      },
      spacing: {
        xs: "4px",
        sm: "8px",
        md: "14px",
        lg: "24px",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "Inter", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SF Mono", "JetBrains Mono", "monospace"],
      },
    },
  },
  plugins: [tailwindcssAnimate],
};

export default config;
