import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: 'oklch(97% 0.02 250)',
          100: 'oklch(93% 0.05 250)',
          500: 'oklch(55% 0.22 250)',
          600: 'oklch(48% 0.22 250)',
          900: 'oklch(20% 0.08 250)',
        },
        surface: {
          DEFAULT: 'oklch(12% 0.01 240)',
          card: 'oklch(16% 0.015 240)',
          elevated: 'oklch(20% 0.02 240)',
        },
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
        display: ['var(--font-cal)', 'var(--font-inter)', 'sans-serif'],
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'fade-in': 'fadeIn 0.2s ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
}
export default config
