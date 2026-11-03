/**
 * 颜色处理工具
 * 与原项目 js/ThemeManager.js 中 adjustColor、hexToRgba 行为一致
 */

/** 调整 HEX 颜色亮度（正数变亮，负数变暗） */
export function adjustColor(color: string, percent: number): string {
    const num = parseInt(color.replace('#', ''), 16);
    const amt = Math.round(2.55 * Math.abs(percent));
    const R = percent > 0
        ? Math.min(255, (num >> 16) + amt)
        : Math.max(0, (num >> 16) - amt);
    const G = percent > 0
        ? Math.min(255, ((num >> 8) & 0x00FF) + amt)
        : Math.max(0, ((num >> 8) & 0x00FF) - amt);
    const B = percent > 0
        ? Math.min(255, (num & 0x0000FF) + amt)
        : Math.max(0, (num & 0x0000FF) - amt);
    return `#${((1 << 24) + (R << 16) + (G << 8) + B).toString(16).slice(1)}`;
}

/** HEX 颜色转 RGBA */
export function hexToRgba(hex: string, alpha: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * HEX 颜色转 `r, g, b` 三元组
 * 供 `rgba(var(--md-sys-color-surface-rgb), 0.9)` 这类需要动态 alpha 的场景使用。
 */
export function hexToRgbTriplet(hex: string): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `${r}, ${g}, ${b}`;
}

/** 判断颜色是否为浅色系（用于文字颜色反色判断） */
export function isLightColor(hex: string): boolean {
    const num = parseInt(hex.replace('#', ''), 16);
    const r = (num >> 16) & 0xFF;
    const g = (num >> 8) & 0xFF;
    const b = num & 0xFF;
    // 基于感知亮度公式
    const brightness = (r * 299 + g * 587 + b * 114) / 1000;
    return brightness > 128;
}

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
