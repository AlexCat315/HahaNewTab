/**
 * 云同步 Composable
 * 把 cloudSync store 包成面板要的那一份接口，并处理副作用清理：
 * 本地数据变更监听、未完成的异步操作。
 */

import { computed, onMounted, onUnmounted } from 'vue';
import type { ComputedRef } from 'vue';
import { useCloudSyncStore } from '@/stores/cloudSync.store';
import type {
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
    autoSync: ComputedRef<boolean>;
    userInfo: ComputedRef<GitHubUserInfo | null>;
    lastSyncTime: ComputedRef<number>;
    isLoading: ComputedRef<boolean>;
    error: ComputedRef<string | null>;
    isLoggedIn: ComputedRef<boolean>;
    statusText: ComputedRef<string>;
    formattedLastSyncTime: ComputedRef<string>;
    init: () => Promise<void>;
    /** 保存 OAuth 授权换到的 access_token */
    login: (accessToken: string) => Promise<boolean>;
    logout: () => Promise<void>;
    setAutoSync: (enabled: boolean) => Promise<void>;
    upload: (options?: { silent?: boolean }) => Promise<UploadResult>;
    sync: (options?: { silent?: boolean }) => Promise<SyncResult>;
    download: () => Promise<DownloadResult>;
    pullAndApply: (options?: { force?: boolean; silent?: boolean }) => Promise<PullResult>;
    cancelPending: () => void;
}

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
    const { uiAdapter } = options;

    const abortControllers = createAbortControllerSet();

    if (uiAdapter) {
        store.setUIAdapter(uiAdapter);
    }

    const isLoggedIn = computed(() => store.isLoggedIn);

    const statusText = computed(() => {
        if (store.isLoading) {
            return '同步中...';
        }
        if (store.isLoggedIn && store.userInfo) {
            return `已连接：GitHub / ${store.userInfo.login}`;
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

    async function login(accessToken: string): Promise<boolean> {
        return createAbortable(() => store.login(accessToken));
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

    onMounted(() => {
        // 本地数据一落盘就防抖触发自动同步；变更源是存储内核，覆盖所有写入路径
        store.startAutoSyncWatch();
        init().catch(() => {
            // 初始化失败由 store.error 暴露，不在此处抛出
        });
    });

    onUnmounted(() => {
        store.stopAutoSyncWatch();
        cancelPending();
    });

    return {
        token: computed(() => store.token),
        gistId: computed(() => store.gistId),
        autoSync: computed(() => store.autoSync),
        userInfo: computed(() => store.userInfo),
        lastSyncTime: computed(() => store.lastSyncTime),
        isLoading: computed(() => store.isLoading),
        error: computed(() => store.error),
        isLoggedIn,
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
        cancelPending
    };
}
