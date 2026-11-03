/**
 * 图片加载与图标识别工具
 * 与原项目 js/app.js 中 Utils.createImageWithFallback、Utils.isImageIcon 行为一致
 * 禁止使用 emoji 作为占位，统一使用 24x24 SVG 占位
 */

import { escapeAttr } from './escape.util';
import { channelLuminance, contrastRatio, parseCssColor } from './color.util';

/**
 * 默认图片占位 SVG（24x24）
 * 使用 Material Design 风格的图片图标
 */
export const DEFAULT_IMAGE_PLACEHOLDER =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cpath fill='%23999' d='M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z'/%3E%3C/svg%3E";

/** 系统图标基础路径 */
export const SYSTEM_ICON_BASE_PATH = '/image/icons/';

/** 判断给定字符串是否为图片图标 */
export function isImageIcon(icon?: string): boolean {
    if (!icon) {
        return false;
    }
    return (
        icon.startsWith('http') ||
        icon.startsWith('data:') ||
        icon.startsWith('//') ||
        icon.startsWith('./') ||
        icon.startsWith('/') ||
        icon.includes('.') ||
        /\.(svg|png|jpg|jpeg|gif|ico|webp)$/i.test(icon)
    );
}

/** 获取系统 SVG 图标 URL */
export function getSystemIconUrl(name: string): string {
    return `${SYSTEM_ICON_BASE_PATH}${name}.svg`;
}

/**
 * 创建带错误回退的图片 HTML 字符串
 * @param src 图片地址
 * @param alt 替代文本
 * @param fallback 加载失败时回退的图片地址（默认 SVG 占位）
 */
export function createImageWithFallback(
    src: string,
    alt: string,
    fallback = DEFAULT_IMAGE_PLACEHOLDER
): string {
    const safeSrc = escapeAttr(src);
    const safeAlt = escapeAttr(alt);
    const safeFallback = escapeAttr(fallback);
    return `<img src="${safeSrc}" alt="${safeAlt}" loading="lazy" decoding="async" onerror="this.onerror=null; this.src='${safeFallback}';">`;
}

/**
 * 创建支持黑白模式的图片 HTML 字符串
 * @param src 图片地址
 * @param alt 替代文本
 * @param style 行内样式
 * @param fallback 加载失败时回退的图片地址（默认 SVG 占位）
 */
export function createMonochromeImage(
    src: string,
    alt: string,
    style?: string,
    fallback = DEFAULT_IMAGE_PLACEHOLDER
): string {
    const safeSrc = escapeAttr(src);
    const safeAlt = escapeAttr(alt);
    const safeStyle = style ? escapeAttr(style) : '';
    const safeFallback = escapeAttr(fallback);
    const styleAttr = safeStyle ? ` style="${safeStyle}"` : '';
    return `<img src="${safeSrc}" alt="${safeAlt}" loading="lazy" decoding="async"${styleAttr} onerror="this.onerror=null; this.src='${safeFallback}';">`;
}

