import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    buildFaviconUrl,
    extractTouchIconUrls,
    pickLargestIcon,
    resolveIconSource,
    type IconProbeResult,
} from '../iconSource.util';

/**
 * 图标源解析的桩网络
 *
 * 只实现被测代码真正用到的 ok / headers / blob / text 四样，blob() 固定返回同一个
 * Blob 实例，好让 Blob → 尺寸 的映射在 measureImage 里查得到。
 */
interface FakeDims {
    width: number;
    height: number;
    bytes?: number;
    type?: string;
    /** 模拟不声明固有尺寸的 SVG：解码后 naturalWidth 为 0 */
    sizeless?: boolean;
}

const blobDims = new WeakMap<Blob, FakeDims>();
const objectUrlDims = new Map<string, FakeDims>();
const requested: string[] = [];
let objectSeq = 0;
let originalCreateObjectURL: unknown;
let originalRevokeObjectURL: unknown;

function iconBody(dims: FakeDims): Blob {
    const size = dims.bytes ?? 1024;
    const blob = new Blob([new Uint8Array(size)], { type: dims.type ?? 'image/png' });
    blobDims.set(blob, dims);
    return blob;
}

function fakeResponse(body: Blob | string, contentType: string) {
    return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': contentType }),
        blob: () => Promise.resolve(body instanceof Blob ? body : new Blob([body], { type: contentType })),
        text: () => Promise.resolve(typeof body === 'string' ? body : ''),
    };
}

/**
 * @param icons 图标地址 → 解码尺寸；值为 null 表示该地址请求失败
 * @param pages 页面地址 → HTML 正文；未列出的页面请求失败
 */
function stubNetwork(icons: Record<string, FakeDims | null>, pages: Record<string, string> = {}): void {
    vi.stubGlobal('fetch', (input: string | URL) => {
        const url = String(input);
        requested.push(url);
        const dims = icons[url];
        if (dims) {
            const type = dims.type ?? 'image/png';
            return Promise.resolve(fakeResponse(iconBody(dims), type));
        }
        const html = pages[url];
        if (html !== undefined) return Promise.resolve(fakeResponse(html, 'text/html; charset=utf-8'));
        return Promise.reject(new TypeError('no such address'));
    });
}

class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 0;
    naturalHeight = 0;

    set src(value: string) {
        const dims = objectUrlDims.get(value);
        queueMicrotask(() => {
            if (!dims) {
                this.onerror?.();
                return;
            }
            this.naturalWidth = dims.sizeless ? 0 : dims.width;
            this.naturalHeight = dims.sizeless ? 0 : dims.height;
            this.onload?.();
        });
    }
}

function result(url: string, width: number, height: number, bytes = 1024, vector = false): IconProbeResult {
    return { url, width, height, bytes, vector };
}

beforeEach(() => {
    requested.length = 0;
    objectUrlDims.clear();
    objectSeq = 0;

    vi.stubGlobal('Image', FakeImage);
    // jsdom 的 URL 上没有 createObjectURL，spyOn 会直接报错，只能自己挂并自己还原
    const Url = globalThis.URL as unknown as Record<string, unknown>;
    originalCreateObjectURL = Url.createObjectURL;
    originalRevokeObjectURL = Url.revokeObjectURL;
    Url.createObjectURL = (blob: Blob) => {
        const id = `blob:${++objectSeq}`;
        const dims = blobDims.get(blob);
        if (dims) objectUrlDims.set(id, dims);
        return id;
    };
    Url.revokeObjectURL = (id: string) => {
        objectUrlDims.delete(id);
    };
});

afterEach(() => {
    const Url = globalThis.URL as unknown as Record<string, unknown>;
    Url.createObjectURL = originalCreateObjectURL;
    Url.revokeObjectURL = originalRevokeObjectURL;
    vi.unstubAllGlobals();
});

describe('buildFaviconUrl', () => {
    it('只给裸地址，不带 larger 参数也不带时间戳', () => {
        expect(buildFaviconUrl('https://www.douyin.com/?from=0')).toBe('https://favicon.im/www.douyin.com');
    });

    it('缺少协议时补 https 后取 host', () => {
        expect(buildFaviconUrl('example.com')).toBe('https://favicon.im/example.com');
    });

    it('无法解析时返回 null', () => {
        expect(buildFaviconUrl('')).toBeNull();
    });
});

