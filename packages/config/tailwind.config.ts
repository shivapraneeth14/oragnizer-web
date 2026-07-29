import type { Config } from "tailwindcss"

const config: Config = {
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#eef2ff",
          100: "#e0e7ff",
          200: "#c7d2fe",
          300: "#a5b4fc",
          400: "#818cf8",
          500: "#6366f1",
          600: "#4f46e5",
          700: "#4338ca",
          800: "#3730a3",
          900: "#312e81",
          950: "#1e1b4b",
        },
        neutral: {
          50: "#fafafa",
          100: "#f5f5f5",
          200: "#e5e5e5",
          300: "#d4d4d4",
          400: "#a3a3a3",
          500: "#737373",
          600: "#525252",
          700: "#404040",
          800: "#262626",
          900: "#171717",
          950: "#0a0a0a",
        },
        success: "#10b981",
        warning: "#f59e0b",
        error: "#ef4444",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
      },
      spacing: {
        0.5: "0.25rem",
        1: "0.5rem",
        1.5: "0.75rem",
        2: "1rem",
        2.5: "1.25rem",
        3: "1.5rem",
        3.5: "1.75rem",
        4: "2rem",
        5: "2.5rem",
        6: "3rem",
        7: "3.5rem",
        8: "4rem",
        9: "4.5rem",
        10: "5rem",
      },
      borderRadius: {
        sm: "0.25rem",
        md: "0.5rem",
        lg: "0.75rem",
        xl: "1rem",
        "2xl": "1.5rem",
        full: "9999px",
      },
      boxShadow: {
        soft: "0 1px 2px 0 rgb(0 0 0 / 0.03)",
        medium: "0 4px 6px -1px rgb(0 0 0 / 0.07)",
        strong: "0 10px 15px -3px rgb(0 0 0 / 0.1)",
      },
    },
  },
  plugins: [],
}

export default config
