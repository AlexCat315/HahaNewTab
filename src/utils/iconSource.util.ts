/**
 * 站点图标源解析
 *
 * 图标糊不糊只由一件事决定：拿到的源图有多大。这里不做任何放大、重采样或图像处理，
 * 只在几个真实存在的候选地址里挑出源图最大的那一个。
 *
 * 候选来自两处：
 *   1. `favicon.im/{host}` 与 `favicon.im/{裸域名}`。同一个站点这两个入口给回的
 *      尺寸并不单调——抖音 www 是 32px、裸域是 128px，知乎正好反过来（152px / 128px），
 *      所以两个都得试，不能固定偏好其中一个。
 *   2. 站点首页的 `<link rel="apple-touch-icon">`。这是唯一能拿到 180px 级别高清图的
 *      路子：favicon.im 对 v.qq.com 只给 32px，而它的 touch icon 是 180×180。
 *
 * 失败一律静默降级到 `favicon.im/{host}`，行为等同于没有探测能力时的旧逻辑。
 */

import { normalizeUrl } from './url.util';

/** favicon 服务地址 */
const FAVICON_SERVICE = 'https://favicon.im';

/** 单个图标候选的网络 + 解码预算 */
const PROBE_TIMEOUT_MS = 2500;
/** 首页 HTML 的读取预算，比图标探测更短：拿不到就只比 favicon 候选 */
const PAGE_TIMEOUT_MS = 2500;
/** 只扫头部这么多字符：`<link>` 全在 `<head>` 里，正文再长也不影响命中 */
const HTML_SCAN_LIMIT = 128 * 1024;
/** 单站最多探测几个 touch icon，防止页面塞了一串无意义尺寸 */
const TOUCH_ICON_LIMIT = 4;
/** favicon.im 未命中时回传的占位 SVG：固定 257 字节、image/svg+xml */
const PLACEHOLDER_BYTES = 257;

/** 一个探测成功的图标候选 */
export interface IconProbeResult {
    /** 可直接入库的图标地址 */
    url: string;
    /** 解码后的固有宽度；矢量图没有固有尺寸，记为 0 */
    width: number;
    /** 解码后的固有高度；矢量图没有固有尺寸，记为 0 */
    height: number;
    /** 响应体字节数 */
    bytes: number;
    /**
     * 是否为矢量图
     *
     * 矢量源在任意显示尺寸下都是重新绘制的，不存在「源图不够大所以被放大」这个问题，
     * 因此它必然优于任何位图候选——github.com 的 favicon 就是 959 字节的 SVG。
     */
    vector: boolean;
}

/**
 * 生成 favicon 服务地址
 *
 * 不带 `larger=true`：实测该参数对 favicon.im 完全无效，加与不加返回的字节完全一致。
 * 也不带时间戳：它会被永久存进 `app.icon`，而媒体缓存按完整 URL 做 key，
 * 同一个站点重复添加就会存下多份同样的图标。
 */
export function buildFaviconUrl(url: string): string | null {
    try {
        return `${FAVICON_SERVICE}/${new URL(normalizeUrl(url)).hostname}`;
    } catch {
        return null;
    }
}

/** 同一站点在 favicon 服务上的两个写法：带 www 和不带 www */
function faviconHosts(hostname: string): string[] {
    const bare = hostname.replace(/^www\./, '');
    if (hostname.startsWith('www.')) return [hostname, bare];
    return [hostname, `www.${hostname}`];
}

/** 带超时的 fetch；网络错误、非 2xx、超时统一折成 null，不向上抛 */
async function fetchOrNull(url: string, timeoutMs: number): Promise<Response | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { signal: controller.signal, credentials: 'omit', redirect: 'follow' });
        return response.ok ? response : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 用 `<img>` 解码来量源图尺寸
 *
 * 走 Image 而不是 createImageBitmap：这条链路和图标真正渲染时用的是同一个解码器，
 * 这里量到的尺寸、这里判定「能不能解」的格式，才代表界面里的实际结果。
 */
function measureImage(blob: Blob, url: string, isVector: boolean): Promise<IconProbeResult | null> {
    return new Promise((resolve) => {
        let objectUrl: string;
        try {
            objectUrl = URL.createObjectURL(blob);
        } catch {
            resolve(null);
            return;
        }
        const img = new Image();
        const finish = (result: IconProbeResult | null) => {
            try {
                URL.revokeObjectURL(objectUrl);
            } catch {
                /* 已释放或环境不支持，都不影响结果 */
            }
            resolve(result);
        };
        img.onload = () => {
            if (!img.naturalWidth || !img.naturalHeight) {
                // 矢量图常常不声明固有尺寸。它按显示尺寸重绘，没有尺寸也能用
                finish(isVector ? { url, width: 0, height: 0, bytes: blob.size, vector: true } : null);
                return;
            }
            finish({
                url,
                width: img.naturalWidth,
                height: img.naturalHeight,
                bytes: blob.size,
                vector: isVector,
            });
        };
        img.onerror = () => finish(null);
        img.src = objectUrl;
    });
}

