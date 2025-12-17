/** @type {import('tailwindcss').Config} */
export default {
  // Vite + React: scan html + all TS/TSX/JS/JSX under src for class names
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {},
  },
  plugins: [],
}

