/**
 * syncAssets.util 测试
 * 覆盖：data URL 换成资源引用与分片、同内容去重、非 Base64 形态不动、
 * 分片切分与还原、缺失分片时保留引用、清单文件名与清理判定。
 */
import { describe, it, expect, vi } from 'vitest';
import {
    ASSET_FILE_PREFIX,
    ASSET_REF_PREFIX,
    externalizeAssets,
    internalizeAssets,
    isAssetFileName,
    manifestFileNames
} from '@/utils/syncAssets.util';

/** 造一份指定长度的 Base64 正文 */
function makeDataUrl(base64: string, mime = 'image/png'): string {
    return `data:${mime};base64,${base64}`;
}

/** 由文件名取分片的替身 */
function readerFrom(chunks: Record<string, string>) {
    return async (name: string) => (name in chunks ? chunks[name] : null);
}

describe('externalizeAssets', () => {
    it('把站点图标换成引用，并登记 mime 与正文', async () => {
        const icon = makeDataUrl('AAAA');
        const payload = { apps: [{ id: 'a1', icon }] };

        const result = await externalizeAssets(payload, 1024);

        const ref = (result.data as typeof payload).apps[0].icon;
        expect(ref.startsWith(ASSET_REF_PREFIX)).toBe(true);
        const key = ref.slice(ASSET_REF_PREFIX.length);
        expect(result.manifest?.[key]).toEqual({ mime: 'image/png', bytes: 4, files: [`haha-asset-${key}-0.txt`] });
        expect(result.chunks[`haha-asset-${key}-0.txt`]).toBe('AAAA');
    });

    it('同一份内容重复出现只登记一次', async () => {
        const icon = makeDataUrl('QUJDRA');
        const payload = { apps: [{ icon }, { icon }, { icon: makeDataUrl('Q0M') }] };

        const result = await externalizeAssets(payload, 1024);

        expect(Object.keys(result.manifest ?? {})).toHaveLength(2);
        const refs = (result.data as { apps: Array<{ icon: string }> }).apps.map(app => app.icon);
        expect(refs[0]).toBe(refs[1]);
        expect(refs[0]).not.toBe(refs[2]);
    });

    it('正文长于分片上限时切成多个文件，序号从 0 开始', async () => {
        const base64 = 'A'.repeat(25);

        const result = await externalizeAssets({ icon: makeDataUrl(base64) }, 10);

        const ref = (result.data as { icon: string }).icon;
        const key = ref.slice(ASSET_REF_PREFIX.length);
        const entry = result.manifest?.[key];
        expect(entry?.files).toEqual([
            `haha-asset-${key}-0.txt`,
            `haha-asset-${key}-1.txt`,
            `haha-asset-${key}-2.txt`
        ]);
        expect(entry?.files.map(name => result.chunks[name].length)).toEqual([10, 10, 5]);
    });

    it('不碰非 Base64 形态的 data URL 与普通字符串', async () => {
        const payload = {
            svg: 'data:image/svg+xml,%3Csvg%3E%3C/svg%3E',
            url: 'https://example.com/a.png',
            empty: '',
            count: 3
        };

        const result = await externalizeAssets(payload, 1024);

        expect(result.data).toEqual(payload);
        expect(result.manifest).toBeUndefined();
        expect(result.chunks).toEqual({});
    });

    it('保留 null、数组与嵌套结构，只替换字符串叶子', async () => {
        const payload = { categories: [{ icon: null, items: [makeDataUrl('QQ')] }] };

        const result = await externalizeAssets(payload, 1024);

        const category = (result.data as typeof payload).categories[0];
        expect(category.icon).toBeNull();
        expect(String(category.items[0]).startsWith(ASSET_REF_PREFIX)).toBe(true);
    });
});

describe('internalizeAssets', () => {
    it('分片拼回原始 data URL，与 externalize 往返无损', async () => {
        const base64 = 'SGVsbG8tV29ybGQtQmFzZTY0LUNvbnRlbnQ';
        const icon = makeDataUrl(base64, 'image/jpeg');
        const payload = { apps: [{ id: 'a1', icon }] };

        const packed = await externalizeAssets(payload, 8);
        const restored = await internalizeAssets(packed.data, packed.manifest, readerFrom(packed.chunks));

        expect(restored).toEqual(payload);
    });

    it('分片取不到时保留引用字符串，不把整份数据判坏', async () => {
        const packed = await externalizeAssets({ icon: makeDataUrl('QUJDRA') }, 4);
        const ref = (packed.data as { icon: string }).icon;

        const restored = await internalizeAssets(packed.data, packed.manifest, async () => null);

        expect((restored as { icon: string }).icon).toBe(ref);
    });

    it('没有清单时原样返回，不发任何读取', async () => {
        const payload = { apps: [{ icon: makeDataUrl('QQ') }] };
        const readFile = vi.fn(async () => null);

        const restored = await internalizeAssets(payload, undefined, readFile);

        expect(restored).toEqual(payload);
        expect(readFile).not.toHaveBeenCalled();
    });

    it('同一引用出现多次只读一次分片', async () => {
        const packed = await externalizeAssets({ a: makeDataUrl('QQ'), b: makeDataUrl('QQ') }, 1024);
        const readFile = vi.fn(readerFrom(packed.chunks));

        await internalizeAssets(packed.data, packed.manifest, readFile);

        expect(readFile).toHaveBeenCalledTimes(1);
    });
});

describe('清单辅助', () => {
    it('manifestFileNames 汇总全部文件名，供云端清理比对', () => {
        const names = manifestFileNames({
            k1: { mime: 'image/png', bytes: 2, files: ['haha-asset-k1-0.txt', 'haha-asset-k1-1.txt'] },
            k2: { mime: 'image/svg+xml', bytes: 1, files: ['haha-asset-k2-0.txt'] }
        });

        expect([...names].sort()).toEqual([
            'haha-asset-k1-0.txt',
            'haha-asset-k1-1.txt',
            'haha-asset-k2-0.txt'
        ]);
        expect(manifestFileNames(undefined)).toEqual(new Set());
    });

    it('isAssetFileName 只认资源分片前缀', () => {
        expect(isAssetFileName(`${ASSET_FILE_PREFIX}abc-0.txt`)).toBe(true);
        expect(isAssetFileName('haha-newtab-sync.json')).toBe(false);
        expect(isAssetFileName('用户自己的说明.txt')).toBe(false);
    });
});
