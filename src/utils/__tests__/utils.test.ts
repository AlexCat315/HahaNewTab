import { describe, it, expect, vi } from 'vitest';
import {
    generateId,
    generateAppId,
    generateCategoryId,
    generateUiCategoryId,
    generateUiItemId
} from '../id.util';
import { escapeHtml, escapeAttr } from '../escape.util';
import {
    isImageIcon,
    createImageWithFallback,
    createMonochromeImage,
    analyzeIconInk,
    resolveBackdropLuminance,
    shouldPlateIcon,
    iconPlateColor
} from '../image.util';
import {
    adjustColor,
    hexToRgba,
    channelLuminance,
    contrastRatio,
    parseCssColor
} from '../color.util';
import { debounce, throttle } from '../debounce.util';
import { formatFileSize, validateFileSize } from '../file.util';

describe('id.util', () => {
    it('应生成非空唯一 ID', () => {
        const id = generateId();
        expect(id).toBeTruthy();
        expect(id).not.toBe(generateId());
    });

    it('应生成带正确前缀的 ID', () => {
        expect(generateAppId()).toMatch(/^app_/);
        expect(generateCategoryId()).toMatch(/^cat_/);
        expect(generateUiCategoryId()).toMatch(/^uicat_/);
        expect(generateUiItemId()).toMatch(/^uiitem_/);
    });
});

describe('escape.util', () => {
    it('应转义 HTML 特殊字符', () => {
        expect(escapeHtml('<script>alert("xss")</script>')).toBe(
            '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
        );
    });

    it('应处理 null 与 undefined', () => {
        expect(escapeHtml(null)).toBe('');
        expect(escapeHtml(undefined)).toBe('');
    });

    it('应转义属性中的反引号', () => {
        expect(escapeAttr('`onclick`')).toContain('&#96;');
    });
});

describe('image.util', () => {
    it('应识别图片图标', () => {
        expect(isImageIcon('https://example.com/icon.png')).toBe(true);
        expect(isImageIcon('./image/icons/menu.svg')).toBe(true);
        expect(isImageIcon('data:image/svg+xml;base64,xxx')).toBe(true);
        expect(isImageIcon('rocket')).toBe(false);
    });

    it('生成带回退的图片标签不应包含 emoji', () => {
        const html = createImageWithFallback('test.png', '测试');
        expect(html).toContain('src="test.png"');
        expect(html).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);
    });

    it('生成单色图片标签应包含样式', () => {
        const html = createMonochromeImage('test.svg', '测试', 'filter: invert(1)');
        expect(html).toContain('filter: invert(1)');
    });

    it('无 2d 画布时墨色采样返回 null，不猜测图标颜色', () => {
        const img = { naturalWidth: 32, naturalHeight: 32 } as unknown as HTMLImageElement;
        expect(analyzeIconInk(img)).toBeNull();
        expect(analyzeIconInk(null)).toBeNull();
    });

    it('找不到不透明背景时返回 null', () => {
        const outer = document.createElement('div');
        outer.style.backgroundColor = 'rgb(20, 20, 22)';
        const inner = document.createElement('div');
        // 半透明的一层不算「底」，真正的背景在它下面
        inner.style.backgroundColor = 'rgba(0, 0, 0, 0.4)';
        outer.appendChild(inner);
        document.body.appendChild(outer);
        expect(resolveBackdropLuminance(inner)).toBe(channelLuminance(20, 20, 22));
        outer.remove();
        expect(resolveBackdropLuminance(document.createElement('div'))).toBeNull();
        expect(resolveBackdropLuminance(null)).toBeNull();
    });

    it('透明底深色 logo 撞上深色背景时垫浅色底', () => {
        // GitHub 章鱼猫（近黑）落在深海/银灰深色的 primary-container 上
        const ink = { inkLuminance: 0, transparentRatio: 0.8, darkShare: 1, lightShare: 0 };
        expect(shouldPlateIcon(ink, channelLuminance(71, 73, 82))).toBe('light');
    });

    it('透明底浅色 logo 撞上浅色背景时垫深色底', () => {
        const ink = { inkLuminance: 1, transparentRatio: 0.8, darkShare: 0, lightShare: 1 };
        expect(shouldPlateIcon(ink, channelLuminance(251, 251, 251))).toBe('dark');
    });

    it('彩色 logo 均值再接近背景也不垫底，避免糊掉品牌色', () => {
        // 红黄混色的 logo：均值亮度落在「看不清」区间，但没有哪一端占主导
        const ink = { inkLuminance: 0.3, transparentRatio: 0.8, darkShare: 0.2, lightShare: 0.1 };
        expect(shouldPlateIcon(ink, channelLuminance(71, 73, 82))).toBeNull();
    });

    it('已经看得清、或自带不透明背景时不干预', () => {
        const darkInk = { inkLuminance: 0, transparentRatio: 0.8, darkShare: 1, lightShare: 0 };
        // 黑墨落在白底上：对比度足够，不加底
        expect(shouldPlateIcon(darkInk, 1)).toBeNull();
        // 截图 / 方形 app 图标：几乎没有透明像素，本身就带背景
        expect(
            shouldPlateIcon({ inkLuminance: 0, transparentRatio: 0.05, darkShare: 1, lightShare: 0 }, 0)
        ).toBeNull();
        // 判定依据缺失时一律不干预
        expect(shouldPlateIcon(null, 0)).toBeNull();
        expect(shouldPlateIcon(darkInk, null)).toBeNull();
    });

    it('底板颜色与判定结果对应', () => {
        expect(iconPlateColor('light')).toBe('#ffffff');
        expect(iconPlateColor('dark')).toBe('#141416');
    });
});

