#!/usr/bin/env node
/**
 * 由 public/config/theme-seeds.json 生成 public/config/themes.json。
 *
 * 为什么要有这一步：调色板是手写的，但「24 个变体 + legacyIds + 默认主题」是机械结构。
 * 脚本负责结构，seeds 负责颜色，两边都不会漏。
 *
 * 关键约定：
 * - **只读 seeds，绝不回读 themes.json。** 早期版本拿 themes.json 当输入，
 *   重复运行会把 material-rose-light 再拆一遍变成 material-rose-light-light，
 *   还会覆盖掉人工重校过的配色——是个地雷，现在从根上堵住了。
 * - seeds 里给了哪一半就用哪一半（原样保留，不做任何改动），缺的那一半才派生。
 *   12 族现在两半齐全，所以正常运行时这里只做校验，不改色。
 * - 对比度自动校正**只作用于派生出来的那一半**：手写值不达标应当由人决定，
 *   而不是被脚本悄悄改掉。
 *
 * 用法：
 *   node scripts/gen-themes.mjs          # 生成并写入 public/config/themes.json
 *   node scripts/gen-themes.mjs --check  # 不写文件：结构/对比度体检 + 与 themes.json 比对漂移
 *                                          # （改了 seeds 却忘了重新生成，--check 会失败）
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEEDS_PATH = resolve(__dirname, '../public/config/theme-seeds.json');
const THEMES_PATH = resolve(__dirname, '../public/config/themes.json');
const VARIABLES_PATH = resolve(__dirname, '../src/styles/variables.scss');

// ==================== 颜色工具 ====================

function hexToRgb(hex) {
    const value = hex.replace('#', '').trim();
    const full = value.length === 3
        ? value.split('').map((c) => c + c).join('')
        : value;
    return {
        r: parseInt(full.slice(0, 2), 16),
        g: parseInt(full.slice(2, 4), 16),
        b: parseInt(full.slice(4, 6), 16),
    };
}

function rgbToHex({ r, g, b }) {
    const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));
    return `#${[r, g, b].map((n) => clamp(n).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/** RGB → HSL（h: 0-360, s/l: 0-100） */
function rgbToHsl({ r, g, b }) {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    const d = max - min;
    if (d === 0) {
        return { h: 0, s: 0, l: l * 100 };
    }
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    switch (max) {
        case rn:
            h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
            break;
        case gn:
            h = ((bn - rn) / d + 2) / 6;
            break;
        default:
            h = ((rn - gn) / d + 4) / 6;
    }
    return { h: h * 360, s: s * 100, l: l * 100 };
}

/** HSL → HEX */
function hslToHex(h, s, l) {
    const hn = ((h % 360) + 360) % 360;
    const sn = Math.max(0, Math.min(100, s)) / 100;
    const ln = Math.max(0, Math.min(100, l)) / 100;

    if (sn === 0) {
        const v = Math.round(ln * 255);
        return rgbToHex({ r: v, g: v, b: v });
    }

    const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn;
    const p = 2 * ln - q;
    const toChannel = (t) => {
        let tn = t;
        if (tn < 0) tn += 1;
        if (tn > 1) tn -= 1;
        if (tn < 1 / 6) return p + (q - p) * 6 * tn;
        if (tn < 1 / 2) return q;
        if (tn < 2 / 3) return p + (q - p) * (2 / 3 - tn) * 6;
        return p;
    };
    return rgbToHex({
        r: toChannel(hn / 360 + 1 / 3) * 255,
        g: toChannel(hn / 360) * 255,
        b: toChannel(hn / 360 - 1 / 3) * 255,
    });
}

function hexToHsl(hex) {
    return rgbToHsl(hexToRgb(hex));
}

