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
        restoreCrossDeviceAuth: vi.fn(),
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
});
