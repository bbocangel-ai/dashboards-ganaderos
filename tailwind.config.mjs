/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50:  '#f5f7f3',
          100: '#e6ecdf',
          200: '#cdd9bf',
          300: '#a9bd91',
          400: '#84a064',
          500: '#658246',
          600: '#4f6836',
          700: '#3f522e',
          800: '#344226',
          900: '#2c3821',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
