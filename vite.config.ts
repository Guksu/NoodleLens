import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { buildManifest } from './src/manifest.ts';
import pkg from './package.json' with { type: 'json' };

const root = import.meta.dirname;

export function outDirFor(mode: string): string {
  return resolve(root, mode === 'production' ? 'dist' : 'dist-dev');
}

/** package.json 버전과 빌드 모드로 manifest.json을 만든다. */
function manifestPlugin(mode: string): Plugin {
  return {
    name: 'noodlelens-manifest',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: JSON.stringify(buildManifest({ version: pkg.version, mode }), null, 2),
      });
    },
  };
}

// 사이드 패널(React)과 service worker(ES module)를 함께 빌드한다.
// content script는 classic script여야 해서 vite.content.config.ts에서 IIFE로 따로 빌드한다.
export default defineConfig(({ mode }) => ({
  plugins: [react(), manifestPlugin(mode)],
  publicDir: resolve(root, 'public'),
  define: {
    __NL_DEV__: JSON.stringify(mode !== 'production'),
  },
  build: {
    outDir: outDirFor(mode),
    emptyOutDir: true,
    target: 'chrome120',
    modulePreload: false,
    sourcemap: mode !== 'production',
    rollupOptions: {
      input: {
        sidepanel: resolve(root, 'sidepanel.html'),
        background: resolve(root, 'src/background/index.ts'),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
      },
    },
  },
}));
