/**
 * 同步平台适配器（GitHub / Gitee Gist）
 * 封装两个平台的 Gist CRUD 与 Token 验证差异：
 * - GitHub：Header Bearer 认证，单文件 10MB；
 * - Gitee：Query access_token 认证，单文件 1MB，数据库不支持 4 字节 UTF-8 字符（需无损转义）。
 * 所有请求带 10s 超时，错误按网络/401/频率限制分类为中文提示。
 */

import type {
    CloudSyncProviderId,
    Gist,
    GistFile,
    GitHubUserInfo,
    ISyncProvider
} from '@/types/cloudSync.types';

const REQUEST_TIMEOUT_MS = 10000;

/**
 * API 详情响应里内联返回的文件内容上限
 * 超过这个大小的文件，`content` 只会给回前半截（见 readGistFile），必须改走 raw_url。
 */
export const INLINE_CONTENT_BYTES = 1024 * 1024;

/**
 * 平台错误，status 用于 CloudSyncService 识别 401（Token 失效）
 */
export class SyncProviderError extends Error {
    readonly status?: number;

    constructor(message: string, status?: number) {
        super(message);
        this.name = 'SyncProviderError';
        this.status = status;
    }
}

/**
 * 带超时的 fetch 封装；网络不可达与超时统一转换为中文错误信息
 */
async function request(providerName: string, networkHint: string, url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') {
            throw new SyncProviderError(`无法连接 ${providerName}（请求超时），${networkHint}`);
        }
        if (e instanceof TypeError) {
            throw new SyncProviderError(`无法连接 ${providerName}，${networkHint}`);
        }
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 处理非 2xx 响应，按状态码分类抛出中文错误
 */
async function throwForStatus(providerName: string, response: Response, fallback: string): Promise<never> {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    const message = body.message || fallback;
    if (response.status === 401) {
        throw new SyncProviderError(`Token 已失效，请重新连接 ${providerName}`, 401);
    }
    if (response.status === 403 && /rate limit/i.test(message)) {
        throw new SyncProviderError(`${providerName} API 频率限制，请稍后再试`, 403);
    }
    throw new SyncProviderError(`${message} (${response.status})`, response.status);
}

/**
 * 读取 Gist 里的单个文件全文
 *
 * 详情接口对每个文件最多内联 1MB，超出时不是「不给 content」而是「只给前 1MB 并置
 * `truncated: true`」。直接把这份截断体当全文交给 JSON.parse，得到的是一句看不懂的
 * 「Unexpected end of JSON input」，所以 truncated 必须优先于 content 判断。
 */
async function readGistFile(
    providerName: string,
    networkHint: string,
    file: GistFile | null | undefined,
    headers?: Record<string, string>
): Promise<string | null> {
    if (!file) return null;

    const inline = file.content ?? '';
    const inlineBytes = new TextEncoder().encode(inline).length;
    if (file.truncated !== true && file.content != null && inlineBytes < INLINE_CONTENT_BYTES) {
        return file.content;
    }
    if (!file.raw_url) return file.content ?? null;

    const response = await request(providerName, networkHint, file.raw_url, { headers });
    if (response.status === 404) return null;
    if (!response.ok) {
        await throwForStatus(providerName, response, '获取文件内容失败');
    }
    return await response.text();
}

/** 上传前按平台上限自检单文件体积，超限给出可直接照做的提示 */
function assertFileBytes(providerName: string, maxFileBytes: number, content: string): void {
    const bytes = new TextEncoder().encode(content).length;
    if (bytes > maxFileBytes) {
        const limit = maxFileBytes / 1024 / 1024;
        throw new SyncProviderError(
            `数据大小约 ${(bytes / 1024 / 1024).toFixed(2)}MB，超过 ${providerName} 单文件 ${limit}MB 限制`
        );
    }
}

// ==================== GitHub ====================

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const GITHUB_NETWORK_HINT = '请检查网络或代理（国内可能需代理访问）';
/** GitHub 单个 Gist 文件的写入上限 */
const GITHUB_MAX_FILE_BYTES = 10 * 1024 * 1024;

function githubHeaders(token: string): Record<string, string> {
    return {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'Content-Type': 'application/json'
    };
}

/** 批量写文件的请求体：值为 null 表示删除该文件 */
function buildFilesPayload(
    upsert: Record<string, string>,
    deleteFileNames: string[],
    escape?: (content: string) => string
): Record<string, { content: string } | null> {
    const payload: Record<string, { content: string } | null> = {};
    for (const [name, content] of Object.entries(upsert)) {
        payload[name] = { content: escape ? escape(content) : content };
    }
    for (const name of deleteFileNames) {
        payload[name] = null;
    }
    return payload;
}

