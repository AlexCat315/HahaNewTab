/**
 * 云端传输层：本机与那个 Gist 之间的一来一回
 *
 * 这一层只懂「云端长什么样」：文件叫什么、分片怎么拼、上限多少、平台怎么切换，
 * 不懂合并、不懂本地 store、也不弹提示。给它一份凭据（CloudTarget），
 * 它就把那一版的云端内容原样交出来，或者把本机这份推上去。
 *
 * 交给服务层的是一等公民 CloudBundle，不再是「在 SyncData 上偷偷挂个 revision 字段」：
 * 版本号、写入时间、数据三者本来就是一回事，拆开传就会有人在某一边忘记传。
 */

import {
    externalizeAssets,
    hashKey,
    internalizeAssets,
    isAssetFileName,
    manifestFileNames
} from '@/utils/syncAssets.util';
import { createGistProvider } from '@/services/gistProvider.service';
import { CLOUD_SYNC_DATA_KEYS } from '@/services/storageSchema.service';
import type { SyncSnapshot } from '@/utils/syncMerge.util';
import type {
    CloudBundle,
    CloudSyncProviderId,
    CloudTarget,
    GitHubUserInfo,
    ISyncProvider,
    SyncData
} from '@/types/cloudSync.types';

/** 同步包所在的文件名 */
export const SYNC_FILE_NAME = 'haha-newtab-sync.json';

const GIST_DESCRIPTION = 'HahaNewTab 导航数据云同步备份';

/**
 * 同步包结构版本
 * 1.1 起 payload 里的大对象改走 `assets` 清单 + 分片文件；1.0 的老包仍能读（没有清单就是全内联）。
 */
const SYNC_DATA_VERSION = '1.1';

/**
 * 单个资源分片占平台上限的比例
 * 留两成余量：Base64 之外还有文件名与请求体本身的开销，贴着上限写容易被拒。
 */
const ASSET_CHUNK_RATIO = 0.8;

/** 目标平台的适配器 */
function providerFor(providerId: CloudSyncProviderId): ISyncProvider {
    return createGistProvider(providerId);
}

/**
 * 验证凭据属于哪个账号
 * 登录时先验再存，验不过就不能把它当成「已登录」写进设置。
 */
export async function validateToken(token: string, providerId: CloudSyncProviderId): Promise<GitHubUserInfo> {
    return providerFor(providerId).validateToken(token);
}

/**
 * 平台在界面上的样子：名称、Token 从哪来、长什么样
 * 服务层要提示「连接到哪个平台」时问这里，而不是自己碰适配器。
 */
export function providerProfile(providerId: CloudSyncProviderId): {
    name: string;
    tokenHint: string;
    tokenPlaceholder: string;
} {
    const provider = providerFor(providerId);
    return {
        name: provider.name,
        tokenHint: provider.tokenHint,
        tokenPlaceholder: providerId === 'gitee' ? 'xxxxxxxxxxxxxxxx' : 'ghp_xxxxxxxxxxxxxxxxxxxx'
    };
}

/**
 * 找到（或建出）放同步包的 Gist
 * 优先复用本机记下的 gistId；它已经不在了再按文件名认领现有的，最后才新建。
 */
export async function findOrCreateGist(target: CloudTarget, gistId: string | null): Promise<string> {
    const provider = providerFor(target.providerId);
    if (gistId) {
        try {
            const content = await provider.getGistFileContent(target.token, gistId, SYNC_FILE_NAME);
            if (content !== null) {
                return gistId;
            }
        } catch {
            console.warn('[CloudSync] stored gist not found, creating new one');
        }
    }

    const gists = await provider.listGists(target.token);
    const existing = gists.find(gist => gist.files?.[SYNC_FILE_NAME]);
    if (existing) {
        return existing.id;
    }

    return provider.createGist(
        target.token,
        SYNC_FILE_NAME,
        JSON.stringify(emptySyncData(), null, 2),
        GIST_DESCRIPTION
    );
}

