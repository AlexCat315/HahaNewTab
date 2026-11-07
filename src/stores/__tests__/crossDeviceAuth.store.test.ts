/**
 * crossDeviceAuth store 测试
 *
 * 服务层（crossDeviceSync.service）在这里整体换成替身：本文件只关心 store 这一层
 * 「状态镜像对不对、推送结果怎么分类、什么情况下不该去碰同步区」。
 * 加密与存储行为由 crossDeviceSync.service.test.ts 覆盖。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

const { service } = vi.hoisted(() => ({
    service: {
        getCrossDeviceStatus: vi.fn(),
        getCrossDeviceState: vi.fn(),
        getStoredPassphrase: vi.fn(),
        enableCrossDevice: vi.fn(),
        disableCrossDevice: vi.fn(),
        pushCrossDeviceAuth: vi.fn(),
        canReadRemoteCrossDeviceAuth: vi.fn(),
        nudgeSyncArea: vi.fn(async () => true),
        clearRemoteCrossDeviceAuth: vi.fn(async () => {}),
        sendSyncAreaProbe: vi.fn(async () => null),
        readIncomingSyncAreaProbe: vi.fn(async () => null),
        restoreCrossDeviceAuth: vi.fn(),
        createRecoveryCode: vi.fn(),
        readRecoveryCode: vi.fn(),
        watchRemoteCrossDeviceAuth: vi.fn(() => () => {})
    }
}));

vi.mock('@/services/crossDeviceSync.service', () => service);
vi.mock('@/services/syncStorage.service', () => ({
    getSyncAreaStatus: () => ({ native: true, kind: 'chrome' })
}));

import { useCrossDeviceAuthStore } from '@/stores/crossDeviceAuth.store';

const AUTH = { token: 'ghp_test', provider: 'github' };

/** 同步区与本机的状态替身 */
function setStatus(overrides: Partial<{
    enabled: boolean;
    hasPassphrase: boolean;
    nativeSync: boolean;
    remoteAvailable: boolean;
    remoteMeta: { updatedAt: number; device: string; provider: string } | null;
}> = {}): void {
    const status = {
        enabled: true,
        hasPassphrase: true,
        nativeSync: true,
        remoteAvailable: false,
        remoteMeta: null,
        ...overrides
    };
    service.getCrossDeviceStatus.mockResolvedValue(status);
    service.getCrossDeviceState.mockResolvedValue({
        enabled: status.enabled,
        hasPassphrase: status.hasPassphrase
    });
}

