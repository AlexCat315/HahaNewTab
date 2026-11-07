/**
 * 浏览器账号同步区（跨设备凭据）Store
 *
 * 只管「换设备 / 重装浏览器时怎么不用重新贴 Token」这一件事的四个问题：
 * 本机开没开、口令还在不在、同步区里有没有别的设备推来的密文、这份密文能不能取回来。
 * 加密、存储键、可用性降级都在 crossDeviceSync.service 里，这里只做状态镜像与操作编排。
 *
 * 取回来的凭据怎么登录、失败怎么说，是云同步 store 的事：这一层不认识 Token 的有效性。
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { getSyncAreaStatus } from '@/services/syncStorage.service';
import {
    createRecoveryCode,
    clearRemoteCrossDeviceAuth,
    disableCrossDevice,
    enableCrossDevice,
    getCrossDeviceState,
    getCrossDeviceStatus,
    getStoredPassphrase,
    pushCrossDeviceAuth,
    readIncomingSyncAreaProbe,
    readRecoveryCode,
    restoreCrossDeviceAuth,
    sendSyncAreaProbe,
    watchRemoteCrossDeviceAuth
} from '@/services/crossDeviceSync.service';
import type {
    CrossDeviceAuth,
    CrossDeviceRemoteMeta,
    EnableCrossDeviceResult,
    SyncAreaProbe
} from '@/services/crossDeviceSync.service';
import type { CloudSyncProviderId } from '@/types/cloudSync.types';

/** 从同步区取回的一份登录凭据 */
export interface RecoveredAuth {
    token: string;
    provider: CloudSyncProviderId;
}

/**
 * 推送结果
 *
 * 「没写进去」要分三种原因说（本机没口令 / 同步区不可用 / 请求出错），
 * 但措辞不归这一层——界面层拿到 reason 自己决定说什么。
 */
export interface CrossDevicePushOutcome {
    /** 本机压根没开浏览器同步：这不是故障，不该打扰任何人 */
    enabled: boolean;
    /** 是否真的写进了同步区 */
    pushed: boolean;
    reason?: 'no-local-auth' | 'missing-passphrase' | 'sync-area-unavailable' | 'error';
    /** reason=error 时随带的原始信息 */
    message?: string;
}

