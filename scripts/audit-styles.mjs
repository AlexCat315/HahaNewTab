#!/usr/bin/env node
/**
 * 样式护栏：统计组件里绕过设计 token 的写法
 *
 * token 体系（styles/variables.scss + styles/mixins.scss）立好之后，组件只需要
 * 引用 token；一旦有人回去写 hex、写 rgba、写 `.dark-mode .foo`，主题就又跟不上。
 * 这类写法肉眼 review 很容易漏，所以做成脚本，改一处就能看见总量在往哪个方向走。
 *
 * 范围除 .vue 外还收 composables/*.ts：那里用 h() 直接建浮层、用内联 style 写层序，
 * 是组件之外第二个能绕过 token 的入口。
 *
 * 用法：
 *   node scripts/audit-styles.mjs              # 打印清单与总计
 *   node scripts/audit-styles.mjs --fail       # 有残留就非零退出（给 CI 用）
 *   node scripts/audit-styles.mjs --json       # 机器可读输出
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(__dirname, '../src');

/** 检查项：命中即算一次违规 */
const CHECKS = [
    {
        id: 'hardcoded-color',
        label: '硬编码颜色',
        // hex 与 rgb()/rgba() 字面量。color-mix(... , transparent) 不算违规。
        pattern: /#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(/
    },
    {
        id: 'dark-mode-override',
        label: '深色局部覆盖',
        // 深色差异应由「暗色变体主题」给出，组件里再写一套 = 第二套深色值。
        // 匹配 html.dark-mode / .dark-mode / :global(html.dark-mode) 三种写法。
        pattern: /\bdark-mode\b/
    },
    {
        id: 'sub-token-font',
        label: '12px 以下字号',
        pattern: /font-size:\s*(?:[1-9]|1[01])px\b/
    },
    {
        id: 'raw-z-index',
        label: '未走 token 的 z-index',
        pattern: /z-index:\s*(?!var\()[\d-]+/
    },
    {
        id: 'radius-literal',
        label: '圆角字面量',
        pattern: /border-radius:\s*\d/
    },
    {
        id: 'js-style-literal',
        label: '内联样式字面量',
        // composables 里用 h()/Object.assign(style) 建浮层，绕过 <style> 块，
        // 上面按 CSS 语法写的规则一条都抓不到它 —— 9999/10000 就是这么溜过去的。
        pattern: /(?:backgroundColor|borderColor|boxShadow|zIndex|borderRadius|fontSize|padding|margin|gap)\s*:\s*['"`]?\s*(?:#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\d{3,}\b)/
    },
    {
        id: 'icon-size-literal',
        label: '图标尺寸字面量',
        // 图标边长只准取 --icon-* 阶；:size="18" 这类数字是「同一屏 16 种图标尺寸」的来源。
        pattern: /:size="\d+/
    },
    {
        id: 'tracking-literal',
        label: '字距字面量',
        pattern: /letter-spacing:\s*[\d.]+px/
    },
    {
        id: 'weight-literal',
        label: '字重字面量',
        // 字重只有 --weight-regular/medium/semibold 三档；写 500/600/700 的组件
        // 和写 var(--weight-semibold) 的组件在同一行里会差半档。
        pattern: /font-weight:\s*\d/
    },
    {
        id: 'raw-semantic-color',
        label: '语义色直连色板',
        // error/success 表达的是「语义」，组件走 --color-error / --tint-error 这层；
        // 直连色板会让警告色这种「色板里没有的颜色」没有统一入口，
        // 也挡不住以后给语义色加主题覆盖（比如暗色下更亮的 error）。
        pattern: /var\(--md-sys-color-(?:error|success)\)/
    }
];

/** styles/ 目录本身就是 token 的定义处，允许出现字面量 */
const EXCLUDED_DIRS = [resolve(SRC_DIR, 'styles')];

/** composables 目录单独收 .ts：它们用内联 style 渲染浮层，同样受 token 约束 */
const STYLE_IN_JS_DIRS = [resolve(SRC_DIR, 'composables')];

function collectVueFiles(dir, out = []) {
    const scanTs = STYLE_IN_JS_DIRS.includes(dir);
    for (const entry of readdirSync(dir)) {
        const full = resolve(dir, entry);
        if (entry === '__tests__' || entry === 'node_modules') {
            continue;
        }
        const st = statSync(full);
        if (st.isDirectory()) {
            if (!EXCLUDED_DIRS.includes(full)) {
                collectVueFiles(full, out);
            }
        } else if (entry.endsWith('.vue') || (scanTs && entry.endsWith('.ts'))) {
            out.push(full);
        }
    }
    return out;
}

/**
 * 去掉注释，避免「解释为什么不用硬编码」的注释本身被当成违规。
 * 只处理样式与脚本里常见的三种注释形式，够用即可。
 */
function stripComments(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter(line => {
            const trimmed = line.trim();
            return !trimmed.startsWith('//') && !trimmed.startsWith('*');
        })
        .join('\n');
}

/**
 * 行内豁免：`/* token-allow *\/` 标记的行不参与统计。
 * 只给「结构上就该脱离 token」的写法用，例如壁纸层必须 z-index:-1 压在内容之下。
 */
function dropAllowedLines(content) {
    return content
        .split('\n')
        .filter(line => !line.includes('token-allow'))
        .join('\n');
}

const asJson = process.argv.includes('--json');
const failOnFindings = process.argv.includes('--fail');

const files = collectVueFiles(SRC_DIR).sort();
const totals = Object.fromEntries(CHECKS.map(check => [check.id, 0]));
const rows = [];

for (const file of files) {
    const content = dropAllowedLines(stripComments(readFileSync(file, 'utf8')));
    const lines = content.split('\n');
    const perCheck = {};

    for (const check of CHECKS) {
        let count = 0;
        for (const line of lines) {
            const matches = line.match(new RegExp(check.pattern.source, check.pattern.flags + 'g'));
            if (matches) {
                count += matches.length;
            }
        }
        if (count > 0) {
            perCheck[check.id] = count;
            totals[check.id] += count;
        }
    }

    const fileTotal = Object.values(perCheck).reduce((a, b) => a + b, 0);
    if (fileTotal > 0) {
        rows.push({ file: relative(resolve(__dirname, '..'), file), total: fileTotal, checks: perCheck });
    }
}

rows.sort((a, b) => b.total - a.total);
const grandTotal = Object.values(totals).reduce((a, b) => a + b, 0);

if (asJson) {
    console.log(JSON.stringify({ totals, files: rows, grandTotal }, null, 2));
} else {
    if (rows.length === 0) {
        console.log('样式护栏：组件里已无绕过 token 的写法。');
    } else {
        // 每个文件一行，只列它命中的检查项——检查项会随 token 体系增长，
        // 固定列表格加到第九列就已经读不动了。
        for (const row of rows) {
            const detail = CHECKS
                .filter(check => row.checks[check.id])
                .map(check => `${check.label}×${row.checks[check.id]}`)
                .join('  ');
            console.log(`${String(row.total).padStart(3)}  ${row.file.padEnd(50)} ${detail}`);
        }
        console.log('');
        for (const check of CHECKS) {
            if (totals[check.id]) {
                console.log(`  ${check.label.padEnd(14)} ${totals[check.id]}`);
            }
        }
        console.log(`\n合计 ${grandTotal} 处，分布在 ${rows.length} 个文件。`);
        console.log('迁移方向：颜色走 var(--card-bg)/var(--glass-bg-*)/var(--tint-*)，深色差异交给暗色变体主题，'
            + '几何走 --space/--radius/--card-*/--z-*，排版走 --text-*/--weight-*/--tracking-*/--icon-*/--control-h-*。');
    }
}

if (failOnFindings && grandTotal > 0) {
    process.exit(1);
}
