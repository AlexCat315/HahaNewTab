/**
 * 云同步 Composable
 * 把 cloudSync store（同步本身）与 crossDeviceAuth store（浏览器账号同步区）拼成面板要的那一份接口，
 * 并处理副作用清理：本地数据变更监听、未完成的操作、同步区凭据变更监听。
 */

import { computed, onMounted, onUnmounted } from 'vue';
import type { ComputedRef } from 'vue';
import { useCloudSyncStore } from '@/stores/cloudSync.store';
import { useCrossDeviceAuthStore } from '@/stores/crossDeviceAuth.store';
import type { EnableCrossDeviceOutcome } from '@/stores/cloudSync.store';
import type { CrossDeviceRemoteMeta } from '@/services/crossDeviceSync.service';
import type {
    CloudSyncProviderId,
    DownloadResult,
    GitHubUserInfo,
    ICloudSyncUIAdapter,
    PullResult,
    SyncResult,
    UploadResult
} from '@/types/cloudSync.types';

export interface UseCloudSyncOptions {
    /** UI 适配器；未提供时使用 Store 默认适配器 */
    uiAdapter?: ICloudSyncUIAdapter;
}

export interface UseCloudSyncReturn {
    token: ComputedRef<string | null>;
    gistId: ComputedRef<string | null>;
    provider: ComputedRef<CloudSyncProviderId>;
    autoSync: ComputedRef<boolean>;
    userInfo: ComputedRef<GitHubUserInfo | null>;
    lastSyncTime: ComputedRef<number>;
    isLoading: ComputedRef<boolean>;
    error: ComputedRef<string | null>;
    isLoggedIn: ComputedRef<boolean>;
    crossDeviceEnabled: ComputedRef<boolean>;
    crossDeviceHasPassphrase: ComputedRef<boolean>;
    crossDeviceRemoteAvailable: ComputedRef<boolean>;
    /** 同步区凭据的元信息（来自哪台设备、何时推送） */
    crossDeviceRemoteMeta: ComputedRef<CrossDeviceRemoteMeta | null>;
    /** 当前环境是否使用浏览器账号同步区（false = 网页预览的 localStorage 降级） */
    syncAreaNative: ComputedRef<boolean>;
    statusText: ComputedRef<string>;
    formattedLastSyncTime: ComputedRef<string>;
    init: () => Promise<void>;
    login: (inputToken: string, providerId?: CloudSyncProviderId) => Promise<boolean>;
    logout: () => Promise<void>;
    setAutoSync: (enabled: boolean) => Promise<void>;
    upload: (options?: { silent?: boolean }) => Promise<UploadResult>;
    sync: (options?: { silent?: boolean }) => Promise<SyncResult>;
    download: () => Promise<DownloadResult>;
    pullAndApply: (options?: { force?: boolean; silent?: boolean }) => Promise<PullResult>;
    showLoginDialog: () => Promise<void>;
    cancelPending: () => void;
    refreshCrossDevice: () => Promise<void>;
    enableCrossDeviceSync: (passphrase: string) => Promise<EnableCrossDeviceOutcome>;
    disableCrossDeviceSync: () => Promise<void>;
    restoreFromCrossDevice: (passphrase: string) => Promise<boolean>;
    tryRestoreCrossDevice: (passphrase?: string) => Promise<boolean>;
}

/** 平台标识到显示名的映射 */
const PROVIDER_NAMES: Record<CloudSyncProviderId, string> = {
    github: 'GitHub',
    gitee: 'Gitee'
};

function formatDateTime(timestamp: number): string {
    if (!timestamp) {
        return '从未同步';
    }
    try {
        return new Date(timestamp).toLocaleString();
    } catch (_) {
        return '从未同步';
    }
}

/**
 * 创建 AbortController 集合，用于取消未完成的异步操作
 */
function createAbortControllerSet(): {
    add: (controller: AbortController) => void;
    remove: (controller: AbortController) => void;
    abortAll: () => void;
} {
    const controllers = new Set<AbortController>();
    return {
        add(controller: AbortController) {
            controllers.add(controller);
        },
        remove(controller: AbortController) {
            controllers.delete(controller);
        },
        abortAll() {
            for (const controller of controllers) {
                controller.abort();
            }
            controllers.clear();
        }
    };
}

/**
 * 云同步 Composable
 */
