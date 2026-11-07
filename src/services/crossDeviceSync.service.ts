/**
 * 跨设备登录状态同步（浏览器同步）
 *
 * 把云同步的登录凭据（Token + 平台）用用户口令加密后写入 storage.sync，
 * 登录同一浏览器账号的其他设备可解密还原，无需重新输入 Token。
 *
 * 典型两条路径：
 *   A. 先登录再开启：勾选「浏览器同步」→ 输入同步密码 → 立即把凭据加密推送；
 *   B. 先开启再登录：未登录时只保存开关与口令（不写同步区），登录成功后
 *      CloudSyncService.saveToken() 会把凭据补推到同步区。
 * 两条路径都必须能跑通——早期实现只支持 A，导致「先设密码」的用户永远推不上去。
 *
 * 安全边界：
 *   - 落到同步区的永远是密文（AES-GCM），浏览器账号里看不到明文 Token；
 *   - 口令本身只存在本机 storage.local，不上传；
 *   - 本机本来就存着明文 Token，因此口令不落盘并不会带来额外风险，
 *     这里选择落盘换取「无需每次输入口令」的体验。
 */

import { storageManager } from '@/services/storage.service';
import { STORAGE_KEYS } from '@/types/storage';
import {
    syncGet,
    syncSet,
    syncSetMany,
    syncRemove,
    getSyncAreaStatus,
    subscribeSyncAreaChanges
} from '@/services/syncStorage.service';
import {
    encryptText,
    decryptText,
    isEncryptedPayload,
    MIN_PASSPHRASE_LENGTH
} from '@/utils/crypto.util';
import type { EncryptedPayload } from '@/utils/crypto.util';

/** 本机：是否启用跨设备同步 */
const LOCAL_ENABLED_KEY = STORAGE_KEYS.CROSS_DEVICE_ENABLED;
/** 本机：加密口令（不上传） */
const LOCAL_PASSPHRASE_KEY = STORAGE_KEYS.CROSS_DEVICE_PASSPHRASE;
/** 同步区：加密后的登录凭据 */
export const REMOTE_AUTH_KEY = STORAGE_KEYS.CROSS_DEVICE_REMOTE_AUTH;
/** 同步区：凭据元信息（明文，只含设备名与时间，不含 Token） */
export const REMOTE_META_KEY = STORAGE_KEYS.CROSS_DEVICE_REMOTE_META;
/** 同步区：连通性探测 */
export const REMOTE_PROBE_KEY = STORAGE_KEYS.CROSS_DEVICE_REMOTE_PROBE;
/** 本机：最后一次自己发出的探测标识 */
const LOCAL_PROBE_KEY = STORAGE_KEYS.CROSS_DEVICE_LOCAL_PROBE;

/** 需要跨设备同步的登录凭据 */
export interface CrossDeviceAuth {
    /** 平台 Token */
    token: string;
    /** 平台标识：github / gitee */
    provider: string;
}

/**
 * 同步区连通性探测
 *
 * 「凭据：暂无」这句话有两种完全不同的成因，光看它分不出来：
 *   A. 另一台设备压根没写进同步区；
 *   B. 写进去了，但浏览器没把它送到这台（没勾「附加组件」同步、还没到 10 分钟、
 *      或者两台装的是不同扩展 ID 的包——同步区按 ID 隔离，永远看不到对方）。
 * 凭据本身带着口令，B 情况下这台机器读不到就是读不到，说不了更多。
 * 探测是一条与口令无关的明文随机值：任一台写、另一台读，读到就证明这条路是通的。
 */
export interface SyncAreaProbe {
    /** 发起设备 */
    device: string;
    /** 发起设备的扩展 ID：两台不一致就直接解释了「永远收不到」 */
    extensionId: string;
    /** 发起时间 */
    updatedAt: number;
    /** 随机标识，本机靠它认出同步区里那条是不是自己写的 */
    nonce: string;
}