describe('extractTouchIconUrls', () => {
    const base = 'https://v.qq.com/';

    it('认出 apple-touch-icon 并把相对路径解析成绝对地址', () => {
        const html = '<head><link rel="apple-touch-icon" href="/icons/touch-180.png"></head>';
        expect(extractTouchIconUrls(html, base)).toEqual(['https://v.qq.com/icons/touch-180.png']);
    });

    it('属性顺序颠倒、rel 带多个值也能认出', () => {
        const html = '<link sizes="180x180" href="a.png" rel="apple-touch-icon precomposed">';
        expect(extractTouchIconUrls(html, base)).toEqual(['https://v.qq.com/a.png']);
    });

    it('忽略普通 icon 和其它 link', () => {
        const html = '<link rel="icon" href="f.ico"><link rel="manifest" href="m.webmanifest">';
        expect(extractTouchIconUrls(html, base)).toEqual([]);
    });

    it('去重并限制数量', () => {
        const html = Array.from({ length: 8 }, (_, i) => `<link rel="apple-touch-icon" href="i${i % 2}.png">`).join('');
        const urls = extractTouchIconUrls(html, base);
        expect(urls).toHaveLength(2);
    });
});

describe('pickLargestIcon', () => {
    it('按短边取大，横幅图标赢不了正方形', () => {
        const banner = result('banner', 512, 16);
        const square = result('square', 128, 128);
        expect(pickLargestIcon([banner, square])?.url).toBe('square');
    });

    it('短边相同时取字节多的', () => {
        const small = result('small', 128, 128, 900);
        const big = result('big', 128, 128, 4000);
        expect(pickLargestIcon([small, big])?.url).toBe('big');
    });

    it('全部探测失败时返回 null', () => {
        expect(pickLargestIcon([null, null])).toBeNull();
    });

    it('矢量候选赢过任何位图，包括更大的位图', () => {
        const raster = result('raster', 512, 512);
        const vector = result('vector', 0, 0, 959, true);
        expect(pickLargestIcon([raster, vector])?.url).toBe('vector');
    });
});

describe('resolveIconSource', () => {
    it('www 与裸域名两个候选都探，取更大的那个', async () => {
        stubNetwork({
            'https://favicon.im/www.douyin.com': { width: 32, height: 32 },
            'https://favicon.im/douyin.com': { width: 128, height: 128 },
        });
        await expect(resolveIconSource('https://www.douyin.com')).resolves.toBe('https://favicon.im/douyin.com');
    });

    it('反过来裸域名更大时也不偏向 www', async () => {
        stubNetwork({
            'https://favicon.im/zhihu.com': { width: 152, height: 152 },
            'https://favicon.im/www.zhihu.com': { width: 128, height: 128 },
        });
        await expect(resolveIconSource('https://zhihu.com')).resolves.toBe('https://favicon.im/zhihu.com');
    });

    it('touch icon 比 favicon 候选更大时选它', async () => {
        stubNetwork(
            {
                'https://favicon.im/v.qq.com': { width: 32, height: 32 },
                'https://favicon.im/www.v.qq.com': { width: 32, height: 32 },
                'https://v.qq.com/touch-180.png': { width: 180, height: 180, bytes: 6000 },
            },
            { 'https://v.qq.com/': '<link rel="apple-touch-icon" href="/touch-180.png">' },
        );
        await expect(resolveIconSource('https://v.qq.com')).resolves.toBe('https://v.qq.com/touch-180.png');
    });

    it('拒掉未命中的 257 字节占位 SVG，仍选真实图标', async () => {
        stubNetwork({
            'https://favicon.im/example.com': { width: 16, height: 16, bytes: 257, type: 'image/svg+xml' },
            'https://favicon.im/www.example.com': { width: 32, height: 32, bytes: 1200 },
        });
        await expect(resolveIconSource('https://example.com')).resolves.toBe('https://favicon.im/www.example.com');
    });

    it('非图片响应不算候选', async () => {
        stubNetwork({
            'https://favicon.im/example.com': { width: 64, height: 64, type: 'text/html' },
            'https://favicon.im/www.example.com': { width: 32, height: 32 },
        });
        await expect(resolveIconSource('https://example.com')).resolves.toBe('https://favicon.im/www.example.com');
    });

    it('矢量 favicon 不被同站的小位图挤掉', async () => {
        stubNetwork({
            'https://favicon.im/github.com': { width: 0, height: 0, bytes: 959, type: 'image/svg+xml', sizeless: true },
            'https://favicon.im/www.github.com': { width: 32, height: 32 },
        });
        await expect(resolveIconSource('https://github.com')).resolves.toBe('https://favicon.im/github.com');
    });

    it('什么都探不到时降级为裸 favicon 地址', async () => {
        stubNetwork({});
        await expect(resolveIconSource('https://dead.example')).resolves.toBe('https://favicon.im/dead.example');
    });

    it('首页抓不到不影响 favicon 候选出结果', async () => {
        stubNetwork({
            'https://favicon.im/example.com': { width: 48, height: 48 },
            'https://favicon.im/www.example.com': { width: 32, height: 32 },
        });
        await expect(resolveIconSource('https://example.com')).resolves.toBe('https://favicon.im/example.com');
        expect(requested).toContain('https://example.com/');
    });

    it('URL 无法解析时返回 null', async () => {
        stubNetwork({});
        await expect(resolveIconSource('')).resolves.toBeNull();
    });
});
