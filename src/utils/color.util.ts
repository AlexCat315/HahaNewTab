/**
 * 颜色处理工具
 *
 * 只保留「需要数值判断」的三件事：相对亮度、对比度、CSS 颜色字面量解析
 * （图标取样与背板判定用）。配色派生不在这里做——那是 styles/variables.scss
 * 里 color-mix 的职责，JS 再算一份就会出现同一含义两套值。
 */

/**
 * sRGB 相对亮度（WCAG 2.1），返回 0-1
 * 入参是 0-255 的通道值，图标采样和 CSS 颜色解析都用它。
 */
export function channelLuminance(r: number, g: number, b: number): number {
    const toLinear = (v: number) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** 两个相对亮度之间的 WCAG 对比度（1-21） */
export function contrastRatio(a: number, b: number): number {
    const lighter = Math.max(a, b);
    const darker = Math.min(a, b);
    return (lighter + 0.05) / (darker + 0.05);
}

/**
 * 解析 CSS 颜色字面量（`#hex` / `rgb()` / `rgba()`）
 * getComputedStyle 返回的是 `rgba(r, g, b, a)`，而主题令牌是 `#HEX`，两边都要能吃。
 * 解析不出来返回 null，调用方按「无法判定」处理。
 */
export function parseCssColor(value: string): { r: number; g: number; b: number; a: number } | null {
    const text = value.trim();
    if (!text) {
        return null;
    }
    const hex = text.match(/^#([\da-f]{3}|[\da-f]{6})$/i);
    if (hex) {
        const digits = hex[1].length === 3
            ? hex[1].split('').map((c) => c + c).join('')
            : hex[1];
        return {
            r: parseInt(digits.slice(0, 2), 16),
            g: parseInt(digits.slice(2, 4), 16),
            b: parseInt(digits.slice(4, 6), 16),
            a: 1,
        };
    }
    const rgb = text.match(/^rgba?\(([^)]+)\)$/i);
    if (rgb) {
        const parts = rgb[1].split(/[\s,/]+/).filter(Boolean).map((v) => parseFloat(v));
        if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) {
            return null;
        }
        return { r: parts[0], g: parts[1], b: parts[2], a: parts.length >= 4 ? parts[3] : 1 };
    }
    return null;
}