/** 同步区里凭据的元信息，用于界面显示「凭据来自哪台设备、什么时候更新的」 */
export interface CrossDeviceRemoteMeta {
    /** 推送时间戳 */
    updatedAt: number;
    /** 推送设备（浏览器 + 系统，粗粒度） */
    device: string;
    /** 平台标识 */
    provider: string;
}

/** 跨设备同步的当前状态 */
export interface CrossDeviceState {
    /** 是否已启用 */
    enabled: boolean;
    /** 本机是否已保存口令 */
    hasPassphrase: boolean;
}

/** 跨设备同步的完整状态（含同步区可用性与远端是否有密文） */
export interface CrossDeviceStatus extends CrossDeviceState {
    /** 当前环境是否使用浏览器账号同步区（false = 网页预览的 localStorage 降级） */
    nativeSync: boolean;
    /**
     * 写进同步区的东西是否真的会离开这台机器
     *
     * Chrome 只对「从扩展商店安装」的扩展上传 storage.sync，用「加载已解压的扩展程序」
     * 安装的包即使同一个账号、同一个扩展 ID 也只留在本机，而 nativeSync 同样是 true。
     */
    syncAreaCrossDevice: boolean;
    /** 同步区是否已有加密凭据（无需口令即可判断） */
    remoteAvailable: boolean;
    /** 同步区凭据的元信息（来自哪台设备、何时推送） */
    remoteMeta: CrossDeviceRemoteMeta | null;
}

/** 安装方式探测结果 */
interface CrossDeviceInstallInfo {
    /** management.getSelf().installType；浏览器不提供该信息时为 null */
    installType: string | null;
    /** 同步区写入的数据是否会离开本机 */
    crossDevice: boolean;
}

/** 启用结果 */
export interface EnableCrossDeviceResult {
    /** 是否已把凭据写入同步区（未登录时为 false，登录后会自动补推） */
    pushed: boolean;
}

/** 读取当前启用状态 */
export async function getCrossDeviceState(): Promise<CrossDeviceState> {
    const [enabled, passphrase] = await Promise.all([
        storageManager.get(LOCAL_ENABLED_KEY),
        storageManager.get(LOCAL_PASSPHRASE_KEY)
    ]);
    return {
        enabled: enabled === true,
        hasPassphrase: typeof passphrase === 'string' && passphrase.length >= MIN_PASSPHRASE_LENGTH
    };
}

/** 读取本机保存的同步密码（仅本机 storage.local，不上传） */
export async function getStoredPassphrase(): Promise<string | null> {
    const passphrase = await storageManager.get(LOCAL_PASSPHRASE_KEY);
    return typeof passphrase === 'string' && passphrase.length >= MIN_PASSPHRASE_LENGTH
        ? passphrase
        : null;
}

/** 读取同步区凭据的元信息（不存在时返回 null） */
export async function getRemoteCrossDeviceMeta(): Promise<CrossDeviceRemoteMeta | null> {
    const raw = await syncGet(REMOTE_META_KEY);
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const meta = raw as Partial<CrossDeviceRemoteMeta>;
    if (typeof meta.updatedAt !== 'number') {
        return null;
    }
    return {
        updatedAt: meta.updatedAt,
        device: typeof meta.device === 'string' ? meta.device : '未知设备',
        provider: typeof meta.provider === 'string' ? meta.provider : 'github'
    };
}

/**
 * 读本机安装方式，判断同步区能不能真的跨设备
 *
 * Chromium 只给「从扩展商店安装」的扩展同步 storage.sync
 * （sync_helper::IsSyncable 只放行 ManifestLocation::kInternal），
 * 用「加载已解压的扩展程序」装的包写进去的凭据不会离开本机。
 * management.getSelf() 不需要额外权限，且开发版会如实报告 installType = "development"。
 *
 * Firefox 没有这条限制，所以只在非 Gecko 的原生同步区上做这层判定；
 * 探测不到安装方式时保持乐观（沿用 nativeSync 的结论），不凭空报警。
 */
async function detectCrossDeviceInstall(): Promise<CrossDeviceInstallInfo> {
    if (!getSyncAreaStatus().native) {
        return { installType: null, crossDevice: false };
    }
    if (typeof window === 'undefined' || !isChromiumExtension()) {
        return { installType: null, crossDevice: true };
    }
    const installType = await readInstallType();
    return { installType, crossDevice: installType !== 'development' };
}

