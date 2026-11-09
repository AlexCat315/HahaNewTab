import { defineConfig, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
import svgLoader from 'vite-svg-loader';
import path from 'path';
import { BOOT_BUNDLE_PATH, buildBootBundleSource } from './scripts/gen-boot-bundle.mjs';

/**
 * 首帧数据包：dev 用中间件即时返回，build 作为 asset 落到 dist/config/。
 * 两条路径都从同一份契约与 themes.json 生成，无需在 public/ 里维护产物。
 */
function bootBundlePlugin(): Plugin {
    return {
        name: 'haha-boot-bundle',
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                if (req.url?.split('?')[0] !== BOOT_BUNDLE_PATH) {
                    next();
                    return;
                }
                res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
                res.setHeader('Cache-Control', 'no-cache');
                res.end(buildBootBundleSource());
            });
        },
        generateBundle() {
            this.emitFile({
                type: 'asset',
                fileName: BOOT_BUNDLE_PATH.replace(/^\//, ''),
                source: buildBootBundleSource()
            });
        }
    };
}

export default defineConfig({
    plugins: [vue(), svgLoader(), bootBundlePlugin()],
    publicDir: 'public',
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src')
        }
    },
    server: {
        port: 5173,
        strictPort: false,
        proxy: {
            // 开发环境代理百度 sugrec 搜索建议接口，规避浏览器 CORS 限制
            '/sugrec': {
                target: 'https://www.baidu.com',
                changeOrigin: true
            }
        }
    },
    build: {
        // 输出目录按目标区分：dist-chrome / dist-edge / dist-firefox
        // 未显式指定时默认产出 Chrome 包
        outDir: process.env.BUILD_OUT_DIR || 'dist-chrome',
        rollupOptions: {
            input: {
                main: path.resolve(__dirname, 'index.html'),
                popup: path.resolve(__dirname, 'view/popup.html'),
                'background-firefox': path.resolve(__dirname, 'src/background.ts')
            },
            output: {
                entryFileNames: (chunkInfo) => {
                    if (chunkInfo.name === 'background-firefox') {
                        return 'js/background-firefox.js';
                    }
                    return 'js/[name]-[hash].js';
                },
                chunkFileNames: 'js/[name]-[hash].js',
                assetFileNames: 'js/[name]-[hash][extname]'
            }
        }
    }
});
