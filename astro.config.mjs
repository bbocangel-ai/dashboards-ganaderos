import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

// https://bbocangel-ai.github.io/dashboards-ganaderos
export default defineConfig({
  site: 'https://bbocangel-ai.github.io',
  base: '/dashboards-ganaderos',
  integrations: [tailwind()],
  output: 'static',
});
