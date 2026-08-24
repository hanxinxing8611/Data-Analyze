import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  // GitHub Pages 项目站点子路径（仓库名 Data-Analyze；本地 dev 地址同步带该前缀）
  base: '/Data-Analyze/',
  plugins: [react()],
  server: {
    port: 5173,
    open: false,
  },
  build: {
    // 本机文件系统过滤驱动会加密 node 写入的文件：独立的 esbuild.exe 进程
    // 直接读盘会拿到密文导致构建失败。terser 在 node 进程内运行可完全规避；
    // target: esnext 跳过 vite:esbuild-transpile 的 renderChunk 环节。
    target: 'esnext',
    minify: 'terser',
    terserOptions: {
      compress: { drop_console: false },
      format: { comments: false },
    },
  },
});
