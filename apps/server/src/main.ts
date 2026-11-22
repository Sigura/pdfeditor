import { serve } from '@hono/node-server';
import { configureFonts } from '@pdf-toolkit/pdf-core';
import { createApp } from './app.ts';
import { config } from './config.ts';

configureFonts({ dirs: [config.fontsDir], system: config.systemFonts });
const { app, store } = createApp();
await store.init();
serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`pdf-toolkit server listening on http://localhost:${info.port}`);
});
