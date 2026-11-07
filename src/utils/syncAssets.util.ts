/**
 * 同步资源分装
 *
 * payload 里只要出现 data URL，体积就从几十 KB 跳到几 MB——历史遗留的 Base64 站点图标
 * 和用户上传的本地壁纸都是这种情况。GitHub Gist 单文件上限为 10MB，
 * 整包塞进去要么写不进去，要么撞上详情接口的 1MB 内联截断，所以在「上云 / 下云」这一层
 * 把大对象拆出去：
 *
 *   上传：data URL → `haha-asset://{key}` 引用 + 按内容哈希命名的分片文件
 *   下载：引用 → 取回分片拼成 data URL，再交给校验与合并
 *
 * 本地存储的形态不变（仍然是 data URL），渲染链路、导入导出、各 store 都不感知这件事。
 * 分片名带内容哈希，因此「云端已存在同名文件」等价于「内容相同、可以不重传」。
 */

import type { SyncAssetManifest } from '@/types/cloudSync.types';

/** 同步 payload 里资源引用的前缀 */
export const ASSET_REF_PREFIX = 'haha-asset://';

/** 资源分片文件名前缀：清理云端时只删以它开头的文件，用户自己放进 Gist 的文件不碰 */
export const ASSET_FILE_PREFIX = 'haha-asset-';

/** 是否为同步资源分片文件 */
export function isAssetFileName(name: string): boolean {
    return name.startsWith(ASSET_FILE_PREFIX);
}

/** 只处理 Base64 形态的 data URL：百分号编码的那类都是几百字节的小图标，拆出去反而多一次请求 */
const BASE64_DATA_URL = /^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/;

/** 资源清单：key → 条目，随主文件一起写进同步 JSON */
export type AssetManifest = SyncAssetManifest;

/** 分装结果 */
export interface ExternalizedPayload {
    /** 引用替换后的数据 */
    data: unknown;
    /** 资源清单；没有资源时为 undefined，主文件因此不多占一个空对象 */
    manifest?: AssetManifest;
    /** 需要上传的分片：文件名 → 内容 */
    chunks: Record<string, string>;
}

/**
 * 内容哈希
 *
 * 有 SubtleCrypto 就用 SHA-256（扩展页面与 Firefox 都有）；
 * 没有时退回 FNV-1a，只为 jsdom 之类没有 SubtleCrypto 的测试环境能跑通，
 * 真实运行环境不会走到这条分支。
 *
 * 云同步也用它给「云端这一版」编号（见 cloudSync.service 的已见版本号），
 * 所以这里导出：同一套指纹算法只有一份，避免两处判断对不上。
 */
export async function hashKey(text: string): Promise<string> {
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
        const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
        return [...new Uint8Array(digest).slice(0, 16)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    }
    return fallbackHash(text);
}