export const useCrossDeviceAuthStore = defineStore('crossDeviceAuth', () => {
    /** 是否启用跨设备同步登录状态 */
    const enabled = ref(false);
    /** 本机是否已保存同步密码 */
    const hasPassphrase = ref(false);
    /** 同步区是否已有其他设备推送的加密凭据 */
    const remoteAvailable = ref(false);
    /** 同步区凭据的元信息（来自哪台设备、何时推送） */
    const remoteMeta = ref<CrossDeviceRemoteMeta | null>(null);
    /** 当前环境是否使用浏览器账号同步区（false = 网页预览的 localStorage 降级） */
    const syncAreaNative = ref(getSyncAreaStatus().native);
    /**
     * 同步区里的数据是否真的能离开本机
     * Chrome 开发版安装（加载已解压的扩展程序）下 native 仍为 true，但同步区不会上传。
     */
    const syncAreaCrossDevice = ref(getSyncAreaStatus().native);
    /** 同步区里最近一次「别的设备」发来的连通性探测（null = 没收到过） */
    const remoteProbe = ref<SyncAreaProbe | null>(null);

    /** 重新读取同步区与本机的状态 */
    async function refresh(): Promise<void> {
        try {
            const status = await getCrossDeviceStatus();
            enabled.value = status.enabled;
            hasPassphrase.value = status.hasPassphrase;
            remoteAvailable.value = status.remoteAvailable;
            remoteMeta.value = status.remoteMeta;
            syncAreaNative.value = status.nativeSync;
            syncAreaCrossDevice.value = status.syncAreaCrossDevice;
        } catch (e) {
            console.warn('[CrossDevice] 读取浏览器同步状态失败:', e);
        }
        await refreshProbe();
    }

    /**
     * 读一次「别的设备发来的探测」
     *
     * 探测读不到不算故障：同步区为空时它就该是 null，所以这里不抛。
     */
    async function refreshProbe(): Promise<SyncAreaProbe | null> {
        try {
            remoteProbe.value = await readIncomingSyncAreaProbe();
        } catch (e) {
            console.warn('[CrossDevice] 读取同步区探测失败:', e);
            remoteProbe.value = null;
        }
        return remoteProbe.value;
    }

    /** 往同步区写一次探测，供另一台设备确认「这条路到底通不通」 */
    async function probeSyncArea(): Promise<SyncAreaProbe> {
        const probe = await sendSyncAreaProbe();
        await refreshProbe();
        return probe;
    }

    /**
     * 把当前登录凭据写进同步区（未启用时什么都不做）
     *
     * 已开启却没写成功必须让调用方知道，否则用户会以为「浏览器同步已经生效」，
     * 换设备时才发现根本没有凭据。
     *
     * `auth` 为空只表示「这台没有可推的凭据」，不表示「该把同步区清空」：
     * 那里那份可能是别的设备推来的，一次失败的登录不该把它一起带走。
     */
    async function push(auth: CrossDeviceAuth | null): Promise<CrossDevicePushOutcome> {
        try {
            const state = await getCrossDeviceState();
            if (!state.enabled) {
                return { enabled: false, pushed: false };
            }
            if (!auth?.token) {
                return { enabled: true, pushed: false, reason: 'no-local-auth' };
            }
            if (await pushCrossDeviceAuth(auth)) {
                return { enabled: true, pushed: true };
            }
            return {
                enabled: true,
                pushed: false,
                reason: state.hasPassphrase ? 'sync-area-unavailable' : 'missing-passphrase'
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn('[CrossDevice] 浏览器同步失败:', error);
            return { enabled: true, pushed: false, reason: 'error', message };
        }
    }

    /**
     * 补推：只在「已开启 + 已登录 + 同步区里还没有凭据」时真的写一次
     *
     * 推送原先只发生在登录与开启那两个瞬间，那一次失败（同步区当时不可用、
     * 网络抖动、Firefox 还没勾上「附加组件」同步）就再也没人补，界面却一路显示
     * 「已加密写入」。启动与「重新检查」各补一次，把这个洞关上。
     */
    async function pushIfMissing(auth: CrossDeviceAuth | null): Promise<CrossDevicePushOutcome> {
        // 状态镜像可能落后于别的页面刚改过的开关，补推前先看一眼真相
        await refresh();
        if (!enabled.value || !auth?.token) {
            return { enabled: enabled.value, pushed: false };
        }
        if (remoteAvailable.value) {
            return { enabled: true, pushed: true };
        }
        return push(auth);
    }

    /**
     * 清掉同步区里那份共用凭据（本机开关与口令保留）
     *
     * 删除凭据只有两个正当理由：用户主动断开云同步，或用户关掉浏览器同步开关。
     * 所以这一步单独成一个动作，不夹在「推送」的失败分支里。
     */
    async function clearRemote(): Promise<void> {
        await clearRemoteCrossDeviceAuth();
        await refresh();
    }

    /** 本机保存的同步密码（没有则 null）；导出恢复码时默认拿它 */
    function readStoredPassphrase(): Promise<string | null> {
        return getStoredPassphrase();
    }

    /** 生成一份交给用户自己保存的恢复码（不依赖浏览器同步区） */
    async function createRecovery(passphrase: string, auth: CrossDeviceAuth): Promise<string> {
        return createRecoveryCode(auth, passphrase);
    }

    /** 用恢复码 + 同步密码取出凭据；口令与格式问题按原样抛出，这是用户主动操作 */
    async function restoreWithRecovery(
        code: string,
        passphrase: string
    ): Promise<RecoveredAuth | null> {
        const auth = await readRecoveryCode(code, passphrase);
        await refresh();
        return { token: auth.token, provider: auth.provider as CloudSyncProviderId };
    }

    /** 记下口令并开启；带着凭据时顺带推送一次 */
    async function enable(passphrase: string, auth: CrossDeviceAuth | null): Promise<EnableCrossDeviceResult> {
        const result = await enableCrossDevice(passphrase, auth);
        await refresh();
        return result;
    }

    /** 关闭：清除本机口令与同步区密文 */
    async function disable(): Promise<void> {
        await disableCrossDevice();
        await refresh();
    }

    /**
     * 凭口令取出同步区里的凭据
     *
     * @throws 口令不对时抛「同步密码不正确，无法解密」——用户主动输口令时要看到原因
     */
    async function readAuth(passphrase: string): Promise<RecoveredAuth | null> {
        const auth = await restoreCrossDeviceAuth(passphrase);
        await refresh();
        if (!auth) {
            return null;
        }
        return { token: auth.token, provider: auth.provider as CloudSyncProviderId };
    }

    /**
     * 免打扰版：没有可用口令、同步区是空的、口令不匹配，一律只回 null
     *
     * 这是「另一台设备刚把凭据同步过来」时的自动恢复入口：面板打开、同步区变更、
     * 用户点「重新检查」时都会调用，此时密码不对属于正常情况（另一台设备用了别的密码）。
     */
    async function tryReadAuth(passphrase?: string): Promise<RecoveredAuth | null> {
        if (!remoteAvailable.value) {
            return null;
        }
        const password = passphrase ?? (await getStoredPassphrase());
        if (!password) {
            return null;
        }
        try {
            return await readAuth(password);
        } catch (e) {
            console.warn('[CrossDevice] 浏览器同步自动还原失败:', e);
            return null;
        }
    }

    /** 监听其他设备推送的凭据 */
    function watchRemote(listener: () => void): () => void {
        return watchRemoteCrossDeviceAuth(listener);
    }

    return {
        enabled,
        hasPassphrase,
        remoteAvailable,
        remoteMeta,
        syncAreaNative,
        syncAreaCrossDevice,
        remoteProbe,
        refresh,
        refreshProbe,
        probeSyncArea,
        push,
        pushIfMissing,
        clearRemote,
        createRecovery,
        restoreWithRecovery,
        readStoredPassphrase,
        enable,
        disable,
        readAuth,
        tryReadAuth,
        watchRemote
    };
});