export function useCloudSync(options: UseCloudSyncOptions = {}): UseCloudSyncReturn {
    const store = useCloudSyncStore();
    const crossDevice = useCrossDeviceAuthStore();
    const { uiAdapter } = options;

    const abortControllers = createAbortControllerSet();
    let unwatchRemoteAuth: (() => void) | null = null;

    if (uiAdapter) {
        store.setUIAdapter(uiAdapter);
    }

    const isLoggedIn = computed(() => store.isLoggedIn);

    const statusText = computed(() => {
        if (store.isLoading) {
            return '同步中...';
        }
        if (store.isLoggedIn && store.userInfo) {
            return `已连接：${PROVIDER_NAMES[store.provider] ?? store.provider} / ${store.userInfo.login}`;
        }
        return '未连接';
    });

    const formattedLastSyncTime = computed(() => formatDateTime(store.lastSyncTime));

    /**
     * 将异步操作包装为可取消操作
     * 组件卸载时会触发 AbortController，未完成的 Promise 将以 AbortError 拒绝。
     */
    function createAbortable<T>(operation: () => Promise<T>): Promise<T> {
        const controller = new AbortController();
        const signal = controller.signal;

        if (signal.aborted) {
            return Promise.reject(new DOMException('Operation aborted', 'AbortError'));
        }

        abortControllers.add(controller);

        let abortHandler: (() => void) | null = null;

        const abortPromise = new Promise<T>((_, reject) => {
            abortHandler = () => {
                cleanup();
                reject(new DOMException('Operation aborted', 'AbortError'));
            };
            signal.addEventListener('abort', abortHandler, { once: true });
        });

        function cleanup() {
            if (abortHandler) {
                signal.removeEventListener('abort', abortHandler);
            }
            abortControllers.remove(controller);
        }

        return Promise.race([operation(), abortPromise]).finally(cleanup);
    }

    /**
     * 取消所有未完成的操作
     */
    function cancelPending(): void {
        abortControllers.abortAll();
    }

    async function init(): Promise<void> {
        return createAbortable(() => store.init());
    }

    async function login(inputToken: string, providerId?: CloudSyncProviderId): Promise<boolean> {
        return createAbortable(() => store.login(inputToken, providerId));
    }

    async function logout(): Promise<void> {
        return createAbortable(() => store.logout());
    }

    async function setAutoSync(enabled: boolean): Promise<void> {
        return createAbortable(() => store.setAutoSync(enabled));
    }

    async function upload(opts?: { silent?: boolean }): Promise<UploadResult> {
        return createAbortable(() => store.upload(opts));
    }

    async function sync(opts?: { silent?: boolean }): Promise<SyncResult> {
        return createAbortable(() => store.sync(opts));
    }

    async function download(): Promise<DownloadResult> {
        return createAbortable(() => store.download());
    }

    async function pullAndApply(opts?: { force?: boolean; silent?: boolean }): Promise<PullResult> {
        return createAbortable(() => store.pullAndApply(opts));
    }

    async function showLoginDialog(): Promise<void> {
        return createAbortable(() => store.showLoginDialog());
    }

    async function refreshCrossDevice(): Promise<void> {
        return createAbortable(() => store.refreshCrossDevice());
    }

    async function enableCrossDeviceSync(passphrase: string): Promise<EnableCrossDeviceOutcome> {
        return createAbortable(() => store.enableCrossDeviceSync(passphrase));
    }

    async function tryRestoreCrossDevice(passphrase?: string): Promise<boolean> {
        return createAbortable(() => store.tryRestoreCrossDevice(passphrase));
    }

    async function disableCrossDeviceSync(): Promise<void> {
        return createAbortable(() => store.disableCrossDeviceSync());
    }

    async function restoreFromCrossDevice(passphrase: string): Promise<boolean> {
        return createAbortable(() => store.restoreFromCrossDevice(passphrase));
    }

    onMounted(() => {
        // 本地数据一落盘就防抖触发自动同步；变更源是存储内核，覆盖所有写入路径
        store.startAutoSyncWatch();
        // 其他设备推送浏览器同步凭据后，本机即时感知并尝试免 Token 登录
        unwatchRemoteAuth = crossDevice.watchRemote(() => {
            refreshCrossDevice()
                .then(() => tryRestoreCrossDevice())
                .catch(() => {
                    // 状态刷新 / 自动还原失败不影响主流程
                });
        });
        init().catch(() => {
            // 初始化失败由 store.error 暴露，不在此处抛出
        });
    });

    onUnmounted(() => {
        store.stopAutoSyncWatch();
        unwatchRemoteAuth?.();
        unwatchRemoteAuth = null;
        cancelPending();
    });

    return {
        token: computed(() => store.token),
        gistId: computed(() => store.gistId),
        provider: computed(() => store.provider),
        autoSync: computed(() => store.autoSync),
        userInfo: computed(() => store.userInfo),
        lastSyncTime: computed(() => store.lastSyncTime),
        isLoading: computed(() => store.isLoading),
        error: computed(() => store.error),
        isLoggedIn,
        crossDeviceEnabled: computed(() => crossDevice.enabled),
        crossDeviceHasPassphrase: computed(() => crossDevice.hasPassphrase),
        crossDeviceRemoteAvailable: computed(() => crossDevice.remoteAvailable),
        crossDeviceRemoteMeta: computed(() => crossDevice.remoteMeta),
        syncAreaNative: computed(() => crossDevice.syncAreaNative),
        statusText,
        formattedLastSyncTime,
        init,
        login,
        logout,
        setAutoSync,
        upload,
        sync,
        download,
        pullAndApply,
        showLoginDialog,
        cancelPending,
        refreshCrossDevice,
        enableCrossDeviceSync,
        disableCrossDeviceSync,
        restoreFromCrossDevice,
        tryRestoreCrossDevice
    };
}