/** 探测一个图标地址：取字节、解码、量尺寸。占位图、非图片、解不开的返回 null */
async function probeIcon(url: string): Promise<IconProbeResult | null> {
    const response = await fetchOrNull(url, PROBE_TIMEOUT_MS);
    if (!response) return null;

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (!contentType.startsWith('image/')) return null;

    let blob: Blob;
    try {
        blob = await response.blob();
    } catch {
        return null;
    }
    if (!blob.size) return null;
    const isVector = contentType.includes('svg');
    // 未命中的占位 SVG 能正常解码，只能靠「定长 + svg」把它认出来
    if (isVector && blob.size === PLACEHOLDER_BYTES) return null;

    return measureImage(blob, url, isVector);
}

/**
 * 从首页 HTML 里抠出 apple-touch-icon 的地址
 *
 * 按 `<link>` 整标签扫而不是拼一条长正则：属性顺序在不同站点不固定，
 * `rel` 也可能写成 `apple-touch-icon precomposed`。
 */
export function extractTouchIconUrls(html: string, baseUrl: string): string[] {
    const found: string[] = [];

    for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
        const rel = /\brel\s*=\s*["']?([^"'\s>][^"'>]*)["']?/i.exec(tag)?.[1] ?? '';
        if (!/apple-touch-icon/i.test(rel)) continue;

        const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
        if (!href) continue;

        try {
            found.push(new URL(href, baseUrl).href);
        } catch {
            /* 相对路径解析不了就跳过这个候选 */
        }
    }

    return [...new Set(found)].slice(0, TOUCH_ICON_LIMIT);
}

/** 探测站点首页声明的 touch icon；页面不是 HTML、抓不到、抓太慢都返回空 */
async function probeTouchIcons(origin: string): Promise<IconProbeResult[]> {
    const response = await fetchOrNull(`${origin}/`, PAGE_TIMEOUT_MS);
    if (!response) return [];
    if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('html')) return [];

    let html: string;
    try {
        html = (await response.text()).slice(0, HTML_SCAN_LIMIT);
    } catch {
        return [];
    }

    const links = extractTouchIconUrls(html, `${origin}/`);
    const results = await Promise.all(links.map(probeIcon));
    return results.filter((result): result is IconProbeResult => result !== null);
}

/**
 * 取最优候选
 *
 * 矢量优先：它按显示尺寸重新绘制，不存在放大糊掉的问题，任何位图都比不过它。
 * 位图之间按短边取大——图标按正方形显示，512×16 的横幅在卡片上和 16×16 一样糊；
 * 短边相同再比字节数，通常字节多的细节也更足。
 */
export function pickLargestIcon(results: (IconProbeResult | null)[]): IconProbeResult | null {
    let best: IconProbeResult | null = null;

    for (const result of results) {
        if (!result) continue;
        if (!best) {
            best = result;
            continue;
        }
        if (result.vector !== best.vector) {
            if (result.vector) best = result;
            continue;
        }
        if (result.vector) continue;

        const edge = Math.min(result.width, result.height);
        const bestEdge = Math.min(best.width, best.height);
        if (edge > bestEdge || (edge === bestEdge && result.bytes > best.bytes)) best = result;
    }

    return best;
}

/**
 * 解析出源图最大的图标地址
 *
 * @returns 最优候选的地址；一个候选都没探测成功时降级为 `favicon.im/{host}`，
 *          URL 本身无法解析时返回 null
 */
export async function resolveIconSource(input: string): Promise<string | null> {
    const normalized = normalizeUrl(input);
    if (!normalized) return null;

    let hostname: string;
    let origin: string;
    try {
        const parsed = new URL(normalized);
        hostname = parsed.hostname;
        origin = parsed.origin;
    } catch {
        return null;
    }
    if (!hostname || !origin) return buildFaviconUrl(input);

    const faviconUrls = faviconHosts(hostname).map((host) => `${FAVICON_SERVICE}/${host}`);
    const [faviconResults, touchResults] = await Promise.all([
        Promise.all(faviconUrls.map(probeIcon)),
        probeTouchIcons(origin),
    ]);

    const best = pickLargestIcon([...faviconResults, ...touchResults]);
    return best?.url ?? buildFaviconUrl(input);
}