/** 创建 24x24 SVG 占位图标（用于无法使用系统图标时） */
export function createPlaceholderSvg(fill = '#999'): string {
    return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cpath fill='${encodeURIComponent(fill)}' d='M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z'/%3E%3C/svg%3E`;
}

// ==================== 图标可见性自适应 ====================

/**
 * 图标「墨色」采样结果
 *
 * 只有透明底的品牌图形（GitHub 章鱼猫、纯色描边 logo）才会有可读的墨色，
 * 自带背景的方形 app 图标 alpha 全是 1，采样到的透明比例接近 0，直接放行。
 */
export interface IconInkProfile {
    /** 按 alpha 加权的相对亮度（WCAG 0-1） */
    inkLuminance: number;
    /** 近乎透明的像素占比（0-1） */
    transparentRatio: number;
    /** 墨色里「接近纯黑」的占比（按 alpha 加权） */
    darkShare: number;
    /** 墨色里「接近纯白」的占比（按 alpha 加权） */
    lightShare: number;
}

/** 中性底板色相：只垫一层中性的黑/白，不改图标本身的颜色 */
export const ICON_PLATE_LIGHT = '#ffffff';
export const ICON_PLATE_DARK = '#141416';

export type IconPlateTone = 'light' | 'dark';

/** 采样边长：图标只有几十像素，放大到 32 足够定出平均墨色 */
const INK_SAMPLE_SIZE = 32;

/** alpha 低于此值算「这块像素是空的」 */
const INK_EMPTY_ALPHA = 32;

/** 透明像素低于这个比例，说明图标自带背景，永远看得见 */
const MIN_TRANSPARENT_RATIO = 0.35;

/** 墨色与背景的对比度低于此值才需要垫底板；2.5 大致是「勉强能认出形状」的下限 */
const MIN_INK_CONTRAST = 2.5;

/**
 * 单一极端色墨必须占到这个比例才垫底板
 *
 * 彩色 logo（红黄蓝混在一起）的均值亮度可能刚好落在「看不清」的区间，
 * 但它总有一部分是显眼的，垫底板只会把品牌色糊掉；
 * 只有近乎整枚图标都是同一端的极端色 —— 黑章鱼猫、白字标 —— 才真的需要垫。
 */
const MIN_DOMINANT_SHARE = 0.6;

/** 相对亮度低于此算「接近纯黑」，高于此算「接近纯白」 */
const DARK_INK_LUMINANCE = 0.15;
const LIGHT_INK_LUMINANCE = 0.85;

function hexLuminance(hex: string): number {
    const color = parseCssColor(hex);
    return color ? channelLuminance(color.r, color.g, color.b) : 0;
}

/**
 * 采样已加载图片的墨色与透明比例
 *
 * 读不到像素就返回 null（画布被跨域图片污染、jsdom 没有 2d 上下文、
 * SVG 没有固有尺寸等），调用方按「不干预」处理——宁可不修，也不能把本来好看的图标改丑。
 */
export function analyzeIconInk(img: HTMLImageElement | null): IconInkProfile | null {
    if (!img || typeof document === 'undefined') {
        return null;
    }
    if (!img.naturalWidth || !img.naturalHeight) {
        return null;
    }
    const canvas = document.createElement('canvas');
    canvas.width = INK_SAMPLE_SIZE;
    canvas.height = INK_SAMPLE_SIZE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
        return null;
    }
    ctx.clearRect(0, 0, INK_SAMPLE_SIZE, INK_SAMPLE_SIZE);
    ctx.drawImage(img, 0, 0, INK_SAMPLE_SIZE, INK_SAMPLE_SIZE);

    let pixels: Uint8ClampedArray;
    try {
        pixels = ctx.getImageData(0, 0, INK_SAMPLE_SIZE, INK_SAMPLE_SIZE).data;
    } catch {
        return null;
    }

    let alphaSum = 0;
    let luminanceSum = 0;
    let darkSum = 0;
    let lightSum = 0;
    let emptyCount = 0;
    const total = INK_SAMPLE_SIZE * INK_SAMPLE_SIZE;
    for (let i = 0; i < pixels.length; i += 4) {
        const alpha = pixels[i + 3];
        if (alpha < INK_EMPTY_ALPHA) {
            emptyCount += 1;
            continue;
        }
        const weight = alpha / 255;
        const luminance = channelLuminance(pixels[i], pixels[i + 1], pixels[i + 2]);
        alphaSum += weight;
        luminanceSum += weight * luminance;
        if (luminance < DARK_INK_LUMINANCE) {
            darkSum += weight;
        } else if (luminance > LIGHT_INK_LUMINANCE) {
            lightSum += weight;
        }
    }
    if (alphaSum <= 0) {
        return null;
    }
    return {
        inkLuminance: luminanceSum / alphaSum,
        transparentRatio: emptyCount / total,
        darkShare: darkSum / alphaSum,
        lightShare: lightSum / alphaSum,
    };
}

/**
 * 取元素实际落在的不透明背景亮度
 *
 * 从父级往上找第一层近乎不透明的 background-color：图标自己那一层是透明的，
 * 真正的底是外层的图标盘（如 .app-card__icon 的 primary-container）。
 * 找不到（全透明一路到根）返回 null，同样按「不干预」处理。
 */
export function resolveBackdropLuminance(from?: Element | null): number | null {
    if (!from || typeof window === 'undefined') {
        return null;
    }
    let node: Element | null = from;
    while (node) {
        const color = parseCssColor(window.getComputedStyle(node).backgroundColor);
        if (color && color.a >= 0.95) {
            return channelLuminance(color.r, color.g, color.b);
        }
        node = node.parentElement;
    }
    return null;
}

/**
 * 判断图标是否需要垫中性底板，以及垫深色还是浅色
 *
 * 解决的是「透明底 logo 撞上同色系背景」：深色模式里黑色 GitHub 章鱼猫、
 * 浅色模式里白色 logo，都不是靠反色能救的（反色会毁掉品牌配色）。
 * 所以只在墨色和背景糊在一起、且整枚图标都是同一端极端色时垫一层对比度更高的中性底，
 * 图标原色保持不变。返回 null 表示不干预。
 */
export function shouldPlateIcon(
    profile: IconInkProfile | null,
    backdropLuminance: number | null
): IconPlateTone | null {
    if (!profile || backdropLuminance === null) {
        return null;
    }
    if (profile.transparentRatio < MIN_TRANSPARENT_RATIO) {
        return null;
    }
    if (contrastRatio(profile.inkLuminance, backdropLuminance) >= MIN_INK_CONTRAST) {
        return null;
    }
    const lightPlate = hexLuminance(ICON_PLATE_LIGHT);
    const darkPlate = hexLuminance(ICON_PLATE_DARK);
    // 取和墨色对比度更高的那一侧当底
    const darkInk = contrastRatio(profile.inkLuminance, lightPlate)
        >= contrastRatio(profile.inkLuminance, darkPlate);
    if ((darkInk ? profile.darkShare : profile.lightShare) < MIN_DOMINANT_SHARE) {
        return null;
    }
    return darkInk ? 'light' : 'dark';
}

/** 底板色值 */
export function iconPlateColor(tone: IconPlateTone): string {
    return tone === 'light' ? ICON_PLATE_LIGHT : ICON_PLATE_DARK;
}
