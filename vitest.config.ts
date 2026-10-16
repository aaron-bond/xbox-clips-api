import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // Tests never reach the network: the routes run against a fake provider, so this
      // key exists only to satisfy the binding.
      miniflare: { bindings: { XBL_API_KEY: 'test-key' } },
    }),
  ],
});
