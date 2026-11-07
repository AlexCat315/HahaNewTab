/**
 * crossDeviceSync.service 单元测试
 *
 * 用内存 Map 替换本地存储与浏览器同步区，验证：
 *   - 启用时把凭据加密后推送（同步区里不能出现明文 Token）
 *   - 新设备凭口令还原登录状态
 *   - 登出 / 关闭开关时的清理行为
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { localStore, syncStore } = vi.hoisted(() => ({
    localStore: new Map<string, unknown>(),
    syncStore: new Map<string, unknown>()
}));

vi.mock('@/services/storage.service', () => ({
    storageManager: {
        get: vi.fn(async (key: string) => localStore.get(key) ?? null),
        set: vi.fn(async (key: string, value: unknown) => {
            localStore.set(key, value);
        }),
        setMany: vi.fn(async (items: Record<string, unknown>) => {
            for (const [key, value] of Object.entries(items)) {
                if (value === null || value === undefined) {
                    localStore.delete(key);
                } else {
                    localStore.set(key, value);
                }
            }
        })
    }
}));

vi.mock('@/services/syncStorage.service', () => ({
    syncGet: vi.fn(async (key: string) => syncStore.get(key) ?? null),
    syncSet: vi.fn(async (key: string, value: unknown) => {
        syncStore.set(key, value);
    }),
    syncSetMany: vi.fn(async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) {
            syncStore.set(key, value);
        }
    }),
    syncRemove: vi.fn(async (key: string) => {
        syncStore.delete(key);
    }),
    isNativeSyncStorage: vi.fn(() => false),
    getSyncAreaStatus: vi.fn(() => ({ native: false, kind: 'local' })),
    subscribeSyncAreaChanges: vi.fn(() => () => {})
}));

import {
    enableCrossDevice,
    disableCrossDevice,
    restoreCrossDeviceAuth,
    pushCrossDeviceAuth,
    pullCrossDeviceAuth,
    getCrossDeviceState,
    getCrossDeviceStatus,
    hasRemoteCrossDeviceAuth,
    clearRemoteCrossDeviceAuth,
    createRecoveryCode,
    readRecoveryCode,
    sendSyncAreaProbe,
    readIncomingSyncAreaProbe,
    canReadRemoteCrossDeviceAuth,
    nudgeSyncArea
} from '../crossDeviceSync.service';
import { getSyncAreaStatus, syncSetMany } from '@/services/syncStorage.service';

const REMOTE_AUTH_KEY = 'haha_cross_device_auth';
const LOCAL_PASSPHRASE_KEY = 'appNavigator_crossDevice_passphrase';

const AUTH = { token: 'ghp_cross_device_token_123', provider: 'github' };
const PASSPHRASE = 'my-sync-passphrase';

describe('crossDeviceSync.service', () => {
    beforeEach(() => {
        localStore.clear();
        syncStore.clear();
        vi.clearAllMocks();
        vi.mocked(getSyncAreaStatus).mockReturnValue({ native: false, kind: 'local' });
    });

    afterEach(() => {
        delete (window as unknown as { chrome?: unknown }).chrome;
        delete (window as unknown as { browser?: unknown }).browser;
    });

    it('初始状态为未启用', async () => {
        await expect(getCrossDeviceState()).resolves.toEqual({ enabled: false, hasPassphrase: false });
        await expect(hasRemoteCrossDeviceAuth()).resolves.toBe(false);
    });

    it('启用后保存开关与口令，并把密文写入同步区', async () => {
        await enableCrossDevice(PASSPHRASE, AUTH);

        await expect(getCrossDeviceState()).resolves.toEqual({ enabled: true, hasPassphrase: true });
        expect(localStore.get(LOCAL_PASSPHRASE_KEY)).toBe(PASSPHRASE);

        const remote = syncStore.get(REMOTE_AUTH_KEY) as Record<string, unknown>;
        expect(remote).toBeTruthy();
        expect(remote.alg).toBe('AES-GCM');
        // 同步区里不能出现明文 Token
        expect(JSON.stringify(remote)).not.toContain(AUTH.token);
        await expect(hasRemoteCrossDeviceAuth()).resolves.toBe(true);
    });

    it('口令过短时拒绝启用', async () => {
        await expect(enableCrossDevice('123', AUTH)).rejects.toThrow('同步密码至少');
        await expect(getCrossDeviceState()).resolves.toEqual({ enabled: false, hasPassphrase: false });
    });

    it('未登录时启用不会清掉同步区已有密文', async () => {
        await enableCrossDevice(PASSPHRASE, AUTH);
        const before = syncStore.get(REMOTE_AUTH_KEY);
        expect(before).toBeTruthy();

        // 模拟新设备：本机没有 Token，只输入了同一口令
        localStore.clear();
        await enableCrossDevice(PASSPHRASE, null);

        expect(syncStore.get(REMOTE_AUTH_KEY)).toEqual(before);
    });

    it('关闭后清除开关、口令与同步区密文', async () => {
        await enableCrossDevice(PASSPHRASE, AUTH);
        await disableCrossDevice();

        await expect(getCrossDeviceState()).resolves.toEqual({ enabled: false, hasPassphrase: false });
        expect(syncStore.has(REMOTE_AUTH_KEY)).toBe(false);
        await expect(hasRemoteCrossDeviceAuth()).resolves.toBe(false);
    });

    it('新设备用正确口令可还原登录状态', async () => {
        await enableCrossDevice(PASSPHRASE, AUTH);

        // 模拟另一台设备：只有同步区的密文，没有本地口令
        localStore.clear();

        const restored = await restoreCrossDeviceAuth(PASSPHRASE);
        expect(restored).toEqual({ token: AUTH.token, provider: 'github' });
        // 还原成功后本机会记住开关与口令，便于后续自动推送
        await expect(getCrossDeviceState()).resolves.toEqual({ enabled: true, hasPassphrase: true });
    });

    it('新设备口令错误时抛出可读错误', async () => {
        await enableCrossDevice(PASSPHRASE, AUTH);
        localStore.clear();

        await expect(restoreCrossDeviceAuth('wrong-passphrase')).rejects.toThrow('同步密码不正确');
    });

    it('同步区没有密文时还原返回 null', async () => {
        await expect(restoreCrossDeviceAuth(PASSPHRASE)).resolves.toBeNull();
    });

    it('未启用时推送不写入同步区', async () => {
        await pushCrossDeviceAuth(AUTH);
        expect(syncStore.has(REMOTE_AUTH_KEY)).toBe(false);
    });

    it('推送空凭据不再清掉同步区密文：一次失败的登录不该带走共用凭据', async () => {
        await enableCrossDevice(PASSPHRASE, AUTH);
        const before = syncStore.get(REMOTE_AUTH_KEY);

        await expect(pushCrossDeviceAuth(null)).resolves.toBe(false);
        expect(syncStore.get(REMOTE_AUTH_KEY)).toBe(before);
    });

    it('clearRemoteCrossDeviceAuth 才是清掉同步区密文的那一步', async () => {
        await enableCrossDevice(PASSPHRASE, AUTH);
        expect(syncStore.has(REMOTE_AUTH_KEY)).toBe(true);

        await clearRemoteCrossDeviceAuth();
        expect(syncStore.has(REMOTE_AUTH_KEY)).toBe(false);
    });

    it('pullCrossDeviceAuth 在启用且口令可用时还原凭据', async () => {
        await enableCrossDevice(PASSPHRASE, AUTH);

        await expect(pullCrossDeviceAuth()).resolves.toEqual({ token: AUTH.token, provider: 'github' });
    });

    it('pullCrossDeviceAuth 在未启用时返回 null', async () => {
        await expect(pullCrossDeviceAuth()).resolves.toBeNull();
    });

    it('口令丢失（本地数据被清）时 pullCrossDeviceAuth 返回 null', async () => {
        await enableCrossDevice(PASSPHRASE, AUTH);
        localStore.delete(LOCAL_PASSPHRASE_KEY);

        await expect(pullCrossDeviceAuth()).resolves.toBeNull();
    });

    it('已登录时启用会立即推送，返回 pushed=true', async () => {
        const result = await enableCrossDevice(PASSPHRASE, AUTH);

        expect(result.pushed).toBe(true);
        expect(syncStore.has(REMOTE_AUTH_KEY)).toBe(true);
    });

    it('未登录时启用只保存开关与口令，返回 pushed=false（登录后补推）', async () => {
        const result = await enableCrossDevice(PASSPHRASE, null);

        expect(result.pushed).toBe(false);
        expect(syncStore.has(REMOTE_AUTH_KEY)).toBe(false);
        await expect(getCrossDeviceState()).resolves.toEqual({ enabled: true, hasPassphrase: true });
    });

    it('未登录先设密码、登录后 pushCrossDeviceAuth 能补推凭据', async () => {
        await enableCrossDevice(PASSPHRASE, null);
        expect(syncStore.has(REMOTE_AUTH_KEY)).toBe(false);

        // 模拟登录成功后 CloudSyncService 调用补推
        await expect(pushCrossDeviceAuth(AUTH)).resolves.toBe(true);
        expect(syncStore.has(REMOTE_AUTH_KEY)).toBe(true);
    });

    it('缺口令时 pushCrossDeviceAuth 返回 false 且不写同步区', async () => {
        await enableCrossDevice(PASSPHRASE, null);
        localStore.delete(LOCAL_PASSPHRASE_KEY);

        await expect(pushCrossDeviceAuth(AUTH)).resolves.toBe(false);
        expect(syncStore.has(REMOTE_AUTH_KEY)).toBe(false);
    });

    it('getCrossDeviceStatus 汇总开关、口令与远端密文状态', async () => {
        await expect(getCrossDeviceStatus()).resolves.toEqual({
            enabled: false,
            hasPassphrase: false,
            nativeSync: false,
            remoteAvailable: false,
            remoteMeta: null
        });

        await enableCrossDevice(PASSPHRASE, AUTH);
        const status = await getCrossDeviceStatus();
        expect(status.enabled).toBe(true);
        expect(status.hasPassphrase).toBe(true);
        expect(status.remoteAvailable).toBe(true);
        // 元信息用于界面显示「凭据来自哪台设备、何时推送」
        expect(status.remoteMeta?.provider).toBe('github');
        expect(typeof status.remoteMeta?.device).toBe('string');
        expect(status.remoteMeta?.updatedAt).toBeGreaterThan(0);
    });

    it('推送时写入元信息，关闭时一并清除', async () => {
        await enableCrossDevice(PASSPHRASE, AUTH);
        expect(syncStore.has('haha_cross_device_auth_meta')).toBe(true);

        await disableCrossDevice();
        expect(syncStore.has('haha_cross_device_auth_meta')).toBe(false);
    });

    it('密文与元信息作为一次写入进同步区，不会只到一半', async () => {
        await enableCrossDevice(PASSPHRASE, AUTH);

        expect(vi.mocked(syncSetMany)).toHaveBeenCalledTimes(1);
        const [items] = vi.mocked(syncSetMany).mock.calls[0];
        expect(Object.keys(items).sort()).toEqual(
            [REMOTE_AUTH_KEY, 'haha_cross_device_auth_meta'].sort()
        );
    });

    /**
     * 同步区自检
     *
     * 自检读得出、凭据读不出，就是「路通、凭据没推上来」；两个都读不出，才是路不通。
     * ID 与版本一起写进去，两台设备的差异可以直接比对，不必靠猜。
     */
    it('同步区自检带上扩展 ID 与版本', async () => {
        vi.mocked(getSyncAreaStatus).mockReturnValue({ native: true, kind: 'native' });
        (window as unknown as { chrome: unknown }).chrome = {
            runtime: {
                id: 'lpaaldonlnldlkaghoealdcbiafljagb',
                getManifest: () => ({ version: '1.0.1.20' })
            }
        };

        const probe = await sendSyncAreaProbe();

        expect(probe.extensionId).toBe('lpaaldonlnldlkaghoealdcbiafljagb');
        expect(probe.version).toBe('1.0.1.20');
        expect(syncStore.get('haha_cross_device_probe')).toMatchObject({ nonce: probe.nonce });
    });

    it('旧版自检没有版本字段也能读，不因缺字段丢掉整条记录', async () => {
        vi.mocked(getSyncAreaStatus).mockReturnValue({ native: true, kind: 'native' });
        syncStore.set('haha_cross_device_probe', {
            device: 'Chrome · Windows',
            extensionId: 'lpaaldonlnldlkaghoealdcbiafljagb',
            updatedAt: 123,
            nonce: 'from-other-device'
        });

        await expect(readIncomingSyncAreaProbe()).resolves.toEqual({
            device: 'Chrome · Windows',
            extensionId: 'lpaaldonlnldlkaghoealdcbiafljagb',
            version: '',
            updatedAt: 123,
            nonce: 'from-other-device'
        });
    });

    /**
     * 催促同步
     *
     * Firefox 的调度器在本地写入后立刻安排一轮同步（score 更新延迟 100ms），
     * 「催」就是写一个每次都不同的值，让等待中的设备主动把远端凭据拉下来。
     */
    it('催促写入同步区，且每次的值都不同', async () => {
        vi.mocked(getSyncAreaStatus).mockReturnValue({ native: true, kind: 'native' });

        await expect(nudgeSyncArea()).resolves.toBe(true);
        const first = syncStore.get('haha_cross_device_nudge') as { nonce: string };

        await expect(nudgeSyncArea()).resolves.toBe(true);
        const second = syncStore.get('haha_cross_device_nudge') as { nonce: string };

        expect(first.nonce).toBeTruthy();
        expect(second.nonce).not.toBe(first.nonce);
    });

    it('网页预览环境没有同步区可催，直接返回 false', async () => {
        vi.mocked(getSyncAreaStatus).mockReturnValue({ native: false, kind: 'local' });
        await expect(nudgeSyncArea()).resolves.toBe(false);
        expect(syncStore.has('haha_cross_device_nudge')).toBe(false);
    });

    /**
     * 「同步区里有密文」与「本机解得开」是两件事：另一台用别的密码推的那份，
     * 本机永远解不开，补推逻辑必须据此覆盖，否则所有设备都会卡在「已经有了」。
     */
    it('能判断同步区里的凭据本机是否解得开', async () => {
        await expect(canReadRemoteCrossDeviceAuth()).resolves.toBe(false);

        await enableCrossDevice(PASSPHRASE, AUTH);
        await expect(canReadRemoteCrossDeviceAuth()).resolves.toBe(true);

        localStore.set(LOCAL_PASSPHRASE_KEY, 'another-passphrase');
        await expect(canReadRemoteCrossDeviceAuth()).resolves.toBe(false);
    });

    it('clearRemoteCrossDeviceAuth 只清远端密文，保留本机开关', async () => {
        await enableCrossDevice(PASSPHRASE, AUTH);
        await clearRemoteCrossDeviceAuth();

        expect(syncStore.has(REMOTE_AUTH_KEY)).toBe(false);
        await expect(getCrossDeviceState()).resolves.toEqual({ enabled: true, hasPassphrase: true });
    });

    /**
     * 恢复码
     *
     * 卸载扩展会把 storage.local 与按扩展 ID 隔离的 storage.sync 一起清掉，
     * 同步区那条路只覆盖「设备还在、扩展没重装」；恢复码是交给用户自己保管的那一份，
     * 因此它必须能独立解出凭据，且不落任何浏览器存储。
     */
    it('恢复码能原样解出凭据，并把口令记回本机（之后补推才有的可用）', async () => {
        const code = await createRecoveryCode(AUTH, PASSPHRASE);

        expect(code.startsWith('HANTAB1.')).toBe(true);
        expect(await readRecoveryCode(code, PASSPHRASE)).toEqual(AUTH);
        await expect(getCrossDeviceState()).resolves.toEqual({ enabled: true, hasPassphrase: true });
        // 恢复码本身不落任何存储：它只是同一份密文的另一种交付方式
        expect(syncStore.size).toBe(0);
        for (const value of localStore.values()) {
            expect(String(value)).not.toContain('HANTAB1.');
        }
    });

    it('恢复码里没有明文 Token', async () => {
        const code = await createRecoveryCode(AUTH, PASSPHRASE);
        expect(code).not.toContain(AUTH.token);
    });

    it('恢复码口令不对时给出可直接念的原因', async () => {
        const code = await createRecoveryCode(AUTH, PASSPHRASE);
        await expect(readRecoveryCode(code, 'wrong-passphrase')).rejects.toThrow('同步密码不正确');
    });

    it('恢复码被截断或粘错时不报「口令不对」，报格式', async () => {
        const code = await createRecoveryCode(AUTH, PASSPHRASE);
        await expect(readRecoveryCode(code.slice(10), PASSPHRASE))
            .rejects.toThrow('恢复码格式不正确，请整段复制');
        await expect(readRecoveryCode('HANTAB1.@@@not-base64@@@', PASSPHRASE))
            .rejects.toThrow('恢复码格式不正确，请整段复制');
    });

    it('恢复码口令过短在加密前就拒绝', async () => {
        await expect(createRecoveryCode(AUTH, '123')).rejects.toThrow('同步密码至少 6 位');
    });
});
