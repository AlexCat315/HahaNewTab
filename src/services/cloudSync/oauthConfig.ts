/**
 * OAuth App 的 Client ID：构建期可内置，用户也可在面板里覆盖一次
 *
 * Client ID 是可以公开的标识（不是密钥），Device Flow 不需要 client secret。
 * 它属于「应用配置」而非「账号凭据」，所以单独存一个键，不混进 CloudSettings 的账号快照：
 * 换账号、断开连接都不该把它清掉，否则每台设备、每次重连都要再填一遍。
 */

import { storageManager } from '@/services/storage.service';
import { STORAGE_KEYS } from '@/types/storage';

/** 构建时注入：VITE_GITHUB_CLIENT_ID=xxx npm run build */
const BUILT_IN_CLIENT_ID = (import.meta.env.VITE_GITHUB_CLIENT_ID as string | undefined)?.trim() ?? '';

export function builtInClientId(): string {
    return BUILT_IN_CLIENT_ID;
}

/** 面板用的最终值：本机配置优先于构建期默认值 */
export async function loadClientId(): Promise<string> {
    const saved = await storageManager.get(STORAGE_KEYS.CLOUD_OAUTH_CLIENT_ID);
    if (typeof saved === 'string' && saved.trim()) {
        return saved.trim();
    }
    return BUILT_IN_CLIENT_ID;
}

/** 空串表示清掉本机覆盖值，退回构建期默认值 */
export async function saveClientId(clientId: string): Promise<void> {
    await storageManager.set(STORAGE_KEYS.CLOUD_OAUTH_CLIENT_ID, clientId.trim());
}
