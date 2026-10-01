import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://oliverdelange.co.uk',
  base: process.env.BASE_PATH || '/',
  output: 'static',
});
