/**
 * gistProvider.service 测试
 * 覆盖 GitHub Gist 客户端：请求 URL、Bearer 认证头、请求方法、
 * 详情接口截断（>1MB 的 truncated 半截正文必须改走 raw_url）、多文件写入与删除语义、
 * 错误分类（网络/超时/401/频率限制）与单文件体积上限。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    githubGistProvider as provider,
    SyncProviderError
} from '@/services/gistProvider.service';

const TEST_TOKEN = 'test_token_123';

function createResponse(body: unknown, status = 200): Response {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
        status,
        ok: status >= 200 && status < 300,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(text)
    } as Response;
}

/** 获取 mock fetch 最近一次调用的 url 与 init */
function lastFetchCall(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit] {
    const calls = fetchMock.mock.calls;
    return calls[calls.length - 1] as [string, RequestInit];
}

describe('GitHub Gist 客户端', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('validateToken 使用 Bearer 头与 API 版本头访问 api.github.com/user', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            createResponse({ login: 'tester', id: 1, avatar_url: 'https://avatar.png' })
        );
        vi.stubGlobal('fetch', fetchMock);

        const user = await provider.validateToken(TEST_TOKEN);

        expect(user).toEqual({ login: 'tester', id: 1, avatar: 'https://avatar.png' });
        const [url, init] = lastFetchCall(fetchMock);
        expect(url).toBe('https://api.github.com/user');
        const headers = init.headers as Record<string, string>;
        expect(headers.Authorization).toBe(`Bearer ${TEST_TOKEN}`);
        expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    });

    it('listGists 访问 /gists?per_page=100 并返回列表', async () => {
        const gists = [{ id: 'g1', files: {} }];
        const fetchMock = vi.fn().mockResolvedValue(createResponse(gists));
        vi.stubGlobal('fetch', fetchMock);

        const result = await provider.listGists(TEST_TOKEN);

        expect(result).toEqual(gists);
        expect(lastFetchCall(fetchMock)[0]).toBe('https://api.github.com/gists?per_page=100');
    });

    it('getGistFileContent 返回指定文件内容', async () => {
        const fetchMock = vi.fn().mockResolvedValue(createResponse({
            id: 'g1',
            files: { 'sync.json': { content: '{"version":"1.0"}' } }
        }));
        vi.stubGlobal('fetch', fetchMock);

        const content = await provider.getGistFileContent(TEST_TOKEN, 'g1', 'sync.json');

        expect(content).toBe('{"version":"1.0"}');
        expect(lastFetchCall(fetchMock)[0]).toBe('https://api.github.com/gists/g1');
    });

    it('getGistFileContent 在 Gist 404 时返回 null', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createResponse({ message: 'Not Found' }, 404)));

        const content = await provider.getGistFileContent(TEST_TOKEN, 'missing', 'sync.json');

        expect(content).toBeNull();
    });

    it('getGistFileContent 在文件缺失时返回 null', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createResponse({ id: 'g1', files: {} })));

        const content = await provider.getGistFileContent(TEST_TOKEN, 'g1', 'sync.json');

        expect(content).toBeNull();
    });

    it('getGistFileContent 在详情接口截断（truncated + 半截正文）时改用 raw_url 取全文', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(createResponse({
                id: 'g1',
                files: {
                    'sync.json': {
                        content: '{"version":"1.1","data":{"pe',
                        truncated: true,
                        raw_url: 'https://gist.githubusercontent.com/raw/abc'
                    }
                }
            }))
            .mockResolvedValueOnce(createResponse('{"version":"1.1","data":{}}'));
        vi.stubGlobal('fetch', fetchMock);

        const content = await provider.getGistFileContent(TEST_TOKEN, 'g1', 'sync.json');

        expect(content).toBe('{"version":"1.1","data":{}}');
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(lastFetchCall(fetchMock)[0]).toBe('https://gist.githubusercontent.com/raw/abc');
    });

    it('readFileFromMap 对小文件直接用 inline 正文，不多发一次请求', async () => {
        const fetchMock = vi.fn().mockResolvedValue(createResponse('unused'));
        vi.stubGlobal('fetch', fetchMock);

        const content = await provider.readFileFromMap(TEST_TOKEN, {
            content: '{"a":1}',
            truncated: false,
            raw_url: 'https://gist.githubusercontent.com/raw/abc'
        });

        expect(content).toBe('{"a":1}');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('readFileFromMap 在 raw_url 也取不到时返回 null，而不是半截正文', async () => {
        const fetchMock = vi.fn().mockResolvedValue(createResponse({ message: 'Not Found' }, 404));
        vi.stubGlobal('fetch', fetchMock);

        const content = await provider.readFileFromMap(TEST_TOKEN, {
            content: '{"a":',
            truncated: true,
            raw_url: 'https://gist.githubusercontent.com/raw/abc'
        });

        expect(content).toBeNull();
    });

    it('getGistFileMap 返回完整文件表', async () => {
        const fetchMock = vi.fn().mockResolvedValue(createResponse({
            id: 'g1',
            files: { 'a.txt': { content: 'A' }, 'b.txt': { content: 'B' } }
        }));
        vi.stubGlobal('fetch', fetchMock);

        const files = await provider.getGistFileMap(TEST_TOKEN, 'g1');

        expect(Object.keys(files ?? {})).toEqual(['a.txt', 'b.txt']);
        expect(lastFetchCall(fetchMock)[0]).toBe('https://api.github.com/gists/g1');
    });

    it('updateGistFiles 一次 PATCH 同时写新分片、改主文件、删旧分片', async () => {
        const fetchMock = vi.fn().mockResolvedValue(createResponse({ id: 'g1' }));
        vi.stubGlobal('fetch', fetchMock);

        await provider.updateGistFiles(TEST_TOKEN, 'g1', {
            'haha-newtab-sync.json': '{"a":1}',
            'haha-asset-abc-0.txt': 'AAAA'
        }, ['haha-asset-old-0.txt']);

        const [url, init] = lastFetchCall(fetchMock);
        expect(url).toBe('https://api.github.com/gists/g1');
        expect(init.method).toBe('PATCH');
        const body = JSON.parse(init.body as string);
        expect(body.files['haha-newtab-sync.json'].content).toBe('{"a":1}');
        expect(body.files['haha-asset-abc-0.txt'].content).toBe('AAAA');
        // null 是 Gist API 的删除语义
        expect(body.files['haha-asset-old-0.txt']).toBeNull();
    });

    it('createGist 内容超过 GitHub 单文件 10MB 时抛错且不发请求', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        await expect(
            provider.createGist(TEST_TOKEN, 'sync.json', 'x'.repeat(11 * 1024 * 1024), '描述')
        ).rejects.toThrow('10MB');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('maxFileBytes 供资源通道换算分片大小', () => {
        expect(provider.maxFileBytes).toBe(10 * 1024 * 1024);
    });

    it('createGist 以 POST 创建并返回 Gist id', async () => {
        const fetchMock = vi.fn().mockResolvedValue(createResponse({ id: 'new_gist' }));
        vi.stubGlobal('fetch', fetchMock);

        const id = await provider.createGist(TEST_TOKEN, 'sync.json', '{"a":1}', '测试描述');

        expect(id).toBe('new_gist');
        const [url, init] = lastFetchCall(fetchMock);
        expect(url).toBe('https://api.github.com/gists');
        expect(init.method).toBe('POST');
        const body = JSON.parse(init.body as string);
        expect(body.description).toBe('测试描述');
        expect(body.public).toBe(false);
        expect(body.files['sync.json'].content).toBe('{"a":1}');
    });

    it('updateGist 以 PATCH 更新文件内容', async () => {
        const fetchMock = vi.fn().mockResolvedValue(createResponse({ id: 'g1' }));
        vi.stubGlobal('fetch', fetchMock);

        await provider.updateGist(TEST_TOKEN, 'g1', 'sync.json', '{"b":2}');

        const [url, init] = lastFetchCall(fetchMock);
        expect(url).toBe('https://api.github.com/gists/g1');
        expect(init.method).toBe('PATCH');
        const body = JSON.parse(init.body as string);
        expect(body.files['sync.json'].content).toBe('{"b":2}');
    });
});

describe('错误分类', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('fetch 抛 TypeError 时转换为「无法连接 GitHub」', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

        await expect(provider.validateToken(TEST_TOKEN))
            .rejects.toThrow('无法连接 GitHub，请检查网络或代理（国内可能需代理访问）');
    });

    it('fetch 抛 AbortError 时提示「请求超时」', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError')));

        await expect(provider.validateToken(TEST_TOKEN))
            .rejects.toThrow('无法连接 GitHub（请求超时）');
    });

    it('HTTP 401 抛出 SyncProviderError 且 status 为 401', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createResponse({ message: 'Bad credentials' }, 401)));

        const error = await provider.validateToken(TEST_TOKEN).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SyncProviderError);
        expect((error as SyncProviderError).status).toBe(401);
        expect((error as SyncProviderError).message).toBe('授权已失效，请重新登录 GitHub');
    });

    it('HTTP 403 且消息含 rate limit 时提示「频率限制」', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createResponse({ message: 'API rate limit exceeded' }, 403)));

        const error = await provider.listGists(TEST_TOKEN).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SyncProviderError);
        expect((error as SyncProviderError).status).toBe(403);
        expect((error as SyncProviderError).message).toBe('GitHub API 频率限制，请稍后再试');
    });

    it('其他 HTTP 错误抛出带状态码的 SyncProviderError', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createResponse({ message: 'Server Error' }, 500)));

        const error = await provider.listGists(TEST_TOKEN).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SyncProviderError);
        expect((error as SyncProviderError).status).toBe(500);
        expect((error as SyncProviderError).message).toBe('Server Error (500)');
    });
});
