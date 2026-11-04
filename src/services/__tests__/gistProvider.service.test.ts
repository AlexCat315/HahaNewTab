/**
 * gistProvider.service 测试
 * 覆盖 GitHub / Gitee 双平台适配器：请求 URL、认证方式（Header Bearer vs Query access_token）、
 * 请求方法、详情接口截断（>1MB 的 truncated 半截正文必须改走 raw_url）、多文件写入与删除语义、
 * 错误分类（网络/超时/401/频率限制）、Gitee emoji 无损转义与两平台各自的单文件体积上限。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    createGistProvider,
    escapeForGitee,
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

describe('createGistProvider 工厂', () => {
    it("createGistProvider('github') 返回 GitHub 适配器", () => {
        const provider = createGistProvider('github');
        expect(provider.id).toBe('github');
        expect(provider.name).toBe('GitHub');
        expect(provider.tokenHint).toContain('github.com');
    });

    it("createGistProvider('gitee') 返回 Gitee 适配器", () => {
        const provider = createGistProvider('gitee');
        expect(provider.id).toBe('gitee');
        expect(provider.name).toBe('Gitee');
        expect(provider.tokenHint).toContain('gitee.com');
    });
});

describe('GitHub provider', () => {
    const provider = createGistProvider('github');

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
        // 真实行为：>1MB 的文件详情接口给 truncated:true 并且 content 只是「截断后的前半段」，
        // 把它当完整快照用，同步会在约 1MB 处静默失败
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

describe('Gitee provider', () => {
    const provider = createGistProvider('gitee');

    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('validateToken 通过 query access_token 访问 gitee.com/api/v5/user，不带 Authorization 头', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            createResponse({ login: 'gitee_user', id: 2, avatar_url: 'https://avatar2.png' })
        );
        vi.stubGlobal('fetch', fetchMock);

        const user = await provider.validateToken(TEST_TOKEN);

        expect(user.login).toBe('gitee_user');
        const [url, init] = lastFetchCall(fetchMock);
        expect(url).toBe(`https://gitee.com/api/v5/user?access_token=${TEST_TOKEN}`);
        expect((init.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
    });

    it('listGists URL 带 access_token', async () => {
        const fetchMock = vi.fn().mockResolvedValue(createResponse([]));
        vi.stubGlobal('fetch', fetchMock);

        await provider.listGists(TEST_TOKEN);

        expect(lastFetchCall(fetchMock)[0]).toBe(`https://gitee.com/api/v5/gists?per_page=100&access_token=${TEST_TOKEN}`);
    });

    it('getGistFileContent URL 带 access_token，404 返回 null', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(createResponse({ id: 'g1', files: { 'sync.json': { content: '{}' } } }));
        vi.stubGlobal('fetch', fetchMock);

        const content = await provider.getGistFileContent(TEST_TOKEN, 'g1', 'sync.json');
        expect(content).toBe('{}');
        expect(lastFetchCall(fetchMock)[0]).toBe(`https://gitee.com/api/v5/gists/g1?access_token=${TEST_TOKEN}`);

        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createResponse({ message: 'Not Found' }, 404)));
        const missing = await provider.getGistFileContent(TEST_TOKEN, 'missing', 'sync.json');
        expect(missing).toBeNull();
    });

    it('createGist 以 POST 提交 JSON body，files 结构正确', async () => {
        const fetchMock = vi.fn().mockResolvedValue(createResponse({ id: 'gitee_gist' }));
        vi.stubGlobal('fetch', fetchMock);

        const id = await provider.createGist(TEST_TOKEN, 'sync.json', '{"a":1}', '测试描述');

        expect(id).toBe('gitee_gist');
        const [url, init] = lastFetchCall(fetchMock);
        expect(url).toBe(`https://gitee.com/api/v5/gists?access_token=${TEST_TOKEN}`);
        expect(init.method).toBe('POST');
        const body = JSON.parse(init.body as string);
        expect(body.description).toBe('测试描述');
        expect(body.files['sync.json'].content).toBe('{"a":1}');
    });

    it('updateGist 以 PATCH 提交，files 项带 content 与 filename', async () => {
        const fetchMock = vi.fn().mockResolvedValue(createResponse({ id: 'g1' }));
        vi.stubGlobal('fetch', fetchMock);

        await provider.updateGist(TEST_TOKEN, 'g1', 'sync.json', '{"b":2}');

        const [url, init] = lastFetchCall(fetchMock);
        expect(url).toBe(`https://gitee.com/api/v5/gists/g1?access_token=${TEST_TOKEN}`);
        expect(init.method).toBe('PATCH');
        const body = JSON.parse(init.body as string);
        expect(body.files['sync.json'].content).toBe('{"b":2}');
        expect(body.files['sync.json'].filename).toBe('sync.json');
    });

    it('updateGistFiles 一次 PATCH 写主文件与分片，并忽略删除请求', async () => {
        const fetchMock = vi.fn().mockResolvedValue(createResponse({ id: 'g1' }));
        vi.stubGlobal('fetch', fetchMock);

        await provider.updateGistFiles(TEST_TOKEN, 'g1', {
            'haha-newtab-sync.json': '{"a":1}',
            'haha-asset-abc-0.txt': 'AAAA'
        }, ['haha-asset-old-0.txt']);

        const [, init] = lastFetchCall(fetchMock);
        expect(init.method).toBe('PATCH');
        const body = JSON.parse(init.body as string);
        expect(body.files['haha-asset-abc-0.txt'].content).toBe('AAAA');
        // Gitee 没有删除单个文件的语义：既不能把它写成 null，也不能凭空造一个删除项
        expect(body.files['haha-asset-old-0.txt']).toBeUndefined();
    });

    it('updateGistFiles 对分片同样做 emoji 转义', async () => {
        const fetchMock = vi.fn().mockResolvedValue(createResponse({ id: 'g1' }));
        vi.stubGlobal('fetch', fetchMock);

        await provider.updateGistFiles(TEST_TOKEN, 'g1', { 'sync.json': '{"name":"工具 🚀"}' }, []);

        const content = JSON.parse(lastFetchCall(fetchMock)[1].body as string).files['sync.json'].content as string;
        expect(content).not.toContain('🚀');
        expect(content).toContain('\\ud83d\\ude80');
        expect(JSON.parse(content).name).toBe('工具 🚀');
    });

    it('updateGistFiles 分片超过 Gitee 单文件 1MB 时抛错且不发请求', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        await expect(
            provider.updateGistFiles(TEST_TOKEN, 'g1', { 'haha-asset-a-0.txt': 'x'.repeat(1024 * 1024 + 1) }, [])
        ).rejects.toThrow('1MB');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('readFileFromMap 走 raw_url 时不带 access_token（Gitee 直链免鉴权）', async () => {
        const fetchMock = vi.fn().mockResolvedValue(createResponse('{"full":true}'));
        vi.stubGlobal('fetch', fetchMock);

        const content = await provider.readFileFromMap(TEST_TOKEN, {
            content: '{"trunca',
            truncated: true,
            raw_url: 'https://gitee.com/gist/raw/abc'
        });

        expect(content).toBe('{"full":true}');
        expect(lastFetchCall(fetchMock)[0]).toBe('https://gitee.com/gist/raw/abc');
    });

    it('maxFileBytes 为 Gitee 的 1MB 单文件上限', () => {
        expect(provider.maxFileBytes).toBe(1024 * 1024);
    });
});

describe('escapeForGitee', () => {
    it('纯 ASCII 内容不变', () => {
        const content = '{"name":"test","url":"https://example.com"}';
        expect(escapeForGitee(content)).toBe(content);
    });

    it('含 emoji 的 JSON 转义后不含 4 字节字符，且 JSON.parse 无损还原', () => {
        const original = {
            categories: [{ id: 'c1', name: '工具 🚀' }],
            apps: [{ id: 'a1', name: '站点', icon: '😀🔗' }]
        };
        const content = JSON.stringify(original);

        const escaped = escapeForGitee(content);

        // 转义后不再有 4 字节 UTF-8 字符（已转换为 JSON 代理对转义序列）
        expect(/[\u{10000}-\u{10FFFF}]/u.test(escaped)).toBe(false);
        // 仍是合法 JSON 且解析后与原对象完全一致
        expect(JSON.parse(escaped)).toEqual(original);
    });
});

describe('Gitee 单文件 1MB 限制', () => {
    const provider = createGistProvider('gitee');

    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('createGist 内容超过 1MB 时抛出含「1MB」的错误且不发请求', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const bigContent = 'a'.repeat(1024 * 1024 + 1);

        await expect(provider.createGist(TEST_TOKEN, 'sync.json', bigContent, 'desc'))
            .rejects.toThrow('1MB');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('updateGist 内容超过 1MB 时抛出含「1MB」的错误且不发请求', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const bigContent = 'a'.repeat(1024 * 1024 + 1);

        await expect(provider.updateGist(TEST_TOKEN, 'g1', 'sync.json', bigContent))
            .rejects.toThrow('1MB');
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('错误分类', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('fetch 抛 TypeError 时转换为「无法连接 <平台>」', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

        await expect(createGistProvider('github').validateToken(TEST_TOKEN))
            .rejects.toThrow('无法连接 GitHub，请检查网络或代理（国内可能需代理访问）');

        await expect(createGistProvider('gitee').validateToken(TEST_TOKEN))
            .rejects.toThrow('无法连接 Gitee，请检查网络连接');
    });

    it('fetch 抛 AbortError 时提示「请求超时」', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError')));

        await expect(createGistProvider('github').validateToken(TEST_TOKEN))
            .rejects.toThrow('无法连接 GitHub（请求超时）');
    });

    it('HTTP 401 抛出 SyncProviderError 且 status 为 401', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createResponse({ message: 'Bad credentials' }, 401)));

        const error = await createGistProvider('github').validateToken(TEST_TOKEN).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SyncProviderError);
        expect((error as SyncProviderError).status).toBe(401);
        expect((error as SyncProviderError).message).toBe('Token 已失效，请重新连接 GitHub');
    });

    it('HTTP 403 且消息含 rate limit 时提示「频率限制」', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createResponse({ message: 'API rate limit exceeded' }, 403)));

        const error = await createGistProvider('gitee').listGists(TEST_TOKEN).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SyncProviderError);
        expect((error as SyncProviderError).status).toBe(403);
        expect((error as SyncProviderError).message).toBe('Gitee API 频率限制，请稍后再试');
    });

    it('其他 HTTP 错误抛出带状态码的 SyncProviderError', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createResponse({ message: 'Server Error' }, 500)));

        const error = await createGistProvider('github').listGists(TEST_TOKEN).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SyncProviderError);
        expect((error as SyncProviderError).status).toBe(500);
        expect((error as SyncProviderError).message).toBe('Server Error (500)');
    });
});
