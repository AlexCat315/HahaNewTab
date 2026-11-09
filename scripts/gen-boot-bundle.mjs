/**
 * 生成首帧预加载用的数据包
 *
 * 主题预加载脚本在 Vue 挂载前同步执行，拿不到模块系统、也不能发同步 XHR。
 * 这里把「存储契约 + 主题配置」在构建期打成一个普通 JS 文件：
 *   - dev：由 Vite 中间件直接返回（不落盘）；
 *   - build：作为 asset 输出到 dist/config/boot-bundle.js。
 *
 * 契约与主题配置的唯一来源分别是 src/config/storageContract.json 与 public/config/themes.json，
 * 改键名或主题数据不需要再改 public/theme-preload.js。
 *
 * 本文件同时被 vite.config.ts / vitest.config.ts 作为模块 import，因此不能带 shebang，
 * 也不能依赖 import.meta.url（esbuild 内联配置时会改写它）。根目录统一取 process.cwd()，
 * Vite、Vitest 与下面的独立写入模式都从项目根运行。
 *
 * 独立查看产物：node scripts/gen-boot-bundle.mjs --write
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

/** 生成的数据包路径（index.html / view/popup.html 引用它） */
export const BOOT_BUNDLE_PATH = '/config/boot-bundle.js';

function readJson(relativePath) {
    return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

/** 生成完整脚本内容；每次调用都重读源文件，dev 下改主题立即生效 */
export function buildBootBundleSource() {
    const contract = readJson('src/config/storageContract.json');
    const themes = readJson('public/config/themes.json');
    const payload = {
        contract: {
            boot: {
                key: contract.boot.key,
                version: contract.boot.version,
                preload: contract.boot.preload
            }
        },
        themes: {
            themes: themes.themes ?? [],
            legacyIds: themes.legacyIds ?? {},
            defaultTheme: themes.defaultTheme ?? null
        }
    };
    return [
        '/* 由 scripts/gen-boot-bundle.mjs 生成，请勿直接编辑 */',
        `window.__HAHA_BOOT__ = ${JSON.stringify(payload)};`,
        ''
    ].join('\n');
}

if (process.argv.includes('--write')) {
    const out = path.join(ROOT, 'public', 'config', 'boot-bundle.js');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, buildBootBundleSource(), 'utf8');
    console.log(`✅ 已生成 ${path.relative(ROOT, out)}`);
}