describe('crossDeviceAuth store', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        vi.clearAllMocks();
        setStatus();
        service.getStoredPassphrase.mockResolvedValue('my-sync-pass');
        service.enableCrossDevice.mockResolvedValue({ pushed: true });
        service.pushCrossDeviceAuth.mockResolvedValue(true);
        service.canReadRemoteCrossDeviceAuth.mockResolvedValue(true);
        service.restoreCrossDeviceAuth.mockResolvedValue(null);
    });

    it('refresh 把同步区与本机的状态抄成界面镜像', async () => {
        const store = useCrossDeviceAuthStore();
        setStatus({
            remoteAvailable: true,
            remoteMeta: { updatedAt: 123, device: 'Chrome / macOS', provider: 'github' }
        });

        await store.refresh();

        expect(store.enabled).toBe(true);
        expect(store.hasPassphrase).toBe(true);
        expect(store.remoteAvailable).toBe(true);
        expect(store.remoteMeta?.device).toBe('Chrome / macOS');
        expect(store.syncAreaNative).toBe(true);
    });

    it('读取状态失败时保持原样，只留一句日志', async () => {
        const store = useCrossDeviceAuthStore();
        setStatus({ remoteAvailable: true });
        await store.refresh();
        expect(store.remoteAvailable).toBe(true);

        service.getCrossDeviceStatus.mockRejectedValueOnce(new Error('sync area unavailable'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await store.refresh();

        expect(store.remoteAvailable).toBe(true);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    it('没开浏览器同步时推送直接判定为「不用打扰任何人」', async () => {
        const store = useCrossDeviceAuthStore();
        service.getCrossDeviceState.mockResolvedValueOnce({ enabled: false, hasPassphrase: false });

        expect(await store.push(AUTH)).toEqual({ enabled: false, pushed: false });
        expect(service.pushCrossDeviceAuth).not.toHaveBeenCalled();
    });

    it('开着且写成功', async () => {
        const store = useCrossDeviceAuthStore();
        expect(await store.push(AUTH)).toEqual({ enabled: true, pushed: true });
        expect(service.pushCrossDeviceAuth).toHaveBeenCalledWith(AUTH);
    });

    it('开着但没写进去：本机口令丢了与同步区不可用要分两种原因', async () => {
        const store = useCrossDeviceAuthStore();
        service.pushCrossDeviceAuth.mockResolvedValue(false);

        expect(await store.push(AUTH).then(r => r.reason)).toBe('sync-area-unavailable');

        setStatus({ hasPassphrase: false });
        expect(await store.push(AUTH).then(r => r.reason)).toBe('missing-passphrase');
    });

    it('本机没有凭据时推送只报「没有可推的」，绝不碰同步区', async () => {
        const store = useCrossDeviceAuthStore();

        expect(await store.push(null)).toEqual({
            enabled: true,
            pushed: false,
            reason: 'no-local-auth'
        });
        expect(service.pushCrossDeviceAuth).not.toHaveBeenCalled();
        expect(service.clearRemoteCrossDeviceAuth).not.toHaveBeenCalled();
    });

    it('clearRemote 是唯一由 store 发起的清除，且清完重新对账', async () => {
        const store = useCrossDeviceAuthStore();
        setStatus({ remoteAvailable: true });
        await store.refresh();
        expect(store.remoteAvailable).toBe(true);

        // 清完之后同步区已经空了：镜像必须跟着重新读一次，否则界面还挂着「凭据：有」
        setStatus({ remoteAvailable: false });
        await store.clearRemote();

        expect(service.clearRemoteCrossDeviceAuth).toHaveBeenCalled();
        expect(store.remoteAvailable).toBe(false);
    });

    it('推送抛错时把原始信息一起交出，措辞由调用方决定', async () => {
        const store = useCrossDeviceAuthStore();
        service.pushCrossDeviceAuth.mockRejectedValue(new Error('quota'));

        expect(await store.push(AUTH)).toEqual({
            enabled: true,
            pushed: false,
            reason: 'error',
            message: 'quota'
        });
    });

    it('enable 记下口令并刷新状态', async () => {
        const store = useCrossDeviceAuthStore();
        const result = await store.enable('my-sync-pass', AUTH);

        expect(service.enableCrossDevice).toHaveBeenCalledWith('my-sync-pass', AUTH);
        expect(result.pushed).toBe(true);
        expect(store.enabled).toBe(true);
    });

    it('disable 清掉本机与同步区再刷新', async () => {
        const store = useCrossDeviceAuthStore();
        setStatus({ remoteAvailable: true });
        await store.refresh();

        await store.disable();

        expect(service.disableCrossDevice).toHaveBeenCalled();
        expect(store.remoteAvailable).toBe(true); // 刷新时拿到的仍是同一份替身状态
        expect(service.getCrossDeviceStatus).toHaveBeenCalledTimes(2);
    });

    it('readAuth 交出凭据并把平台标识收窄，口令不对时原样抛出', async () => {
        const store = useCrossDeviceAuthStore();
        service.restoreCrossDeviceAuth.mockResolvedValue({ token: 'ghp_recovered', provider: 'gitee' });

        expect(await store.readAuth('my-sync-pass')).toEqual({
            token: 'ghp_recovered',
            provider: 'gitee'
        });

        service.restoreCrossDeviceAuth.mockRejectedValue(new Error('同步密码不正确，无法解密'));
        await expect(store.readAuth('wrong-pass')).rejects.toThrow('同步密码不正确');
    });

    it('同步区是空的：免打扰版不去解密，直接回 null', async () => {
        const store = useCrossDeviceAuthStore();
        setStatus({ remoteAvailable: false });
        await store.refresh();

        expect(await store.tryReadAuth()).toBeNull();
        expect(service.restoreCrossDeviceAuth).not.toHaveBeenCalled();
    });

    it('本机没存口令：免打扰版同样不动同步区', async () => {
        const store = useCrossDeviceAuthStore();
        setStatus({ remoteAvailable: true });
        await store.refresh();
        service.getStoredPassphrase.mockResolvedValue(null);

        expect(await store.tryReadAuth()).toBeNull();
        expect(service.restoreCrossDeviceAuth).not.toHaveBeenCalled();
    });

    it('免打扰版遇到口令不匹配只回 null：另一台设备用了别的密码不是故障', async () => {
        const store = useCrossDeviceAuthStore();
        setStatus({ remoteAvailable: true });
        await store.refresh();
        service.restoreCrossDeviceAuth.mockRejectedValue(new Error('同步密码不正确，无法解密'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        expect(await store.tryReadAuth()).toBeNull();
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    it('指定的口令优先于本机保存的', async () => {
        const store = useCrossDeviceAuthStore();
        setStatus({ remoteAvailable: true });
        await store.refresh();
        service.restoreCrossDeviceAuth.mockResolvedValue({ token: 'ghp_x', provider: 'github' });

        await store.tryReadAuth('just-typed');

        expect(service.restoreCrossDeviceAuth).toHaveBeenCalledWith('just-typed');
        expect(service.getStoredPassphrase).not.toHaveBeenCalled();
    });

    /**
     * 补推（自愈）
     *
     * 「已开启 + 已登录 + 同步区是空的」是上一次写入失败的残留状态，
     * 启动与重新检查各补一次；其余组合一律不该碰同步区。
     */
    it('补推：只在同步区还空着的时候写一次', async () => {
        const store = useCrossDeviceAuthStore();
        setStatus({ remoteAvailable: false });
        await store.refresh();

        expect(await store.pushIfMissing(AUTH)).toEqual({ enabled: true, pushed: true });
        expect(service.pushCrossDeviceAuth).toHaveBeenCalledTimes(1);
    });

    it('补推：同步区里那份本机解得开，就什么都不做，别把别人的凭据顶掉', async () => {
        const store = useCrossDeviceAuthStore();
        setStatus({ remoteAvailable: true });
        service.canReadRemoteCrossDeviceAuth.mockResolvedValue(true);
        await store.refresh();

        expect(await store.pushIfMissing(AUTH)).toEqual({ enabled: true, pushed: true });
        expect(service.pushCrossDeviceAuth).not.toHaveBeenCalled();
    });

    it('补推：同步区里那份解不开（别的密码推的）就用自己的覆盖，否则永远卡死', async () => {
        const store = useCrossDeviceAuthStore();
        setStatus({ remoteAvailable: true });
        service.canReadRemoteCrossDeviceAuth.mockResolvedValue(false);
        await store.refresh();

        expect(await store.pushIfMissing(AUTH)).toEqual({ enabled: true, pushed: true });
        expect(service.pushCrossDeviceAuth).toHaveBeenCalledWith(AUTH);
    });

    it('nudge 直接交给服务层催同步', async () => {
        const store = useCrossDeviceAuthStore();
        await expect(store.nudge()).resolves.toBe(true);
        expect(service.nudgeSyncArea).toHaveBeenCalledTimes(1);
    });

    it('补推：没登录、没开启，都不该去碰同步区', async () => {
        const store = useCrossDeviceAuthStore();
        await store.refresh();

        expect(await store.pushIfMissing(null)).toEqual({ enabled: true, pushed: false });

        setStatus({ enabled: false });
        await store.refresh();
        expect(await store.pushIfMissing(AUTH)).toEqual({ enabled: false, pushed: false });
        expect(service.pushCrossDeviceAuth).not.toHaveBeenCalled();
    });

    it('恢复码：导出的就是服务层算出来的那一串', async () => {
        const store = useCrossDeviceAuthStore();
        service.createRecoveryCode.mockResolvedValue('HANTAB1.abc');

        expect(await store.createRecovery('my-sync-pass', AUTH)).toBe('HANTAB1.abc');
        expect(service.createRecoveryCode).toHaveBeenCalledWith(AUTH, 'my-sync-pass');
    });

    it('恢复码：读出来的凭据带平台标识，并顺带刷新同步区状态', async () => {
        const store = useCrossDeviceAuthStore();
        service.readRecoveryCode.mockResolvedValue({ token: 'ghp_from_code', provider: 'gitee' });

        const auth = await store.restoreWithRecovery('HANTAB1.abc', 'my-sync-pass');

        expect(auth).toEqual({ token: 'ghp_from_code', provider: 'gitee' });
        expect(service.getCrossDeviceStatus).toHaveBeenCalled();
    });

    it('恢复码：口令不对时把原因原样交上去，让用户看到', async () => {
        const store = useCrossDeviceAuthStore();
        service.readRecoveryCode.mockRejectedValue(new Error('同步密码不正确，无法解密'));

        await expect(store.restoreWithRecovery('HANTAB1.abc', 'wrong')).rejects.toThrow('同步密码不正确');
    });
});
