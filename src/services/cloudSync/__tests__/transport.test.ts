/**
 * 传输层：同步空间认领、分页查找与删除
 * 这些路径以前没有单测，>100 个 Gist 时重复创建同步空间的问题就是漏在这里。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    findOrCreateGist,
    findSyncGist,
    deleteSyncGist,
    SYNC_FILE_NAME
} from '@/services/cloudSync/transport';

const TARGET = { token: 'gho_test' };

function createResponse(body: unknown, status = 200): Response {
    return {
        status,
        ok: status >= 200 && status < 300,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body))
    } as Response;
}

function gist(id: string, withSyncFile = true) {
    return { id, description: null, public: false, files: withSyncFile ? { [SYNC_FILE_NAME]: { content: '{}' } } : {} };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('findSyncGist', () => {
    it('按同步文件名认领现成的 Gist', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
            createResponse([gist('other', false), gist('sync_1')])
        ));
        expect(await findSyncGist(TARGET)).toBe('sync_1');
    });

    it('第一页满 100 条时继续翻页，找到排在后面的同步 Gist', async () => {
        const firstPage = Array.from({ length: 100 }, (_unused, index) => gist(`g${index}`, false));
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(createResponse(firstPage))
            .mockResolvedValueOnce(createResponse([gist('old_sync')]));
        vi.stubGlobal('fetch', fetchMock);

        expect(await findSyncGist(TARGET)).toBe('old_sync');
        expect(fetchMock.mock.calls[1][0]).toContain('page=2');
    });

    it('没有同步 Gist 时返回 null', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createResponse([gist('other', false)])));
        expect(await findSyncGist(TARGET)).toBeNull();
    });
});

describe('deleteSyncGist', () => {
    it('以 DELETE 删除整个 Gist', async () => {
        const fetchMock = vi.fn().mockResolvedValue(createResponse({}, 204));
        vi.stubGlobal('fetch', fetchMock);

        await deleteSyncGist(TARGET, 'sync_1');

        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://api.github.com/gists/sync_1');
        expect(init.method).toBe('DELETE');
    });
});

describe('findOrCreateGist', () => {
    it('已记录的 gistId 仍含主文件时直接复用，不新建', async () => {
        const fetchMock = vi.fn().mockResolvedValue(createResponse(gist('known')));
        vi.stubGlobal('fetch', fetchMock);

        expect(await findOrCreateGist(TARGET, 'known')).toBe('known');
        expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit)?.method === 'POST')).toBe(false);
    });

    it('没有记录时按文件名认领，不重复创建', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(createResponse([gist('existing')]))
            .mockResolvedValueOnce(createResponse({ id: 'new_gist' }));
        vi.stubGlobal('fetch', fetchMock);

        expect(await findOrCreateGist(TARGET, null)).toBe('existing');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
