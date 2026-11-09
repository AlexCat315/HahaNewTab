/**
 * 图标墨色缓存测试：同一 src 只做一次像素采样，驱逐后重新采样。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const profile = {
    inkLuminance: 0.1,
    transparentRatio: 0.6,
    darkShare: 1,
    lightShare: 0
};

vi.mock('@/utils/image.util', () => ({
    analyzeIconInk: vi.fn(() => profile)
}));

import { analyzeIconInk } from '@/utils/image.util';
import { evictIconInk, getIconInk, subscribeThemePlate } from '@/utils/iconInkCache';

const fakeImg = {} as HTMLImageElement;
const samples = vi.mocked(analyzeIconInk);

describe('iconInkCache', () => {
    beforeEach(() => {
        samples.mockClear();
        evictIconInk('icon-a');
        evictIconInk('icon-b');
    });

    it('同一源复用采样结果，不同源各自采样', () => {
        expect(getIconInk('icon-a', fakeImg)).toEqual(profile);
        expect(getIconInk('icon-a', fakeImg)).toEqual(profile);
        expect(getIconInk('icon-b', fakeImg)).toEqual(profile);
        expect(samples).toHaveBeenCalledTimes(2);
    });

    it('驱逐后重新采样', () => {
        getIconInk('icon-a', fakeImg);
        evictIconInk('icon-a');
        getIconInk('icon-a', fakeImg);
        expect(samples).toHaveBeenCalledTimes(2);
    });

    it('主题订阅可重复注册与退订，不抛错', () => {
        const first = subscribeThemePlate(() => undefined);
        const second = subscribeThemePlate(() => undefined);
        first();
        second();
        expect(true).toBe(true);
    });
});
