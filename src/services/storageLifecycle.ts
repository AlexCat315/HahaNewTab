/**
 * 存储生命周期：应用启动时唯一要调的入口
 *
 * 以前 main.ts 与 popup.ts 各自调 cleanupLegacyStorageKeys，配额/用量/清理策略
 * 散在调用方里。这里统一收口，以后加初始化步骤（缓存过期清理、配额预警等）
 * 只改这一处，两个入口都不用动。
 *
 * 所有步骤都异步执行且不阻塞首帧：首帧数据来自构建期注入的 __boot__ 快照。
 */

import { storageManager, cleanupLegacyStorageKeys } from '@/services/storage.service';

/** 启动后异步跑一遍存储维护；失败只是少回收一点配额，不影响功能 */
export async function initializeStorage(): Promise<void> {
    await cleanupLegacyStorageKeys();
    // IndexedDB 缓存的过期条目在 mediaCacheService 打开数据库时自行清理，无需在这里再扫一遍
}

/**
 * 主存储区占用（字节）
 * 由统一门面估算；界面只展示量级与趋势，不把它当配额上限。
 */
export async function getMainStorageUsage(): Promise<number> {
    try {
        return await storageManager.usage();
    } catch {
        // 网页预览降级失败或测试环境没实现 usage 时按 0 处理，界面照常可用
        return 0;
    }
}

/** 配额告警阈值：超过后提示用户检查本地壁纸与图标 */
export const STORAGE_USAGE_WARN_BYTES = 8 * 1024 * 1024;
