/**
 * GitHub Gist 客户端
 *
 * 封装 Gist CRUD 与凭据验证：Header Bearer 认证，单文件 10MB。
 * 凭据来自 OAuth Device Flow 换到的 access_token（gist scope），不再由用户手工申请。
 * 所有请求带 10s 超时，错误按网络/401/频率限制分类为中文提示。
 */

import type {
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
 * 平台错误，status 用于 CloudSyncService 识别 401（授权失效）
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
        throw new SyncProviderError(`授权已失效，请重新登录 ${providerName}`, 401);
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

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const GITHUB_NETWORK_HINT = '请检查网络或代理（国内可能需代理访问）';
/** GitHub 单个 Gist 文件的写入上限 */
const GITHUB_MAX_FILE_BYTES = 10 * 1024 * 1024;
/** /gists 单页条数与最大翻页数（最多认领 1000 个 Gist） */
const GIST_PAGE_SIZE = 100;
const GIST_MAX_PAGES = 10;

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
    deleteFileNames: string[]
): Record<string, { content: string } | null> {
    const payload: Record<string, { content: string } | null> = {};
    for (const [name, content] of Object.entries(upsert)) {
        payload[name] = { content };
    }
    for (const name of deleteFileNames) {
        payload[name] = null;
    }
    return payload;
}

/** 唯一的同步平台适配器 */
export const githubGistProvider: ISyncProvider = {
    maxFileBytes: GITHUB_MAX_FILE_BYTES,

    async validateToken(token: string): Promise<GitHubUserInfo> {
        const response = await request('GitHub', GITHUB_NETWORK_HINT, `${GITHUB_API_BASE}/user`, {
            headers: githubHeaders(token)
        });
        if (!response.ok) {
            await throwForStatus('GitHub', response, '授权验证失败');
        }
        const user = (await response.json()) as { login: string; id: number; avatar_url: string };
        return { login: user.login, id: user.id, avatar: user.avatar_url };
    },

    async listGists(token: string): Promise<Gist[]> {
        const all: Gist[] = [];
        // GitHub 按创建时间倒序返回，一页最多 100 条。同步 Gist 可能很旧，
        // 只看第一页会认领不到，进而新建一个重复的同步空间（清理云端数据也会漏删）。
        for (let page = 1; page <= GIST_MAX_PAGES; page += 1) {
            const response = await request(
                'GitHub',
                GITHUB_NETWORK_HINT,
                `${GITHUB_API_BASE}/gists?per_page=${GIST_PAGE_SIZE}&page=${page}`,
                { headers: githubHeaders(token) }
            );
            if (!response.ok) {
                await throwForStatus('GitHub', response, '获取 Gist 列表失败');
            }
            const batch = (await response.json()) as Gist[];
            if (!Array.isArray(batch)) break;
            all.push(...batch);
            if (batch.length < GIST_PAGE_SIZE) break;
        }
        return all;
    },

    async getGistFileContent(token: string, gistId: string, fileName: string): Promise<string | null> {
        const files = await githubGistProvider.getGistFileMap(token, gistId);
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

    async deleteGist(token: string, gistId: string): Promise<void> {
        const response = await request('GitHub', GITHUB_NETWORK_HINT, `${GITHUB_API_BASE}/gists/${gistId}`, {
            method: 'DELETE',
            headers: githubHeaders(token)
        });
        // 别的设备或页面已经删过了：清理本来就是幂等的
        if (response.status === 404) return;
        if (!response.ok) {
            await throwForStatus('GitHub', response, '删除 Gist 失败');
        }
    },

    async updateGist(token: string, gistId: string, fileName: string, content: string): Promise<void> {
        await githubGistProvider.updateGistFiles(token, gistId, { [fileName]: content }, []);
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
