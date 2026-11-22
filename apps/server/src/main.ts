import { serve } from '@hono/node-server';
import { configureFonts, fontIndex } from '@pdf-toolkit/pdf-core';
import { createApp } from './app.ts';
import { config } from './config.ts';

configureFonts({ dirs: [config.fontsDir], bundled: config.bundledFonts, system: config.systemFonts });
// Built before listening (seconds with CJK collections), so the first edit that needs a font doesn't wait for it.
const started = performance.now();
console.log(`font index: ${fontIndex().faces.length} faces in ${Math.round(performance.now() - started)} ms`);
const { app, store } = createApp();
await store.init();
serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`pdf-toolkit server listening on http://localhost:${info.port}`);
});
