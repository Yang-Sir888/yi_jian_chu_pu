import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import process from 'node:process';

// TCB credentials are injected from the platform-managed .env.tcb file.
const tcbEnv: Record<string, string> = {};
try {
  for (const line of fs.readFileSync('/workspace/.env.tcb', 'utf-8').split('\n')) {
    const index = line.indexOf('=');
    if (index > 0) tcbEnv[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
} catch { /* development without cloud services */ }

// 热更新只在平台直连预览时才有意义；经隧道或正式域名访问时，浏览器连不到沙箱内网 HMR，
// 只会在控制台刷 WebSocket 报错。因此默认关掉，确需热更新时设 ENABLE_HMR=1 再开。
const previewHmr = process.env.ENABLE_HMR === '1';

export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_CLOUDBASE_ENV_ID': JSON.stringify(tcbEnv.CLOUDBASE_ENV_ID || ''),
    'import.meta.env.VITE_CLOUDBASE_REGION': JSON.stringify(tcbEnv.CLOUDBASE_REGION || 'ap-shanghai'),
    'import.meta.env.VITE_CLOUDBASE_PUBLISH_KEY': JSON.stringify(tcbEnv.CLOUDBASE_PUBLISH_KEY || ''),
  },
  worker: {format: 'es'},
  server: {
    host: '::',
    port: 5173,
    allowedHosts: true,
    cors: true,
    hmr: previewHmr ? {
      protocol: 'wss',
      host: `5173-${process.env.X_IDE_SPACE_KEY}.e2b.${process.env.X_IDE_SPACE_REGION}.${process.env.X_IDE_SPACE_HOST}`,
      clientPort: 443,
    } : false,
    proxy: {
      '/api': {target: 'http://localhost:3000', changeOrigin: true, secure: false},
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
});