describe('color.util', () => {
    it('应正确调整颜色亮度', () => {
        expect(adjustColor('#000000', 100)).toBe('#ffffff');
        expect(adjustColor('#ffffff', -100)).toBe('#000000');
    });

    it('应正确转换 HEX 到 RGBA', () => {
        expect(hexToRgba('#ff0000', 0.5)).toBe('rgba(255, 0, 0, 0.5)');
    });

    it('相对亮度与对比度符合 WCAG', () => {
        expect(channelLuminance(255, 255, 255)).toBeCloseTo(1, 4);
        expect(channelLuminance(0, 0, 0)).toBe(0);
        expect(contrastRatio(1, 0)).toBeCloseTo(21, 1);
        expect(contrastRatio(0.5, 0.5)).toBeCloseTo(1, 4);
        // 对比度不分方向
        expect(contrastRatio(1, 0.2)).toBeCloseTo(contrastRatio(0.2, 1), 6);
    });

    it('能同时吃主题令牌和 getComputedStyle 的颜色', () => {
        expect(parseCssColor('#474952')).toEqual({ r: 71, g: 73, b: 82, a: 1 });
        expect(parseCssColor('#abc')).toEqual({ r: 170, g: 187, b: 204, a: 1 });
        expect(parseCssColor('rgba(20, 20, 22, 0.4)')).toEqual({ r: 20, g: 20, b: 22, a: 0.4 });
        expect(parseCssColor('rgb(1, 2, 3)')).toEqual({ r: 1, g: 2, b: 3, a: 1 });
        expect(parseCssColor('transparent')).toBeNull();
        expect(parseCssColor('')).toBeNull();
    });
});

describe('debounce.util', () => {
    it('防抖应延迟执行', () => {
        vi.useFakeTimers();
        const fn = vi.fn();
        const debounced = debounce(fn, 100);
        debounced();
        debounced();
        debounced();
        expect(fn).not.toHaveBeenCalled();
        vi.advanceTimersByTime(100);
        expect(fn).toHaveBeenCalledTimes(1);
        vi.useRealTimers();
    });

    it('节流应在限制内只执行一次', () => {
        vi.useFakeTimers();
        const fn = vi.fn();
        const throttled = throttle(fn, 100);
        throttled();
        throttled();
        throttled();
        expect(fn).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(100);
        throttled();
        expect(fn).toHaveBeenCalledTimes(2);
        vi.useRealTimers();
    });
});

describe('file.util', () => {
    it('应格式化文件大小', () => {
        expect(formatFileSize(0)).toBe('0 B');
        expect(formatFileSize(1024)).toBe('1.00 KB');
        expect(formatFileSize(5 * 1024 * 1024)).toBe('5.00 MB');
    });

    it('应校验文件大小', () => {
        const file = new File(['a'], 'test.txt', { type: 'text/plain' });
        expect(validateFileSize(file, 10)).toBe(true);
        expect(validateFileSize(file, 0)).toBe(false);
    });
});
