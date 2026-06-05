import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

// Vercel define VERCEL=1 durante el build automaticamente.
// En GitHub Pages no esta seteada, asi que usa el path /dashboards-ganaderos.
const IS_VERCEL = process.env.VERCEL === '1';

export default defineConfig({
  site: IS_VERCEL
    ? 'https://dashboards-ganaderos.vercel.app'
    : 'https://bbocangel-ai.github.io',
  base: IS_VERCEL ? '/' : '/dashboards-ganaderos',
  integrations: [tailwind()],
  output: 'static',
});