const githubProvider: ISyncProvider = {
    id: 'github',
    name: 'GitHub',
    tokenHint: 'github.com/settings/tokens（需要 gist 权限）',
    maxFileBytes: GITHUB_MAX_FILE_BYTES,

    async validateToken(token: string): Promise<GitHubUserInfo> {
        const response = await request('GitHub', GITHUB_NETWORK_HINT, `${GITHUB_API_BASE}/user`, {
            headers: githubHeaders(token)
        });
        if (!response.ok) {
            await throwForStatus('GitHub', response, 'Token 验证失败');
        }
        const user = (await response.json()) as { login: string; id: number; avatar_url: string };
        return { login: user.login, id: user.id, avatar: user.avatar_url };
    },

    async listGists(token: string): Promise<Gist[]> {
        const response = await request('GitHub', GITHUB_NETWORK_HINT, `${GITHUB_API_BASE}/gists?per_page=100`, {
            headers: githubHeaders(token)
        });
        if (!response.ok) {
            await throwForStatus('GitHub', response, '获取 Gist 列表失败');
        }
        return (await response.json()) as Gist[];
    },

    async getGistFileContent(token: string, gistId: string, fileName: string): Promise<string | null> {
        const files = await githubProvider.getGistFileMap(token, gistId);
        return files ? readGistFile('GitHub', GITHUB_NETWORK_HINT, files[fileName], githubHeaders(token)) : null;
    },

    async getGistFileMap(token: string, gistId: string): Promise<Record<string, GistFile> | null> {
        const response = await request('GitHub', GITHUB_NETWORK_HINT, `${GITHUB_API_BASE}/gists/${gistId}`, {
            headers: githubHeaders(token)
        });
        if (response.status === 404) return null;
        if (!response.ok) {
            await throwForStatus('GitHub', response, '获取 Gist 失败');
        }
        const gist = (await response.json()) as Gist;
        return gist.files ?? {};
    },

    async readRawFile(token: string, rawUrl: string): Promise<string | null> {
        const response = await request('GitHub', GITHUB_NETWORK_HINT, rawUrl, { headers: githubHeaders(token) });
        if (response.status === 404) return null;
        if (!response.ok) {
            await throwForStatus('GitHub', response, '获取文件内容失败');
        }
        return await response.text();
    },

    async readFileFromMap(token: string, file: GistFile | null | undefined): Promise<string | null> {
        return readGistFile('GitHub', GITHUB_NETWORK_HINT, file, githubHeaders(token));
    },

    async createGist(token: string, fileName: string, content: string, description: string): Promise<string> {
        assertFileBytes('GitHub', GITHUB_MAX_FILE_BYTES, content);
        const response = await request('GitHub', GITHUB_NETWORK_HINT, `${GITHUB_API_BASE}/gists`, {
            method: 'POST',
            headers: githubHeaders(token),
            body: JSON.stringify({
                description,
                public: false,
                files: { [fileName]: { content } }
            })
        });
        if (!response.ok) {
            await throwForStatus('GitHub', response, '创建 Gist 失败');
        }
        const gist = (await response.json()) as Gist;
        return gist.id;
    },

    async updateGist(token: string, gistId: string, fileName: string, content: string): Promise<void> {
        await githubProvider.updateGistFiles(token, gistId, { [fileName]: content }, []);
    },

    async updateGistFiles(
        token: string,
        gistId: string,
        upsert: Record<string, string>,
        deleteFileNames: string[]
    ): Promise<void> {
        for (const content of Object.values(upsert)) {
            assertFileBytes('GitHub', GITHUB_MAX_FILE_BYTES, content);
        }
        const response = await request('GitHub', GITHUB_NETWORK_HINT, `${GITHUB_API_BASE}/gists/${gistId}`, {
            method: 'PATCH',
            headers: githubHeaders(token),
            body: JSON.stringify({ files: buildFilesPayload(upsert, deleteFileNames) })
        });
        if (!response.ok) {
            await throwForStatus('GitHub', response, '上传失败');
        }
    }
};

// ==================== Gitee ====================

const GITEE_API_BASE = 'https://gitee.com/api/v5';
const GITEE_NETWORK_HINT = '请检查网络连接';
/** Gitee 限制单个 Gist 文件最大 1MB */
const GITEE_MAX_FILE_BYTES = 1024 * 1024;

function giteeUrl(path: string, token: string): string {
    const sep = path.includes('?') ? '&' : '?';
    return `${GITEE_API_BASE}${path}${sep}access_token=${encodeURIComponent(token)}`;
}

/**
 * Gitee 数据库（utf8mb3）不支持 4 字节 UTF-8 字符（多数 emoji）。
 * 将此类字符转义为 JSON 代理对（\uXXXX\uXXXX）：它们只会出现在 JSON 字符串值内，
 * 转义后仍是合法 JSON，JSON.parse 可无损还原，不丢站点/分类的 Emoji 图标。
 */
export function escapeForGitee(content: string): string {
    return content.replace(/[\u{10000}-\u{10FFFF}]/gu, (ch) => {
        const code = ch.codePointAt(0) as number;
        const hi = 0xd800 + ((code - 0x10000) >> 10);
        const lo = 0xdc00 + ((code - 0x10000) & 0x3ff);
        return `\\u${hi.toString(16)}\\u${lo.toString(16)}`;
    });
}

