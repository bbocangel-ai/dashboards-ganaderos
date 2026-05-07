import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

// https://bbocangel.github.io/dashboards-ganaderos
export default defineConfig({
  site: 'https://bbocangel.github.io',
  base: '/dashboards-ganaderos',
  integrations: [tailwind()],
  output: 'static',
});
