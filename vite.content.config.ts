import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { outDirFor } from './vite.config.ts';

const root = import.meta.dirname;

// chrome.scripting.executeScript({ files })는 classic script로 주입되므로 IIFE 한 파일로 만든다.
export default defineConfig(({ mode }) => ({
  publicDir: false,
  define: {
    __NL_DEV__: JSON.stringify(mode !== 'production'),
    'process.env.NODE_ENV': JSON.stringify(mode === 'production' ? 'production' : 'development'),
  },
  build: {
    outDir: outDirFor(mode),
    emptyOutDir: false,
    target: 'chrome120',
    sourcemap: mode !== 'production' ? 'inline' : false,
    lib: {
      entry: resolve(root, 'src/content/index.ts'),
      formats: ['iife'],
      name: 'NoodleLensContent',
      fileName: () => 'content.js',
    },
  },
}));
