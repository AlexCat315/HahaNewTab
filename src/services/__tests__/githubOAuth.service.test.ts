/**
 * GitHub Device Flow 单测
 * 覆盖：设备码申请、轮询状态机（pending / slow_down / 终态错误）、
 * 凭据范围校验、取消与超时分类。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    GitHubOAuthError,
    pollForAccessToken,
    requestDeviceCode
} from '@/services/githubOAuth.service';
import type { DeviceAuthorization } from '@/services/githubOAuth.service';

const CLIENT_ID = 'Iv1.testclient';

function createResponse(body: unknown, status = 200): Response {
    return {
        status,
        ok: status >= 200 && status < 300,
        json: () => Promise.resolve(body)
    } as Response;
}

function deviceCodeBody(): Record<string, unknown> {
    return {
        device_code: 'dc_123',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        interval: 5,
        expires_in: 900
    };
}

function authorization(overrides: Partial<DeviceAuthorization> = {}): DeviceAuthorization {
    return {
        deviceCode: 'dc_123',
        userCode: 'ABCD-1234',
        verificationUri: 'https://github.com/login/device',
        intervalMs: 1000,
        expiresAt: Date.now() + 60000,
        ...overrides
    };
}

/**
 * 立刻挂上 catch：fake timers 推进期间就 reject 的 Promise，
 * 不能等到断言时才处理，否则 Vitest 会把它算成未处理的拒绝。
 */
function capture(promise: Promise<unknown>): Promise<GitHubOAuthError> {
    return promise.then(
        () => { throw new Error('预期授权失败，但流程成功了'); },
        (e: unknown) => e as GitHubOAuthError
    );
}

async function failure(promise: Promise<unknown>): Promise<GitHubOAuthError> {
    return await capture(promise);
}

describe('requestDeviceCode', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('把 client_id 与 gist scope 发往设备码端点', async () => {
        const fetchMock = vi.fn().mockResolvedValue(createResponse(deviceCodeBody()));
        vi.stubGlobal('fetch', fetchMock);

        const result = await requestDeviceCode(CLIENT_ID);

        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://github.com/login/device/code');
        expect(init.method).toBe('POST');
        expect(init.body).toContain(`client_id=${CLIENT_ID}`);
        expect(init.body).toContain('scope=gist');
        expect(result.userCode).toBe('ABCD-1234');
        expect(result.deviceCode).toBe('dc_123');
        expect(result.intervalMs).toBe(5000);
        expect(result.verificationUri).toBe('https://github.com/login/device');
    });

    it('没配 Client ID 时直接拒绝，不发请求', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        const error = await failure(requestDeviceCode('  '));

        expect(error).toBeInstanceOf(GitHubOAuthError);
        expect(error.reason).toBe('config');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('GitHub 未下发授权码时给出可照做的提示', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createResponse({
            error: 'device_flow_disabled',
            error_description: 'Device flow is not enabled for this app'
        })));

        const error = await failure(requestDeviceCode(CLIENT_ID));

        expect(error.reason).toBe('invalid-response');
        expect(error.message).toContain('Device flow is not enabled');
    });

    it('网络不可达与 HTTP 错误分别归类', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
        expect((await failure(requestDeviceCode(CLIENT_ID))).reason).toBe('network');

        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createResponse({}, 500)));
        expect((await failure(requestDeviceCode(CLIENT_ID))).reason).toBe('http');
    });

    it('调用前就取消时不再发请求', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const controller = new AbortController();
        controller.abort();

        const error = await failure(requestDeviceCode(CLIENT_ID, controller.signal));

        expect(error.reason).toBe('cancelled');
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('pollForAccessToken', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('等待确认并遵守 slow_down 后返回 access_token', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(createResponse({ error: 'authorization_pending' }))
            .mockResolvedValueOnce(createResponse({ error: 'slow_down' }))
            .mockResolvedValueOnce(createResponse({ access_token: 'gho_result', scope: 'gist' }));
        vi.stubGlobal('fetch', fetchMock);

        const pending = pollForAccessToken(CLIENT_ID, authorization());
        await vi.advanceTimersByTimeAsync(1000);
        await vi.advanceTimersByTimeAsync(1000);
        await vi.advanceTimersByTimeAsync(6000);

        await expect(pending).resolves.toBe('gho_result');
        expect(fetchMock).toHaveBeenCalledTimes(3);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://github.com/login/oauth/access_token');
        expect(init.body).toContain('device_code=dc_123');
        expect(init.body).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code');
    });

    it('授权码过期与用户拒绝都是终态失败', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createResponse({ error: 'expired_token' })));
        const expired = capture(pollForAccessToken(CLIENT_ID, authorization()));
        await vi.advanceTimersByTimeAsync(1000);
        expect((await expired).reason).toBe('expired');

        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createResponse({ error: 'access_denied' })));
        const denied = capture(pollForAccessToken(CLIENT_ID, authorization()));
        await vi.advanceTimersByTimeAsync(1000);
        expect((await denied).reason).toBe('denied');
    });

    it('整体有效期到了就不再轮询', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        const error = await failure(pollForAccessToken(CLIENT_ID, authorization({
            expiresAt: Date.now() - 1
        })));

        expect(error.reason).toBe('expired');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('授权范围不含 gist 时拒绝这份凭据', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createResponse({
            access_token: 'gho_wrong_scope',
            scope: 'repo'
        })));

        const settled = capture(pollForAccessToken(CLIENT_ID, authorization()));
        await vi.advanceTimersByTimeAsync(1000);
        const error = await settled;

        expect(error.reason).toBe('denied');
        expect(error.message).toContain('Gist');
    });

    it('取消会立刻停下轮询，不留后台请求', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const controller = new AbortController();

        const settled = capture(pollForAccessToken(CLIENT_ID, authorization(), controller.signal));
        controller.abort();

        expect((await settled).reason).toBe('cancelled');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('单次请求超时归类为 timeout', async () => {
        vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) =>
            new Promise((_resolve, reject) => {
                init.signal?.addEventListener('abort', () => {
                    reject(new DOMException('The operation was aborted.', 'AbortError'));
                });
            })
        ));

        const settled = capture(pollForAccessToken(CLIENT_ID, authorization()));
        await vi.advanceTimersByTimeAsync(11000);

        expect((await settled).reason).toBe('timeout');
    });
});