/** Firefox 同时暴露 browser 与 chrome 命名空间，chrome-only 才是 Chromium 系 */
function isChromiumExtension(): boolean {
    const win = window as unknown as {
        chrome?: { runtime?: { id?: string }; management?: { getSelf?: unknown } };
        browser?: { runtime?: { id?: string } };
    };
    return !win.browser?.runtime?.id && !!win.chrome?.runtime?.id;
}

/** management.getSelf()：Firefox 直接返回 Promise，Chrome 需要回调 */
function readInstallType(): Promise<string | null> {
    const win = window as unknown as {
        chrome?: { management?: { getSelf?: (...args: unknown[]) => unknown } };
        browser?: { management?: { getSelf?: () => Promise<{ installType?: string }> } };
    };
    const pick = (info: { installType?: string } | null | undefined): string | null =>
        typeof info?.installType === 'string' ? info.installType : null;

    if (win.browser?.management?.getSelf) {
        try {
            return win.browser.management.getSelf().then(pick, () => null);
        } catch {
            return Promise.resolve(null);
        }
    }
    const getSelf = win.chrome?.management?.getSelf;
    if (!getSelf) {
        return Promise.resolve(null);
    }
    return new Promise(resolve => {
        try {
            getSelf.call(win.chrome?.management, (info: { installType?: string }) => resolve(pick(info)));
        } catch {
            resolve(null);
        }
    });
}

/** 读取完整状态（含同步区可用性 / 能否跨设备 / 远端密文） */
export async function getCrossDeviceStatus(): Promise<CrossDeviceStatus> {
    const [state, install, remoteAvailable, remoteMeta] = await Promise.all([
        getCrossDeviceState(),
        detectCrossDeviceInstall(),
        hasRemoteCrossDeviceAuth(),
        getRemoteCrossDeviceMeta()
    ]);
    return {
        ...state,
        nativeSync: getSyncAreaStatus().native,
        syncAreaCrossDevice: install.crossDevice,
        remoteAvailable,
        remoteMeta: remoteAvailable ? remoteMeta : null
    };
}

/** 是否已启用跨设备同步 */
export async function isCrossDeviceEnabled(): Promise<boolean> {
    return (await getCrossDeviceState()).enabled;
}

/** 同步区是否已有其他设备推送的加密凭据（无需口令即可判断） */
export async function hasRemoteCrossDeviceAuth(): Promise<boolean> {
    return isEncryptedPayload(await syncGet(REMOTE_AUTH_KEY));
}

/**
 * 启用跨设备同步
 *
 * @param passphrase 加密口令（至少 6 位），后续换设备需输入同一口令
 * @param auth 当前登录凭据；为空时只保存开关与口令，等下次登录再推送
 *
 * 注意：`auth` 为空时**不会**删除同步区已有密文——新设备首次启用时
 * 正是靠这份密文还原登录状态，删掉就无从恢复。清理只在登出 / 关闭开关时发生。
 */
export async function enableCrossDevice(
    passphrase: string,
    auth?: CrossDeviceAuth | null
): Promise<EnableCrossDeviceResult> {
    if (!passphrase || passphrase.length < MIN_PASSPHRASE_LENGTH) {
        throw new Error(`同步密码至少 ${MIN_PASSPHRASE_LENGTH} 位`);
    }

    // 先加密一次验证口令可用（同时验证 WebCrypto 是否可用）
    const payload = await encryptText(JSON.stringify(auth ?? null), passphrase);

    await storageManager.setMany({
        [LOCAL_ENABLED_KEY]: true,
        [LOCAL_PASSPHRASE_KEY]: passphrase
    });

    if (!auth?.token) {
        return { pushed: false };
    }

    await syncSetMany({
        [REMOTE_AUTH_KEY]: payload,
        [REMOTE_META_KEY]: {
            updatedAt: Date.now(),
            device: getDeviceLabel(),
            provider: auth.provider
        } satisfies CrossDeviceRemoteMeta
    });
    return { pushed: true };
}

