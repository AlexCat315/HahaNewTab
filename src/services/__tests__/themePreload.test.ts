/**
 * 首帧主题预加载脚本测试
 *
 * 它是 Vue 挂载前同步执行的独立 ES5 脚本，不进模块系统。
 * 这里用 ?raw 拿到源码、注入假的 window / document / localStorage 后同步执行，
 * 覆盖主题选择、跟随系统、快照版本回退与数据包缺失的降级。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import preloadSource from '../../../public/theme-preload.js?raw';

const BUNDLE = {
    contract: {
        boot: {
            key: '__boot__',
            version: 1,
            preload: {
                selectedThemeKey: 'selectedTheme',
                themeSettingsKey: 'appNavigator_themeSettings'
            }
        }
    },
    themes: {
        themes: [
            { id: 'rose-light', family: 'rose', mode: 'light', colors: { '--md-sys-color-primary': '#ff0000' } },
            { id: 'rose-dark', family: 'rose', mode: 'dark', colors: { '--md-sys-color-primary': '#aa0000' } },
            { id: 'blue-light', family: 'blue', mode: 'light', colors: { '--md-sys-color-primary': '#0000ff' } }
        ],
        legacyIds: { 'legacy-rose': 'rose-light' },
        defaultTheme: 'rose-light'
    }
};

interface RunOptions {
    bundle?: unknown;
    boot?: Record<string, unknown> | null;
    bootVersion?: number;
    prefersDark?: boolean;
    legacy?: Record<string, string>;
}

function runPreload(options: RunOptions = {}) {
    const attributes: Record<string, string> = { 'data-theme-loading': 'true' };
    const classes = new Set<string>();
    const css: Record<string, string> = {};
    const documentElement = {
        setAttribute: (key: string, value: string) => { attributes[key] = String(value); },
        removeAttribute: (key: string) => { delete attributes[key]; },
        classList: { add: (name: string) => classes.add(name) },
        style: { setProperty: (key: string, value: string) => { css[key] = value; } }
    };
    const fakeDocument = { documentElement, querySelector: () => null };
    const fakeWindow = {
        __HAHA_BOOT__: options.bundle === undefined ? BUNDLE : options.bundle,
        matchMedia: () => ({ matches: options.prefersDark ?? false })
    };

    localStorage.clear();
    if (options.boot !== null && options.boot !== undefined) {
        localStorage.setItem('__boot__', JSON.stringify({
            v: options.bootVersion ?? 1,
            data: options.boot
        }));
    }
    for (const [key, value] of Object.entries(options.legacy ?? {})) {
        localStorage.setItem(key, value);
    }

    new Function('window', 'localStorage', 'document', preloadSource)(
        fakeWindow, localStorage, fakeDocument
    );
    return { attributes, classes, css };
}

describe('theme-preload', () => {
    beforeEach(() => localStorage.clear());

    it('按快照注入选中主题的基础色并解除首帧隐藏', () => {
        const result = runPreload({ boot: { selectedTheme: 'blue-light' } });

        expect(result.attributes['data-theme']).toBe('blue-light');
        expect(result.css['--md-sys-color-primary']).toBe('#0000ff');
        expect(result.attributes['data-theme-loading']).toBeUndefined();
        expect(result.attributes['data-theme-loaded']).toBe('true');
    });

    it('跟随系统时按系统明暗取同族变体', () => {
        const result = runPreload({
            boot: {
                selectedTheme: 'rose-light',
                appNavigator_themeSettings: { followSystem: true, familyId: 'rose' }
            },
            prefersDark: true
        });

        expect(result.attributes['data-theme']).toBe('rose-dark');
        expect(result.classes.has('dark-mode')).toBe(true);
    });

    it('快照结构版本不符时退回逐键镜像，并认旧主题 id', () => {
        const result = runPreload({
            boot: { selectedTheme: 'rose-dark' },
            bootVersion: 99,
            legacy: { selectedTheme: JSON.stringify('legacy-rose') }
        });

        expect(result.attributes['data-theme']).toBe('rose-light');
    });

    it('数据包缺失时不崩、不猜键名，只解除首帧隐藏', () => {
        const result = runPreload({ bundle: null });

        expect(result.attributes['data-theme']).toBeUndefined();
        expect(result.attributes['data-theme-loading']).toBeUndefined();
        expect(result.attributes['data-theme-loaded']).toBe('true');
    });
});
