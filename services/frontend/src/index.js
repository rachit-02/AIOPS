// Frontend service: serves the web UI and proxies /api to the gateway so the
// browser talks to a single origin (no CORS setup needed).
// PLACEHOLDER UI for Phase 1 - the real React app replaces public/ in Phase 6.
import { fileURLToPath } from 'node:url';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { createService, express } from '../../_shared/index.js';

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://gateway:3000';
const { app, start } = createService({ name: 'frontend', parseBody: false });

app.use('/api', createProxyMiddleware({ target: GATEWAY_URL, changeOrigin: true, pathRewrite: (p) => `/api${p}` }));
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));

start();