/**
 * 在新设备上凭口令还原登录状态
 *
 * 成功后会把「开关 + 口令」落到本机，之后的自动推送即可复用。
 *
 * @throws 口令错误时抛「同步密码不正确，无法解密」
 */
export async function restoreCrossDeviceAuth(
    passphrase: string
): Promise<CrossDeviceAuth | null> {
    if (!passphrase || passphrase.length < MIN_PASSPHRASE_LENGTH) {
        throw new Error(`同步密码至少 ${MIN_PASSPHRASE_LENGTH} 位`);
    }

    const raw = await syncGet(REMOTE_AUTH_KEY);
    if (!isEncryptedPayload(raw)) {
        return null;
    }

    const plain = await decryptText(raw, passphrase);
    let parsed: CrossDeviceAuth | null = null;
    try {
        parsed = JSON.parse(plain) as CrossDeviceAuth | null;
    } catch {
        return null;
    }

    if (!parsed || typeof parsed.token !== 'string' || !parsed.token) {
        return null;
    }

    await storageManager.setMany({
        [LOCAL_ENABLED_KEY]: true,
        [LOCAL_PASSPHRASE_KEY]: passphrase
    });

    return {
        token: parsed.token,
        provider: typeof parsed.provider === 'string' ? parsed.provider : 'github'
    };
}

/** 关闭跨设备同步：清除本机口令与同步区密文 */
export async function disableCrossDevice(): Promise<void> {
    await storageManager.setMany({
        [LOCAL_ENABLED_KEY]: false,
        [LOCAL_PASSPHRASE_KEY]: null
    });
    await syncRemove(REMOTE_AUTH_KEY);
    await syncRemove(REMOTE_META_KEY);
}

/** 仅清除同步区密文，保留本机开关与口令 */
export async function clearRemoteCrossDeviceAuth(): Promise<void> {
    await syncRemove(REMOTE_AUTH_KEY);
    await syncRemove(REMOTE_META_KEY);
}

/** 生成粗粒度的设备标识，仅用于界面显示「凭据来自哪台设备」 */
function getDeviceLabel(): string {
    if (typeof navigator === 'undefined') return '未知设备';
    const ua = navigator.userAgent;
    const platform = /Windows/i.test(ua)
        ? 'Windows'
        : /Mac OS X|Macintosh/i.test(ua)
            ? 'macOS'
            : /Android/i.test(ua)
                ? 'Android'
                : /Linux/i.test(ua)
                    ? 'Linux'
                    : '';
    const browser = /Edg\//.test(ua)
        ? 'Edge'
        : /Firefox\//.test(ua)
            ? 'Firefox'
            : /Chrome\//.test(ua)
                ? 'Chrome'
                : /Safari\//.test(ua)
                    ? 'Safari'
                    : 'Browser';
    return platform ? `${browser} · ${platform}` : browser;
}

/**
 * 推送登录凭据到同步区
 *
 * @param auth 当前登录凭据；为空时**什么都不做**
 * @returns 是否真的写入了同步区；未启用 / 缺口令 / 本机没登录时为 false
 *
 * 「没有凭据」不等于「把凭据删掉」，这两件事必须分开：同步区里那份可能是别的设备推来的，
 * 而本机拿不到凭据的原因多得是——Token 验证失败、断网、被平台限流、刚换了平台。
 * 早先这里在 auth 为空时顺手 syncRemove，于是任何一次失败的登录（包括自动恢复时
 * 网络抖一下）都会把共用凭据连同其他设备的登录状态一起清没，用户看到的就永远是
 * 「同一个账号、同一个密码，Token 就是同步不过来」。删除只在显式调用时发生：
 * 见 `clearRemoteCrossDeviceAuth`（断开云同步）与 `disableCrossDevice`（关掉开关）。
 */
