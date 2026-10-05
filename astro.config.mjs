import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// fork 后仓库名保持 TCM-Ancient-Books，所以 base 固定；
// 如果你把仓库改名，只改这两行即可。
export default defineConfig({
  site: 'https://Smartuil.github.io',
  base: '/TCM-Ancient-Books',
  trailingSlash: 'ignore',
  build: { format: 'directory' },
  integrations: [sitemap()],
});
