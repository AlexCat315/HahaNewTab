import type { SyncSnapshot } from '@/utils/syncMerge.util';
import type { IStorageManager } from '@/services/storage.service';

/**
 * 云同步使用的存储能力 = 存储内核的子集
 * 按内核真实签名取用，不再另立一套并行的存储接口。
 */
export type CloudSyncStorage = Pick<
    IStorageManager,
    'get' | 'getMany' | 'set' | 'setMany' | 'subscribe'
>;

/** 设置模块（账号与开关）需要的存储能力 */
export type CloudSettingsStorage = Pick<IStorageManager, 'getMany' | 'setMany' | 'subscribe'>;

/** 同步账本（base 快照 + 已见版本 + 上次同步时间）需要的存储能力 */
export type CloudLedgerStorage = Pick<IStorageManager, 'get' | 'setMany' | 'subscribe'>;

/**
 * GitHub 用户信息
 * GitHub / Gitee 的 GET /user 返回结构一致，两平台通用
 */
export interface GitHubUserInfo {
    login: string;
    id: number;
    avatar: string;
}

/**
 * 云同步平台标识
 */
export type CloudSyncProviderId = 'github' | 'gitee';

/**
 * 同步平台适配器
 * 封装 GitHub / Gitee 的 Gist（代码片段）CRUD 与 Token 验证差异，
 * 供 CloudSyncService 统一调用；网络超时与错误分类由实现内部处理。
 */
export interface ISyncProvider {
    /** 平台标识 */
    readonly id: CloudSyncProviderId;
    /** 平台显示名 */
    readonly name: string;
    /** Token 获取地址提示（登录面板展示） */
    readonly tokenHint: string;
    /**
     * 单个文件的写入上限（字节）
     * 上传前按它自检，资源分片也按它切块，避免撞上限后只拿到一个含糊的 422。
     */
    readonly maxFileBytes: number;
    /** 验证 Token 并返回用户信息，失败时抛出错误 */
    validateToken(token: string): Promise<GitHubUserInfo>;
    /** 列出用户 Gist（含 files 元数据） */
    listGists(token: string): Promise<Gist[]>;
    /** 读取指定 Gist 中文件的内容；Gist 或文件不存在时返回 null */
    getGistFileContent(token: string, gistId: string, fileName: string): Promise<string | null>;
    /**
     * 读取指定 Gist 的完整文件表（文件名 → 文件元数据，含 raw_url）
     * 资源分片要靠它拿到每个分片的下载地址；Gist 不存在时返回 null。
     */
    getGistFileMap(token: string, gistId: string): Promise<Record<string, GistFile> | null>;
    /** 按 raw_url 读取单个文件全文；不存在返回 null */
    readRawFile(token: string, rawUrl: string): Promise<string | null>;
    /**
     * 从已经取到的文件表里读单个文件全文
     * 内联内容超过平台上限时只会给回前半截，这里负责识别并改走 raw_url。
     */
    readFileFromMap(token: string, file: GistFile | null | undefined): Promise<string | null>;
    /** 创建 Gist，返回其 id */
    createGist(token: string, fileName: string, content: string, description: string): Promise<string>;
    /** 更新 Gist 中指定文件的内容 */
    updateGist(token: string, gistId: string, fileName: string, content: string): Promise<void>;
    /**
     * 一次请求内批量写入与删除文件
     * 未出现在 upsert / deleteFileNames 里的文件保持原样。
     */
    updateGistFiles(
        token: string,
        gistId: string,
        upsert: Record<string, string>,
        deleteFileNames: string[]
    ): Promise<void>;
}

/**
 * Gist 文件对象
 */
export interface GistFile {
    filename?: string;
    type?: string;
    language?: string | null;
    raw_url?: string;
    size?: number;
    content?: string;
    truncated?: boolean;
}

/**
 * Gist 列表项 / 详情
 */
export interface Gist {
    id: string;
    description: string | null;
    public: boolean;
    files: Record<string, GistFile>;
    html_url?: string;
    created_at?: string;
    updated_at?: string;
}

/**
 * 同步资源清单条目
 * 一个 data URL 对应一条：MIME + 分片文件名（按顺序拼接即为完整 Base64）。
 */
export interface SyncAssetEntry {
    mime: string;
    /** Base64 文本长度 */
    bytes: number;
    files: string[];
}

/** 资源清单：内容哈希 → 条目 */
export type SyncAssetManifest = Record<string, SyncAssetEntry>;

/**
 * 同步包在云端文件里的样子（只在传输层读写，服务层拿到的是 CloudBundle）
 * data 是存储键注册表里登记了云同步策略的键值快照；
 * 其中的大对象（Base64 站点图标、本地壁纸图片）在上传前换成 `haha-asset://{哈希}` 引用，
 * 原文按内容哈希分片写进同一个 Gist，清单记在 assets；下载时再还原回 data URL。
 */
export interface SyncData {
    version: string;
    lastModified: number;
    device: string;
    data: Record<string, unknown>;
    /** 本次 payload 的资源清单；没有大对象时缺省 */
    assets?: SyncAssetManifest;
}

/**
 * 一轮传输用的凭据
 *
 * 整轮都用同一份：Token 或平台在几次网络往返之间被别的页面改掉时，
 * 不能出现「前半截用旧 Token 读、后半截用新 Token 写」的半新半旧的包。
 */
export interface CloudTarget {
    token: string;
    providerId: CloudSyncProviderId;
}

/**
 * 从云端读回来的一版内容
 *
 * 版本号、写入时间、数据本来就是一回事，拆开传就会有人在某一边忘记传：
 * 判断「云端这一版本机是否已经见过」靠 revision，首次同步定方向靠 lastModified，
 * 两者都必须和 data 来自同一次请求。
 */