export async function pushCrossDeviceAuth(auth: CrossDeviceAuth | null): Promise<boolean> {
    const state = await getCrossDeviceState();
    if (!state.enabled) {
        return false;
    }

    if (!auth?.token) {
        return false;
    }

    const passphrase = await storageManager.get(LOCAL_PASSPHRASE_KEY);
    if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LENGTH) {
        // 口令丢失（例如清了浏览器数据）时无法加密，跳过推送
        return false;
    }

    const payload = await encryptText(JSON.stringify(auth), passphrase);
    // 密文与元信息一次写入：分两次写时，另一台设备可能先看到其一，界面就会自相矛盾
    await syncSetMany({
        [REMOTE_AUTH_KEY]: payload,
        [REMOTE_META_KEY]: {
            updatedAt: Date.now(),
            device: getDeviceLabel(),
            provider: auth.provider
        } satisfies CrossDeviceRemoteMeta
    });
    return true;
}

/**
 * 从同步区拉取并解密登录凭据
 *
 * @returns 解密后的凭据；未启用、无密文或解密失败时返回 null
 */
export async function pullCrossDeviceAuth(): Promise<CrossDeviceAuth | null> {
    const state = await getCrossDeviceState();
    if (!state.enabled || !state.hasPassphrase) {
        return null;
    }

    const raw = await syncGet(REMOTE_AUTH_KEY);
    if (!isEncryptedPayload(raw)) {
        return null;
    }

    const passphrase = await storageManager.get(LOCAL_PASSPHRASE_KEY);
    if (typeof passphrase !== 'string') {
        return null;
    }

    const plain = await decryptText(raw, passphrase);
    const parsed = JSON.parse(plain) as CrossDeviceAuth | null;
    if (!parsed || typeof parsed.token !== 'string' || !parsed.token) {
        return null;
    }

    return {
        token: parsed.token,
        provider: typeof parsed.provider === 'string' ? parsed.provider : 'github'
    };
}

/**
 * 恢复码
 *
 * 浏览器给扩展的两块存储都活不过「卸载扩展」：storage.local 明确会被清掉，
 * storage.sync 按扩展 ID 隔离，卸载同样会把这份密文带走。也就是说同步区那条路
 * 只解决「设备还在、扩展没重装」，重装以后同步区必然是空的。
 *
 * 恢复码是交给用户自己保管的那一份密文：同一套 AES-GCM + 同步密码，
 * 但存在扩展之外（密码管理器、备忘录），因此不受卸载影响。
 * 它本身就是密文，且明文里的那个 Token 本机 storage.local 里原样存着，
 * 多复制一份密文给用户不额外扩大暴露面。
 */
const RECOVERY_CODE_PREFIX = 'HANTAB1.';

/** 生成恢复码（口令至少 MIN_PASSPHRASE_LENGTH 位） */
export async function createRecoveryCode(
    auth: CrossDeviceAuth,
    passphrase: string
): Promise<string> {
    const payload = await encryptText(JSON.stringify(auth), passphrase);
    return RECOVERY_CODE_PREFIX + toBase64Text(JSON.stringify(payload));
}

/**
 * 用恢复码取出凭据
 * @throws 格式不对、口令不对、码里没有凭据，各给一句能直接念给用户的话
 */
export async function readRecoveryCode(
    code: string,
    passphrase: string
): Promise<CrossDeviceAuth> {
    const trimmed = (code || '').trim();
    if (!trimmed.startsWith(RECOVERY_CODE_PREFIX)) {
        throw new Error('恢复码格式不正确，请整段复制');
    }

    let payload: unknown;
    try {
        payload = JSON.parse(fromBase64Text(trimmed.slice(RECOVERY_CODE_PREFIX.length)));
    } catch {
        throw new Error('恢复码格式不正确，请整段复制');
    }

    const plain = await decryptText(payload as EncryptedPayload, passphrase);
    let parsed: CrossDeviceAuth | null = null;
    try {
        parsed = JSON.parse(plain) as CrossDeviceAuth | null;
    } catch {
        throw new Error('恢复码内容已损坏，无法读出登录凭据');
    }

    if (!parsed || typeof parsed.token !== 'string' || !parsed.token) {
        throw new Error('恢复码里没有可用的登录凭据');
    }

    // 与同步区恢复同一条收尾：把「开关 + 口令」记回本机，之后换 Token、补推才有的可用。
    // 只记口令，恢复码本身不落任何存储——它本来就是从这份口令推出来的。
    await storageManager.setMany({
        [LOCAL_ENABLED_KEY]: true,
        [LOCAL_PASSPHRASE_KEY]: passphrase
    });

    return {
        token: parsed.token,
        provider: typeof parsed.provider === 'string' ? parsed.provider : 'github'
    };
}

