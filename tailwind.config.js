/** @type {import('tailwindcss').Config} */
// Design tokens are the source of truth from docs/06-ui-ux.md §6.2 and the
// Figma "TestHound Dark" variable collection. Dark-first developer-tool aesthetic.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          base: "#0B0D10",
          surface: "#14171C",
          "surface-2": "#1B1F26",
        },
        border: {
          subtle: "#262B33",
          strong: "#333A44",
        },
        text: {
          primary: "#E6EAF0",
          secondary: "#9AA4B2",
          muted: "#5E6875",
        },
        brand: {
          primary: "#6E8BFF",
          accent: "#00D3A7",
        },
        status: {
          passed: "#3FB950",
          failed: "#F85149",
          blocked: "#D29922",
          retest: "#A371F7",
          skipped: "#6E7681",
          drifted: "#E3A008",
        },
      },
      fontFamily: {
        sans: [
          "Inter",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif",
        ],
        mono: [
          "JetBrains Mono",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
      },
      fontSize: {
        xs: ["12px", { lineHeight: "1.5" }],
        sm: ["13px", { lineHeight: "1.5" }],
        base: ["14px", { lineHeight: "1.5" }],
        md: ["16px", { lineHeight: "1.5" }],
        lg: ["20px", { lineHeight: "1.4" }],
        xl: ["28px", { lineHeight: "1.3" }],
      },
      borderRadius: {
        control: "6px",
        card: "10px",
      },
      spacing: {
        // 4px base scale is already Tailwind's default (1 = 4px).
      },
      ringWidth: {
        DEFAULT: "2px",
      },
      ringColor: {
        DEFAULT: "#6E8BFF",
      },
    },
  },
  plugins: [],
};
