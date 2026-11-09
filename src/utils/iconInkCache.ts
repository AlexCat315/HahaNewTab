/**
 * 图标墨色采样缓存与主题观察单例
 *
 * 以前每个 <IconSvg> 实例都在图片加载时新建 canvas、drawImage、getImageData，
 * 并且各自在 documentElement 上挂一个 MutationObserver：
 * 首屏 N 个图标 = N 次像素回读 + N 个观察者，主题切换再触发 N 次强制样式重算。
 *
 * 这里把两件事收成模块级共享：
 *   - 同一 src 的墨色只采样一次（跨实例、跨卡片复用），随缓存驱逐失效；
 *   - 一个观察者 + 订阅者集合，同一帧内的多次主题变更用 rAF 合并成一次重算。
 */

import { analyzeIconInk } from './image.util';
import type { IconInkProfile } from './image.util';

/** 缓存上限：新标签页卡片数量有限，超出后按插入顺序淘汰最旧的 */
const CACHE_LIMIT = 256;
const inkBySource = new Map<string, IconInkProfile | null>();

/** 取墨色；同一源只做一次像素分析 */
export function getIconInk(source: string, img: HTMLImageElement | null): IconInkProfile | null {
    if (inkBySource.has(source)) {
        return inkBySource.get(source) ?? null;
    }
    const profile = analyzeIconInk(img);
    if (inkBySource.size >= CACHE_LIMIT) {
        const oldest = inkBySource.keys().next().value;
        if (oldest !== undefined) inkBySource.delete(oldest);
    }
    inkBySource.set(source, profile);
    return profile;
}

/** 缓存内容损坏、重新走网络时让采样结论失效 */
export function evictIconInk(source: string): void {
    inkBySource.delete(source);
}

type PlateListener = () => void;

const listeners = new Set<PlateListener>();
let observer: MutationObserver | null = null;
let scheduled = false;

const schedule = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : (callback: () => void) => setTimeout(callback, 0);

function ensureObserver(): void {
    if (observer || typeof MutationObserver === 'undefined' || typeof document === 'undefined') {
        return;
    }
    observer = new MutationObserver(() => {
        if (scheduled) return;
        scheduled = true;
        schedule(() => {
            scheduled = false;
            for (const listener of [...listeners]) listener();
        });
    });
    observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'style']
    });
}

/** 订阅根节点主题变化；最后一个订阅者离开时断开唯一观察者 */
export function subscribeThemePlate(listener: PlateListener): () => void {
    listeners.add(listener);
    ensureObserver();
    return () => {
        listeners.delete(listener);
        if (!listeners.size) {
            observer?.disconnect();
            observer = null;
        }
    };
}