/** FNV-1a 双通道 64 位摘要（仅测试环境兜底用） */
function fallbackHash(text: string): string {
    let a = 0x811c9dc5;
    let b = 0x01000193;
    for (let i = 0; i < text.length; i++) {
        a = Math.imul(a ^ text.charCodeAt(i), 0x01000193) >>> 0;
        b = Math.imul(b + text.charCodeAt(i), 0x811c9dc5) >>> 0;
    }
    return (a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')).repeat(2);
}

/** 解析 Base64 data URL；不是该形态时返回 null */
function parseDataUrl(value: string): { mime: string; base64: string } | null {
    const matched = BASE64_DATA_URL.exec(value);
    return matched ? { mime: matched[1], base64: matched[2] } : null;
}

/** 分片文件名：内容哈希 + 序号，纯 ASCII，不含路径分隔符 */
function chunkFileName(key: string, index: number): string {
    return `haha-asset-${key}-${index}.txt`;
}

/** 按固定长度切分 Base64 文本 */
function splitChunks(base64: string, chunkChars: number): string[] {
    const size = Math.max(1, Math.floor(chunkChars));
    const parts: string[] = [];
    for (let start = 0; start < base64.length; start += size) {
        parts.push(base64.slice(start, start + size));
    }
    return parts.length ? parts : [''];
}

/**
 * 把 payload 里的 data URL 换成资源引用
 *
 * @param value 待分装的数据（本地形态，含 data URL）
 * @param chunkChars 单个分片文件允许的最大字符数，由平台上限换算而来
 */
export async function externalizeAssets(value: unknown, chunkChars: number): Promise<ExternalizedPayload> {
    const manifest: AssetManifest = {};
    const chunks: Record<string, string> = {};
    /** 同一份内容在多个站点上重复出现时只传一次 */
    const keyByDataUrl = new Map<string, string>();

    async function walk(node: unknown): Promise<unknown> {
        if (typeof node === 'string') {
            const parsed = parseDataUrl(node);
            if (!parsed) return node;

            const cached = keyByDataUrl.get(node);
            if (cached) return `${ASSET_REF_PREFIX}${cached}`;

            const key = await hashKey(node);
            keyByDataUrl.set(node, key);

            const files = splitChunks(parsed.base64, chunkChars).map((part, index) => {
                const name = chunkFileName(key, index);
                chunks[name] = part;
                return name;
            });
            manifest[key] = { mime: parsed.mime, bytes: parsed.base64.length, files };
            return `${ASSET_REF_PREFIX}${key}`;
        }
        if (Array.isArray(node)) {
            return await Promise.all(node.map(walk));
        }
        if (node && typeof node === 'object') {
            const result: Record<string, unknown> = {};
            for (const [childKey, child] of Object.entries(node as Record<string, unknown>)) {
                result[childKey] = await walk(child);
            }
            return result;
        }
        return node;
    }

    const data = await walk(value);
    return {
        data,
        manifest: Object.keys(manifest).length ? manifest : undefined,
        chunks
    };
}

/** 清单登记的全部文件名，用于算出云端哪些分片已经没人引用了 */
export function manifestFileNames(manifest: AssetManifest | undefined): Set<string> {
    const names = new Set<string>();
    for (const entry of Object.values(manifest ?? {})) {
        for (const name of entry.files) {
            names.add(name);
        }
    }
    return names;
}

/**
 * 把资源引用还原成 data URL
 *
 * @param readFile 按文件名取分片内容；取不到时返回 null
 * @returns 引用已还原的数据；清单缺失或分片取不到时原样保留引用字符串，
 *          宁可让某个图标显示不出来，也不能把整份数据判坏
 */
export async function internalizeAssets(
    value: unknown,
    manifest: AssetManifest | undefined,
    readFile: (name: string) => Promise<string | null>
): Promise<unknown> {
    if (!manifest || !Object.keys(manifest).length) return value;

    const entries = manifest;
    const contentByKey = new Map<string, Promise<string | null>>();

    function loadAsset(key: string): Promise<string | null> {
        const entry = entries[key];
        if (!entry) return Promise.resolve(null);
        const pending = contentByKey.get(key);
        if (pending) return pending;

        const task = (async () => {
            const parts: string[] = [];
            for (const name of entry.files) {
                const part = await readFile(name);
                if (part === null) return null;
                parts.push(part);
            }
            return `data:${entry.mime};base64,${parts.join('')}`;
        })();
        contentByKey.set(key, task);
        return task;
    }

    async function walk(node: unknown): Promise<unknown> {
        if (typeof node === 'string') {
            if (!node.startsWith(ASSET_REF_PREFIX)) return node;
            const restored = await loadAsset(node.slice(ASSET_REF_PREFIX.length));
            return restored ?? node;
        }
        if (Array.isArray(node)) {
            return await Promise.all(node.map(walk));
        }
        if (node && typeof node === 'object') {
            const result: Record<string, unknown> = {};
            for (const [childKey, child] of Object.entries(node as Record<string, unknown>)) {
                result[childKey] = await walk(child);
            }
            return result;
        }
        return node;
    }

    return await walk(value);
}
