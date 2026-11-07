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
import type { CrossDeviceRemoteMeta, SyncAreaProbe } from '@/services/crossDeviceSync.service';
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
    /** 同步区是否能真的把凭据送到别的设备（Chrome 开发版安装为 false） */
    syncAreaCrossDevice: ComputedRef<boolean>;
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
    /** 手动把当前凭据补写进同步区，返回是否写成 */
    retryCrossDevicePush: () => Promise<boolean>;
    /** 同步区里最近一次「别的设备」发来的连通性探测 */
    crossDeviceRemoteProbe: ComputedRef<SyncAreaProbe | null>;
    /** 往同步区发一次探测，让另一台设备能确认这条路通不通 */
    probeCrossDeviceSyncArea: () => Promise<SyncAreaProbe>;
    /** 导出不依赖浏览器同步区的恢复码（口令缺省用本机保存的） */
    exportRecoveryCode: (passphrase?: string) => Promise<string>;
    /** 用恢复码 + 同步密码恢复登录，返回是否成功 */
    restoreFromRecoveryCode: (code: string, passphrase: string) => Promise<boolean>;
}

/**
 * 未登录设备定期看一眼同步区的间隔
 *
 * Firefox Sync 自己就是每 10 分钟一趟，凭据落地时 onChanged 不一定及时通知到页面；
 * 这个轮询只负责「到了就认出来」，不能让 Firefox 的快照来得更早。
 */
const REMOTE_CREDENTIAL_POLL_MS = 30_000;

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
    let credentialPollTimer: ReturnType<typeof setInterval> | null = null;

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

    async function retryCrossDevicePush(): Promise<boolean> {
        return createAbortable(() => store.retryCrossDevicePush());
    }

    async function probeCrossDeviceSyncArea(): Promise<SyncAreaProbe> {
        return createAbortable(() => store.probeCrossDeviceSyncArea());
    }

    async function exportRecoveryCode(passphrase?: string): Promise<string> {
        return createAbortable(() => store.exportRecoveryCode(passphrase));
    }

    async function restoreFromRecoveryCode(code: string, passphrase: string): Promise<boolean> {
        return createAbortable(() => store.restoreFromRecoveryCode(code, passphrase));
    }

    /** 防止定时检查与 focus / 同步区变更同时触发两次还原 */
    let checkingRemoteCredential = false;

    /**
     * 未登录时看一眼同步区：有凭据且本机有口令就尝试还原
     *
     * 只做免打扰的检查：失败不弹提示，状态与原因由面板上的「重新检查」负责说清楚。
     */
    async function checkRemoteCredential(): Promise<void> {
        if (checkingRemoteCredential || store.isLoggedIn || document.visibilityState === 'hidden') {
            return;
        }
        checkingRemoteCredential = true;
        try {
            await refreshCrossDevice();
            if (
                store.isLoggedIn
                || !crossDevice.enabled
                || !crossDevice.hasPassphrase
                || !crossDevice.remoteAvailable
            ) {
                return;
            }
            await tryRestoreCrossDevice();
        } catch {
            // 定期检查失败不打扰：恢复成功会有登录提示，其余交给手动「重新检查」
        } finally {
            checkingRemoteCredential = false;
        }
    }

    function handlePageVisible(): void {
        if (document.visibilityState === 'visible') {
            void checkRemoteCredential();
        }
    }

    function startRemoteCredentialWatch(): void {
        credentialPollTimer = setInterval(() => {
            void checkRemoteCredential();
        }, REMOTE_CREDENTIAL_POLL_MS);
        document.addEventListener('visibilitychange', handlePageVisible);
        window.addEventListener('focus', handlePageVisible);
    }

    function stopRemoteCredentialWatch(): void {
        if (credentialPollTimer !== null) {
            clearInterval(credentialPollTimer);
            credentialPollTimer = null;
        }
        document.removeEventListener('visibilitychange', handlePageVisible);
        window.removeEventListener('focus', handlePageVisible);
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
        // Firefox 的同步快照可能晚到十来分钟，落地那一刻本页要能自己认出来
        startRemoteCredentialWatch();
        init().catch(() => {
            // 初始化失败由 store.error 暴露，不在此处抛出
        });
    });

    onUnmounted(() => {
        store.stopAutoSyncWatch();
        unwatchRemoteAuth?.();
        unwatchRemoteAuth = null;
        stopRemoteCredentialWatch();
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
        syncAreaCrossDevice: computed(() => crossDevice.syncAreaCrossDevice),
        crossDeviceRemoteProbe: computed(() => crossDevice.remoteProbe),
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
        tryRestoreCrossDevice,
        retryCrossDevicePush,
        probeCrossDeviceSyncArea,
        exportRecoveryCode,
        restoreFromRecoveryCode
    };
}