/** 上传前检查 Gitee 单文件大小限制 */
function assertGiteeSize(content: string): void {
    const bytes = new TextEncoder().encode(content).length;
    if (bytes > GITEE_MAX_FILE_BYTES) {
        throw new SyncProviderError(
            `数据大小约 ${(bytes / 1024 / 1024).toFixed(2)}MB，超过 Gitee 单文件 1MB 限制，请改用 GitHub 或精简数据`
        );
    }
}

const GITEE_JSON_HEADERS = { 'Content-Type': 'application/json' };

const giteeProvider: ISyncProvider = {
    id: 'gitee',
    name: 'Gitee',
    tokenHint: 'gitee.com/profile/personal_access_tokens（私人令牌，勾选 gists 权限）',
    maxFileBytes: GITEE_MAX_FILE_BYTES,

    async validateToken(token: string): Promise<GitHubUserInfo> {
        const response = await request('Gitee', GITEE_NETWORK_HINT, giteeUrl('/user', token), {});
        if (!response.ok) {
            await throwForStatus('Gitee', response, 'Token 验证失败');
        }
        const user = (await response.json()) as { login: string; id: number; avatar_url: string };
        return { login: user.login, id: user.id, avatar: user.avatar_url };
    },

    async listGists(token: string): Promise<Gist[]> {
        const response = await request('Gitee', GITEE_NETWORK_HINT, giteeUrl('/gists?per_page=100', token), {});
        if (!response.ok) {
            await throwForStatus('Gitee', response, '获取代码片段列表失败');
        }
        return (await response.json()) as Gist[];
    },

    async getGistFileContent(token: string, gistId: string, fileName: string): Promise<string | null> {
        const files = await giteeProvider.getGistFileMap(token, gistId);
        return files ? readGistFile('Gitee', GITEE_NETWORK_HINT, files[fileName]) : null;
    },

    async getGistFileMap(token: string, gistId: string): Promise<Record<string, GistFile> | null> {
        const response = await request('Gitee', GITEE_NETWORK_HINT, giteeUrl(`/gists/${gistId}`, token), {});
        if (response.status === 404) return null;
        if (!response.ok) {
            await throwForStatus('Gitee', response, '获取代码片段失败');
        }
        const gist = (await response.json()) as Gist;
        return gist.files ?? {};
    },

    // Gitee 的 raw_url 是免鉴权的公开直链，令牌在这里用不上
    async readRawFile(_token: string, rawUrl: string): Promise<string | null> {
        const response = await request('Gitee', GITEE_NETWORK_HINT, rawUrl, {});
        if (response.status === 404) return null;
        if (!response.ok) {
            await throwForStatus('Gitee', response, '获取文件内容失败');
        }
        return await response.text();
    },

    // Gitee 的 raw_url 是免鉴权的公开直链，不需要令牌
    async readFileFromMap(_token: string, file: GistFile | null | undefined): Promise<string | null> {
        return readGistFile('Gitee', GITEE_NETWORK_HINT, file);
    },

    async createGist(token: string, fileName: string, content: string, description: string): Promise<string> {
        const safeContent = escapeForGitee(content);
        assertGiteeSize(safeContent);
        const response = await request('Gitee', GITEE_NETWORK_HINT, giteeUrl('/gists', token), {
            method: 'POST',
            headers: GITEE_JSON_HEADERS,
            body: JSON.stringify({
                description,
                public: false,
                files: { [fileName]: { content: safeContent } }
            })
        });
        if (!response.ok) {
            await throwForStatus('Gitee', response, '创建代码片段失败');
        }
        const gist = (await response.json()) as Gist;
        return gist.id;
    },

    async updateGist(token: string, gistId: string, fileName: string, content: string): Promise<void> {
        await giteeProvider.updateGistFiles(token, gistId, { [fileName]: content }, []);
    },

    async updateGistFiles(
        token: string,
        gistId: string,
        upsert: Record<string, string>,
        deleteFileNames: string[]
    ): Promise<void> {
        const files: Record<string, { content: string; filename: string } | null> = {};
        for (const [name, content] of Object.entries(upsert)) {
            const safeContent = escapeForGitee(content);
            assertGiteeSize(safeContent);
            files[name] = { content: safeContent, filename: name };
        }
        // Gitee 的更新接口没有公开的「删除单个文件」语义，删除请求只能忽略：
        // 本端不再引用的历史资源会留在云端，靠 GitHub 端才做真正的清理。
        void deleteFileNames;

        const response = await request('Gitee', GITEE_NETWORK_HINT, giteeUrl(`/gists/${gistId}`, token), {
            method: 'PATCH',
            headers: GITEE_JSON_HEADERS,
            body: JSON.stringify({ files })
        });
        if (!response.ok) {
            await throwForStatus('Gitee', response, '上传失败');
        }
    }
};

/**
 * 工厂函数：按平台标识创建同步平台适配器
 */
export function createGistProvider(id: CloudSyncProviderId): ISyncProvider {
    return id === 'gitee' ? giteeProvider : githubProvider;
}