export interface CloudBundle {
    /** 资源已还原成本地形态（data URL）、且只留注册表登记的键的云端数据 */
    data: SyncSnapshot;
    /** 云端这份数据记录的写入时间 */
    lastModified: number;
    /**
     * 这一版文件的指纹：同步文件原文的内容哈希，取自还原分片之前。
     *
     * 分片本身按内容命名，所以「同一版文件」永远得到同一个指纹，跨设备、跨标签页都一样。
     * 用它认出「云端把刚才那版又还给我了一次」：写后立读时 Gist 有约 1 分钟会返回旧文件，
     * 旧文件在三方合并里和「别的设备改了云端」完全同形，会把本机刚改好的设置倒灌回去。
     */
    revision: string;
}

/**
 * 这一轮没走到云端就返回的原因
 *
 * 界面据此决定说不说：「没登录」是用户能自己修的状态，手动操作时要说清楚；
 * 「同步进行中」「别的页面刚同步完」是本机马上会自己重来一次的过场，说出来只是噪音。
 * 缺省表示这一轮真的向云端发起过请求并且失败了。
 */
export type SyncSkipReason = 'not-authenticated' | 'in-progress' | 'stale-base';

/**
 * 上传结果
 */
export interface UploadResult {
    success: boolean;
    time?: number;
    message?: string;
    skipped?: SyncSkipReason;
}

/**
 * 下载结果
 */
export interface DownloadResult {
    success: boolean;
    data?: CloudBundle;
    message?: string;
    skipped?: SyncSkipReason;
}

/**
 * 拉取并应用结果
 */
export interface PullResult {
    success: boolean;
    applied?: boolean;
    message?: string;
}

/**
 * 连接账号（保存并验证 Token）的结果
 *
 * `success` 只说「Token 是不是能用」；同步空间没建出来算「连上了但有话要说」，
 * 该说哪句由界面层按 reason 决定，服务不猜有没有人在看。
 */
export interface ConnectResult {
    success: boolean;
    /** 这一句该不该说、怎么说 */
    reason?: 'empty' | 'invalid-token' | 'gist-unavailable';
    /** 随 reason 带出的原始错误信息（网络/权限的分类在传输层已经做过） */
    message?: string;
    /** 验证通过的账号信息 */
    userInfo?: GitHubUserInfo;
}

/**
 * 双向合并同步结果
 */
export interface SyncResult {
    success: boolean;
    /** 是否有数据上传到云端 */
    uploaded?: boolean;
    /** 是否有云端数据应用到本地 */
    applied?: boolean;
    /**
     * 这一轮没有把本地改动送出去，调用方应当重新排程再来一次
     * （被进行中的同步挡下 / 下载期间别的页面同步完成 / 本轮请求失败）
     */
    retry?: boolean;
    time?: number;
    message?: string;
    /** 没走到云端的原因；缺省表示这一轮请求发出去过并失败了 */
    skipped?: SyncSkipReason;
    /**
     * 平台明确拒绝了本机这份 Token（401），凭据已被清掉
     * 与「只是连不上」区别对待：前者该去浏览器同步区拿另一台设备推来的新凭据，
     * 后者不能——否则断网启动就把用户的登录状态抹了。
     */
    authRejected?: boolean;
}

/**
 * 云同步错误分类
 */
export type CloudSyncErrorKind = 'network' | 'unauthorized' | 'rateLimit' | 'http' | 'unknown';

/**
 * 云同步服务配置
 */
export interface CloudSyncSettings {
    token: string | null;
    gistId: string | null;
    autoSync: boolean;
    lastSyncTime: number;
    userInfo: GitHubUserInfo | null;
    /** 当前连接的同步平台 */
    provider: CloudSyncProviderId;
}

/**
 * 账号侧设置
 * 这五项由用户直接左右；`lastSyncTime` 不是——它是一轮同步走通后的记账结果，
 * 归同步账本（cloudSync/ledger.ts）所有，所以这里单独切出一份。
 */
export type CloudAccountSettings = Omit<CloudSyncSettings, 'lastSyncTime'>;

/**
 * 云同步数据管理器适配器
 * 由 appData store 实现
 */
export interface ICloudSyncDataManager {
    /**
     * 在收集本地数据前同步内存缓存到持久存储
     */
    syncNow(): Promise<void>;
    /**
     * 将云端快照应用到本地存储
     */
    applyStorageSnapshot(snapshot: Record<string, unknown>): Promise<boolean>;
}

/**
 * 云同步 UI 适配器
 */
export interface ICloudSyncUIAdapter {
    showToast(message: string, type?: 'success' | 'error' | 'info'): void;
    showConfirm(
        message: string,
        options?: {
            title?: string;
            okText?: string;
            isDanger?: boolean;
        }
    ): Promise<boolean>;
    showPrompt(
        message: string,
        options?: {
            title?: string;
            confirmText?: string;
            cancelText?: string;
            inputPlaceholder?: string;
            inputType?: string;
        }
    ): Promise<string | null>;
}

/**
 * 构造 CloudSyncService 所需的依赖
 *
 * storage 直接就是存储内核（services/storage.service.ts）用到的那部分能力，
 * 云同步不再自带一层「看起来一样但签名不同」的适配器接口——
 * 那层接口只会让内核改签名时这里悄悄失配，还得靠 as unknown as 蒙过去。
 *
 * 没有 ui：服务只交出结构化结果，提示与确认归把结果写回界面的那一层。
 */
export interface CloudSyncDependencies {
    storage: CloudSyncStorage;
    dataManager: ICloudSyncDataManager;
}