/** UTF-8 字符串 → base64（不用 btoa(str)：Token 里可能出现非 Latin1 字符） */
function toBase64Text(text: string): string {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

/** base64 → UTF-8 字符串 */
function fromBase64Text(value: string): string {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}

/**
 * 监听同步区里登录凭据的变化
 *
 * 其他设备推送后本机可以立刻显示「检测到其他设备的登录状态」，
 * 不需要用户关掉面板重开。
 */
export function watchRemoteCrossDeviceAuth(
    listener: (available: boolean) => void
): () => void {
    return subscribeSyncAreaChanges((changes) => {
        if (!Object.prototype.hasOwnProperty.call(changes, REMOTE_AUTH_KEY)) {
            return;
        }
        listener(isEncryptedPayload(changes[REMOTE_AUTH_KEY]?.newValue));
    });
}

/**
 * 本机扩展 ID
 *
 * 浏览器把 storage.sync 按扩展 ID 隔离：商店版、自签版、about:debugging 临时加载的
 * 开发版可能各是一个 ID，它们的同步区永远对不上——「凭据：暂无」就是这么来的。
 */
export function getExtensionId(): string {
    if (typeof window === 'undefined') return '';
    const win = window as unknown as {
        browser?: { runtime?: { id?: string } };
        chrome?: { runtime?: { id?: string } };
    };
    return win.browser?.runtime?.id ?? win.chrome?.runtime?.id ?? '';
}

/**
 * 往同步区发一次探测
 *
 * 写的是与口令无关的明文随机值，另一台设备不需要密码、也不需要登录就能读到，
 * 因此它能回答「这个同步区到底通不通」——凭据那条路问不出这个问题。
 */
export async function sendSyncAreaProbe(): Promise<SyncAreaProbe> {
    if (!getSyncAreaStatus().native) {
        throw new Error('当前为网页预览环境，无法探测浏览器同步区');
    }

    const probe: SyncAreaProbe = {
        device: getDeviceLabel(),
        extensionId: getExtensionId(),
        updatedAt: Date.now(),
        nonce: createNonce()
    };

    await syncSet(REMOTE_PROBE_KEY, probe);
    // 记下自己这份，读的时候才不会把它当成另一台设备发来的
    await storageManager.set(LOCAL_PROBE_KEY, probe.nonce);
    return probe;
}

/**
 * 读同步区里「别的设备」最近发来的探测
 *
 * @returns 只有本机自己那一份、或同步区里什么都没有时返回 null
 */
export async function readIncomingSyncAreaProbe(): Promise<SyncAreaProbe | null> {
    const probe = toSyncAreaProbe(await syncGet(REMOTE_PROBE_KEY));
    if (!probe) {
        return null;
    }
    const mine = await storageManager.get(LOCAL_PROBE_KEY);
    return probe.nonce === mine ? null : probe;
}

/** 同步区里的原始值 → 探测记录，形状不对就当没有 */
function toSyncAreaProbe(value: unknown): SyncAreaProbe | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    const probe = value as Partial<SyncAreaProbe>;
    if (typeof probe.nonce !== 'string' || typeof probe.updatedAt !== 'number') {
        return null;
    }
    return {
        nonce: probe.nonce,
        updatedAt: probe.updatedAt,
        device: typeof probe.device === 'string' ? probe.device : '未知设备',
        extensionId: typeof probe.extensionId === 'string' ? probe.extensionId : ''
    };
}

function createNonce(): string {
    const randomId = globalThis.crypto?.randomUUID?.();
    if (randomId) {
        return randomId;
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