/**
 * 读回云端那一版内容
 * 主文件与被引用的资源分片共用同一次文件表请求；资源还原成 data URL 才交出去，
 * 因此接收方看到的本地形态与 base 快照始终一致，不会出现「引用 vs 原文」永远比不相等的情况。
 *
 * 只交注册表登记的键：云端包里可能留着旧版本或别的分支写过的多余键，
 * 收进来再过滤等于把「本机根本没这套数据」的键当成有效内容参与比较。
 */
export async function readBundle(target: CloudTarget, gistId: string): Promise<CloudBundle> {
    const provider = providerFor(target.providerId);
    const files = await provider.getGistFileMap(target.token, gistId);
    const content = files
        ? await provider.readFileFromMap(target.token, files[SYNC_FILE_NAME])
        : null;
    if (content === null) {
        throw new Error('同步文件不存在');
    }

    const payload = JSON.parse(content) as SyncData;
    const data = await internalizeAssets(
        payload.data,
        payload.assets,
        name => provider.readFileFromMap(target.token, files?.[name])
    ) as Record<string, unknown>;

    return {
        data: pickSyncData(data),
        lastModified: payload.lastModified,
        // 指纹取自还原分片之前的原始文件内容
        revision: await hashKey(content)
    };
}

/**
 * null 与「键不存在」同义（另一端没有这份数据），一并丢掉
 */
function pickSyncData(data: Record<string, unknown>): SyncSnapshot {
    const snapshot: SyncSnapshot = {};
    for (const key of CLOUD_SYNC_DATA_KEYS) {
        const value = data[key];
        if (value !== undefined && value !== null) {
            snapshot[key] = value;
        }
    }
    return snapshot;
}

/**
 * 把这一份数据推成云端的新版本
 *
 * 大对象拆成 `haha-asset-*` 分片文件：分片名由内容哈希决定，云端已有同名文件就意味着
 * 内容一致，因此只补传缺失的分片；本次不再引用的分片随后删除。
 * @returns 这份包的写入时间（一并记进账本）
 */
export async function writeBundle(
    target: CloudTarget,
    gistId: string,
    data: SyncSnapshot
): Promise<number> {
    const provider = providerFor(target.providerId);
    const externalized = await externalizeAssets(data, chunkChars(provider));
    const lastModified = Date.now();
    const payload: SyncData = {
        version: SYNC_DATA_VERSION,
        lastModified,
        device: deviceName(),
        data: externalized.data as Record<string, unknown>,
        assets: externalized.manifest
    };

    const files = await provider.getGistFileMap(target.token, gistId) ?? {};
    const upsert: Record<string, string> = { [SYNC_FILE_NAME]: JSON.stringify(payload, null, 2) };
    for (const [name, part] of Object.entries(externalized.chunks)) {
        if (!files[name]) {
            upsert[name] = part;
        }
    }

    const keep = manifestFileNames(externalized.manifest);
    const deleteFileNames = Object.keys(files).filter(name => isAssetFileName(name) && !keep.has(name));

    await provider.updateGistFiles(target.token, gistId, upsert, deleteFileNames);
    return lastModified;
}

/** 新建 Gist 时的空包 */
function emptySyncData(): SyncData {
    return {
        version: SYNC_DATA_VERSION,
        lastModified: Date.now(),
        device: deviceName(),
        data: {}
    };
}

/** 单个资源分片的字符数上限，由平台单文件上限换算 */
function chunkChars(provider: ISyncProvider): number {
    return Math.floor(provider.maxFileBytes * ASSET_CHUNK_RATIO);
}

/** 包上留的设备名：排查「这份改动是哪台机器写的」时唯一的线索 */
function deviceName(): string {
    if (typeof navigator === 'undefined') return 'Browser';
    const ua = navigator.userAgent;
    if (ua.includes('Chrome')) return 'Chrome';
    if (ua.includes('Firefox')) return 'Firefox';
    if (ua.includes('Safari')) return 'Safari';
    if (ua.includes('Edg')) return 'Edge';
    return 'Browser';
}