/** 相对亮度（WCAG 2.1） */
function luminance(hex) {
    const { r, g, b } = hexToRgb(hex);
    const channel = (v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** 对比度（1-21） */
function contrast(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    const light = Math.max(la, lb);
    const dark = Math.min(la, lb);
    return (light + 0.05) / (dark + 0.05);
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/**
 * 提升色相饱和度下限：像 #8B0000 这种"深红"的 s 很高但 l 很低，
 * 直接搬过来做深色 primary 会偏灰，这里按明度补一点饱和度。
 */
function boostSat(sat, min) {
    return clamp(Math.max(sat, min), 0, 95);
}

// ==================== 派生逻辑 ====================

/**
 * 由亮色调色板派生深色调色板
 * 色相取自亮色 primary，表面色用该色相做极低明度染色，避免纯灰死板。
 */
function deriveDark(light) {
    const p = hexToHsl(light['--md-sys-color-primary']);
    const s = hexToHsl(light['--md-sys-color-secondary']);
    const t = hexToHsl(light['--md-sys-color-tertiary']);
    const hue = p.h;
    const sat = boostSat(p.s, 45);
    const secHue = s.s < 8 ? hue + 30 : s.h;
    const secSat = s.s < 8 ? 12 : boostSat(s.s, 18);
    const terHue = t.h;
    const terSat = boostSat(t.s, 30);

    return {
        '--md-sys-color-primary': hslToHex(hue, sat * 0.82, 74),
        '--md-sys-color-on-primary': hslToHex(hue, sat * 0.6, 18),
        '--md-sys-color-primary-container': hslToHex(hue, sat * 0.62, 27),
        '--md-sys-color-on-primary-container': hslToHex(hue, sat * 0.55, 89),
        '--md-sys-color-secondary': hslToHex(secHue, secSat * 0.75, 72),
        '--md-sys-color-on-secondary': hslToHex(secHue, secSat * 0.6, 18),
        '--md-sys-color-secondary-container': hslToHex(secHue, secSat * 0.7, 29),
        '--md-sys-color-on-secondary-container': hslToHex(secHue, secSat * 0.6, 88),
        '--md-sys-color-tertiary': hslToHex(terHue, terSat * 0.75, 73),
        '--md-sys-color-on-tertiary': hslToHex(terHue, terSat * 0.6, 18),
        '--md-sys-color-tertiary-container': hslToHex(terHue, terSat * 0.6, 29),
        '--md-sys-color-on-tertiary-container': hslToHex(terHue, terSat * 0.55, 89),
        '--md-sys-color-surface': hslToHex(hue, clamp(sat * 0.16, 4, 14), 10.5),
        '--md-sys-color-surface-variant': hslToHex(hue, clamp(sat * 0.14, 4, 12), 18),
        '--md-sys-color-on-surface': hslToHex(hue, clamp(sat * 0.12, 3, 10), 93),
        '--md-sys-color-on-surface-variant': hslToHex(hue, clamp(sat * 0.1, 3, 8), 72),
        '--md-sys-color-background': hslToHex(hue, clamp(sat * 0.16, 4, 14), 8),
        '--md-sys-color-on-background': hslToHex(hue, clamp(sat * 0.12, 3, 10), 93),
        '--md-sys-color-outline': hslToHex(hue, clamp(sat * 0.12, 4, 10), 40),
        '--md-sys-color-error': '#EF5350',
        '--md-sys-color-success': '#66BB6A',
        '--md-sys-color-inverse-surface': hslToHex(hue, clamp(sat * 0.12, 3, 10), 93),
        '--md-sys-color-inverse-on-surface': hslToHex(hue, clamp(sat * 0.14, 4, 12), 18),
    };
}

/**
 * 由深色调色板派生亮色调色板
 * 深色主题的 primary 通常是"提亮过的"色相，直接压暗即可得到同族亮色 primary。
 */
function deriveLight(dark) {
    const p = hexToHsl(dark['--md-sys-color-primary']);
    const s = hexToHsl(dark['--md-sys-color-secondary']);
    const t = hexToHsl(dark['--md-sys-color-tertiary']);
    const hue = p.h;
    const sat = boostSat(p.s, 42);
    const secHue = s.s < 8 ? hue + 30 : s.h;
    const secSat = s.s < 8 ? 14 : boostSat(s.s, 20);
    const terHue = t.h;
    const terSat = boostSat(t.s, 32);

    const surface = hslToHex(hue, clamp(sat * 0.4, 8, 30), 98);

    return {
        '--md-sys-color-primary': hslToHex(hue, sat, 40),
        '--md-sys-color-on-primary': '#FFFFFF',
        '--md-sys-color-primary-container': hslToHex(hue, sat * 0.75, 92),
        '--md-sys-color-on-primary-container': hslToHex(hue, sat, 22),
        '--md-sys-color-secondary': hslToHex(secHue, secSat, 42),
        '--md-sys-color-on-secondary': '#FFFFFF',
        '--md-sys-color-secondary-container': hslToHex(secHue, secSat * 0.6, 91),
        '--md-sys-color-on-secondary-container': hslToHex(secHue, secSat, 21),
        '--md-sys-color-tertiary': hslToHex(terHue, terSat, 42),
        '--md-sys-color-on-tertiary': '#FFFFFF',
        '--md-sys-color-tertiary-container': hslToHex(terHue, terSat * 0.55, 91),
        '--md-sys-color-on-tertiary-container': hslToHex(terHue, terSat, 21),
        '--md-sys-color-surface': surface,
        '--md-sys-color-surface-variant': hslToHex(hue, clamp(sat * 0.3, 6, 24), 93),
        '--md-sys-color-on-surface': hslToHex(hue, clamp(sat * 0.2, 4, 16), 11),
        '--md-sys-color-on-surface-variant': hslToHex(hue, clamp(sat * 0.16, 4, 14), 34),
        '--md-sys-color-background': surface,
        '--md-sys-color-on-background': hslToHex(hue, clamp(sat * 0.2, 4, 16), 11),
        '--md-sys-color-outline': hslToHex(hue, clamp(sat * 0.16, 4, 12), 55),
        '--md-sys-color-error': '#BA1A1A',
        '--md-sys-color-success': '#376B2F',
        '--md-sys-color-inverse-surface': hslToHex(hue, clamp(sat * 0.2, 4, 16), 11),
        '--md-sys-color-inverse-on-surface': hslToHex(hue, clamp(sat * 0.3, 6, 24), 93),
    };
}

/**
 * 把 primary 的对比度提到可用阈值。
 *
 * 有几套老主题的 primary 是"高饱和高明度"色（琥珀 #FFC107、薄荷绿等），
 * 直接压在浅色表面上只有 2.0 左右对比度，而 primary 在这个项目里被当成
 * 标题色 / 强调文字色用（.content-title、侧栏选中项），实际是看不清的。
 *
 * 这里只沿明度轴微调（亮色主题压暗、深色主题提亮），色相与饱和度不动，
 * 保证主题的"性格"不变；达到阈值即停，不会过度调整。
 */
function ensurePrimaryContrast(colors, mode, minContrast = 3.2) {
    const surface = colors['--md-sys-color-surface'];
    const original = colors['--md-sys-color-primary'];
    const hsl = hexToHsl(original);
    let l = hsl.l;
    let hex = original;

    for (let step = 0; step < 40; step += 1) {
        if (contrast(hex, surface) >= minContrast) break;
        l += mode === 'light' ? -1 : 1;
        if (l <= 8 || l >= 94) break;
        hex = hslToHex(hsl.h, hsl.s, l);
    }

    if (hex === original) return null;

    colors['--md-sys-color-primary'] = hex;
    // on-primary 必须跟着新 primary 走，否则按钮文字会糊在一起
    const white = '#FFFFFF';
    const dark = hslToHex(hsl.h, clamp(hsl.s, 20, 60), 12);
    colors['--md-sys-color-on-primary'] =
        contrast(hex, white) >= contrast(hex, dark) ? white : dark;

    return { from: original, to: hex, contrast: contrast(hex, surface) };
}

// ==================== 调色板契约 ====================

/** 与调色板字段顺序保持一致，diff 更可读 */
const TOKEN_ORDER = [
    '--md-sys-color-primary',
    '--md-sys-color-on-primary',
    '--md-sys-color-primary-container',
    '--md-sys-color-on-primary-container',
    '--md-sys-color-secondary',
    '--md-sys-color-on-secondary',
    '--md-sys-color-secondary-container',
    '--md-sys-color-on-secondary-container',
    '--md-sys-color-tertiary',
    '--md-sys-color-on-tertiary',
    '--md-sys-color-tertiary-container',
    '--md-sys-color-on-tertiary-container',
    '--md-sys-color-surface',
    '--md-sys-color-surface-variant',
    '--md-sys-color-on-surface',
    '--md-sys-color-on-surface-variant',
    '--md-sys-color-background',
    '--md-sys-color-on-background',
    '--md-sys-color-outline',
    '--md-sys-color-error',
    '--md-sys-color-success',
    '--md-sys-color-inverse-surface',
    '--md-sys-color-inverse-on-surface',
];

function orderColors(colors) {
    const ordered = {};
    for (const key of TOKEN_ORDER) {
        if (colors[key]) ordered[key] = colors[key];
    }
    for (const [key, value] of Object.entries(colors)) {
        if (!(key in ordered)) ordered[key] = value;
    }
    return ordered;
}

const HEX_RE = /^#[\da-f]{6}$/i;

/**
 * 阈值比 WCAG 的「正文 4.5 / 大字 3」松一档，因为这套主题始终浮在壁纸上：
 * 表面本身是半透明的（--glass-bg 只混了 78% surface），字还要和壁纸抢注意力。
 * 按足本卡会把所有浅色主题判死；按这里的线仍然能保证纯色模式下看得清。
 */
const THRESHOLDS = {
    body: 7,
    secondaryText: 4.5,
    primary: 3.0,
    onSolid: 3.0,
};

/** [前景 token, 背景 token, 阈值键, 报告用名称] */
const CONTRAST_PAIRS = [
    ['--md-sys-color-on-surface', '--md-sys-color-surface', 'body', '正文/表面'],
    ['--md-sys-color-on-background', '--md-sys-color-background', 'body', '正文/背景'],
    ['--md-sys-color-on-surface-variant', '--md-sys-color-surface', 'secondaryText', '次级文字/表面'],
    ['--md-sys-color-primary', '--md-sys-color-surface', 'primary', 'primary/表面'],
    ['--md-sys-color-on-primary', '--md-sys-color-primary', 'onSolid', '按钮文字/primary'],
    ['--md-sys-color-on-primary-container', '--md-sys-color-primary-container', 'secondaryText', 'on-primary-container/容器'],
    ['--md-sys-color-error', '--md-sys-color-surface', 'secondaryText', 'error/表面'],
    ['--md-sys-color-success', '--md-sys-color-surface', 'secondaryText', 'success/表面'],
];

/**
 * 校验一套调色板：token 是否齐全合法、对比度是否达标。
 * 结构有问题时不再算对比度——色值本身不可信，算出来的数字只会误导。
 */
function auditPalette(colors) {
    const structural = [];

    for (const key of TOKEN_ORDER) {
        if (!colors[key]) {
            structural.push(`缺少 ${key}`);
        } else if (!HEX_RE.test(colors[key])) {
            structural.push(`${key} 不是 #RRGGBB：${colors[key]}`);
        }
    }
    for (const key of Object.keys(colors)) {
        if (!TOKEN_ORDER.includes(key)) {
            structural.push(`多余的 ${key}`);
        }
    }

    const contrastIssues = [];
    if (structural.length === 0) {
        for (const [fg, bg, minKey, label] of CONTRAST_PAIRS) {
            const ratio = contrast(colors[fg], colors[bg]);
            const min = THRESHOLDS[minKey];
            if (ratio < min) {
                contrastIssues.push({ label, ratio, min });
            }
        }
    }

    return { structural, contrast: contrastIssues };
}

// ==================== 生成 ====================

const checkOnly = process.argv.includes('--check');

if (!existsSync(SEEDS_PATH)) {
    console.error(`找不到 seeds 文件：${SEEDS_PATH}`);
    process.exit(1);
}

const seeds = JSON.parse(readFileSync(SEEDS_PATH, 'utf8'));
if (!Array.isArray(seeds.families) || seeds.families.length === 0) {
    console.error(`${SEEDS_PATH} 的 families 为空或格式不对。`);
    process.exit(1);
}

const themes = [];
const legacyIds = {};
const report = [];
const corrections = [];
const structuralIssues = [];
const contrastIssues = [];

for (const family of seeds.families) {
    const seededLight = family.palettes?.light;
    const seededDark = family.palettes?.dark;

    if (!seededLight && !seededDark) {
        structuralIssues.push({ who: family.id, detail: '明暗两半都没写，无从派生' });
        continue;
    }

    // 手写的那一半原样使用，缺的那一半才派生
    const lightColors = seededLight ? { ...seededLight } : deriveLight(seededDark);
    const darkColors = seededDark ? { ...seededDark } : deriveDark(lightColors);

    const derived = { light: !seededLight, dark: !seededDark };

    // 校正只作用于派生半，理由见文件头
    for (const mode of ['light', 'dark']) {
        if (!derived[mode]) continue;
        const fix = ensurePrimaryContrast(
            mode === 'light' ? lightColors : darkColors,
            mode,
        );
        if (fix) {
            corrections.push({ family: family.id, name: family.name, [mode]: fix });
        }
    }

    for (const [mode, colors] of [['light', lightColors], ['dark', darkColors]]) {
        const audit = auditPalette(colors);
        for (const detail of audit.structural) {
            structuralIssues.push({ who: `${family.id} (${mode})`, detail });
        }
        for (const issue of audit.contrast) {
            contrastIssues.push({
                who: `${family.id} (${mode}) ${derived[mode] ? '[派生]' : '[手写]'}`,
                ...issue,
            });
        }
        report.push({ family: family.id, mode, derived: derived[mode], colors });
    }

    const lightId = `${family.id}-light`;
    const darkId = `${family.id}-dark`;

    // 旧主题 ID 指向它原本所在的那一半，老用户升级后配色不变
    legacyIds[family.id] = family.legacy === 'dark' ? darkId : lightId;

    for (const [mode, id, colors] of [
        ['light', lightId, lightColors],
        ['dark', darkId, darkColors],
    ]) {
        themes.push({
            id,
            family: family.id,
            mode,
            isDark: mode === 'dark',
            name: family.name,
            description: family.description,
            logo: family.logo,
            colors: orderColors(colors),
        });
    }
}

// 默认主题来自 seeds，运行时再按系统偏好挑同一族的另一半
const defaultFamily = seeds.families.find((f) => f.id === seeds.defaultFamily)?.id
    ?? seeds.families[0].id;
const defaultMode = seeds.defaultMode === 'dark' ? 'dark' : 'light';

const output = {
    defaultTheme: `${defaultFamily}-${defaultMode}`,
    legacyIds,
    themes,
};

/**
 * variables.scss 的 :root 是「主题预加载生效之前」的兜底配色，必须等于 defaultTheme。
 * 这里曾经残留着早已废弃的玫瑰色（#B14A6B），而默认主题早就换成了墨魂银骨 ——
 * 预加载失败的那一帧就会闪出一套不属于任何主题的配色，肉眼 review 根本发现不了。
 */
function checkScssFallback() {
    const defaultTheme = themes.find((t) => t.id === output.defaultTheme);
    if (!defaultTheme || !existsSync(VARIABLES_PATH)) {
        return ['找不到 src/styles/variables.scss 或默认主题'];
    }
    const source = readFileSync(VARIABLES_PATH, 'utf8');
    const problems = [];
    for (const [token, expected] of Object.entries(defaultTheme.colors)) {
        const pattern = new RegExp(`${token.replace(/-/g, '\\-')}\\s*:\\s*(#[0-9a-fA-F]{3,8})\\s*;`);
        const matched = source.match(pattern);
        if (!matched) {
            problems.push(`${token}：:root 里没有兜底值`);
        } else if (matched[1].toUpperCase() !== expected.toUpperCase()) {
            problems.push(`${token}：兜底值 ${matched[1]} ≠ 默认主题 ${expected}`);
        }
    }
    return problems;
}

const fallbackProblems = checkScssFallback();
if (fallbackProblems.length > 0) {
    console.log(`\nvariables.scss 兜底色与默认主题不一致 ${fallbackProblems.length} 项：`);
    for (const problem of fallbackProblems) {
        console.log(`  ${problem}`);
    }
}

// ==================== 体检报告 ====================

const ratio = (v) => v.toFixed(2).padStart(7);
let failed = 0;

console.log('主题变体                          | 来源 | 正文 | 次级 | primary | on-primary');
console.log('----------------------------------|------|------|------|---------|-----------');
for (const item of report) {
    const c = item.colors;
    const surface = c['--md-sys-color-surface'];
    const body = contrast(c['--md-sys-color-on-surface'], surface);
    const muted = contrast(c['--md-sys-color-on-surface-variant'], surface);
    const primary = contrast(c['--md-sys-color-primary'], surface);
    const onPrimary = contrast(c['--md-sys-color-on-primary'], c['--md-sys-color-primary']);
    const ok = body >= THRESHOLDS.body
        && muted >= THRESHOLDS.secondaryText
        && primary >= THRESHOLDS.primary
        && onPrimary >= THRESHOLDS.onSolid;
    if (!ok) failed += 1;
    console.log(
        `${`${item.family} (${item.mode})`.padEnd(34)} | ${(item.derived ? '派生' : '手写').padEnd(4)} | `
        + `${ratio(body)} | ${ratio(muted)} | ${ratio(primary)} | ${ratio(onPrimary)}${ok ? '' : '  ✗'}`,
    );
}

if (corrections.length > 0) {
    console.log('\n派生半的对比度校正（只沿明度轴走，色相与饱和度不变）：');
    for (const item of corrections) {
        for (const mode of ['light', 'dark']) {
            const fix = item[mode];
            if (!fix) continue;
            console.log(`  ${item.family} (${mode}): ${fix.from} → ${fix.to}（${fix.contrast.toFixed(2)}）`);
        }
    }
}

if (structuralIssues.length > 0) {
    console.log(`\n结构问题 ${structuralIssues.length} 项：`);
    for (const issue of structuralIssues) {
        console.log(`  ${issue.who}: ${issue.detail}`);
    }
}

if (contrastIssues.length > 0) {
    console.log(`\n对比度未达标 ${contrastIssues.length} 项（阈值见 THRESHOLDS）：`);
    for (const issue of contrastIssues) {
        console.log(`  ${issue.who.padEnd(36)} ${issue.label.padEnd(24)} ${issue.ratio.toFixed(2)} < ${issue.min}`);
    }
}

const hasIssues = failed > 0 || structuralIssues.length > 0;
const serialized = `${JSON.stringify(output, null, 4)}\n`;

if (checkOnly) {
    if (hasIssues) {
        console.log('\n✗ 体检未通过。');
        process.exit(1);
    }
    if (!existsSync(THEMES_PATH)) {
        console.error('\n✗ public/config/themes.json 不存在，请运行 node scripts/gen-themes.mjs');
        process.exit(1);
    }
    if (readFileSync(THEMES_PATH, 'utf8') !== serialized) {
        console.log('\n✗ themes.json 与 seeds 不一致（改过 seeds 却没重新生成）。');
        process.exit(1);
    }
    if (fallbackProblems.length > 0) {
        console.log('\n✗ variables.scss 的兜底色没跟上默认主题。');
        process.exit(1);
    }
    console.log(`\n✓ themes.json 与 seeds 一致，${report.length} 个变体全部达标。`);
    process.exit(0);
}

if (hasIssues) {
    console.log('\n✗ 存在结构或对比度问题，未写入 themes.json。');
    process.exit(1);
}

writeFileSync(THEMES_PATH, serialized, 'utf8');
console.log(`\n已写入 ${THEMES_PATH}`);
console.log(`主题族 ${seeds.families.length} 个，变体 ${themes.length} 个，默认 ${output.defaultTheme}`);
