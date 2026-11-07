/**
 * GitHub OAuth Device Flow（设备授权流程）
 *
 * 扩展是纯前端：没有后端可以保管 client secret，也不该让用户去申请并粘贴个人 Token。
 * Device Flow 只用一个公开的 client_id，由 GitHub 下发一次性授权码，用户在浏览器里
 * 确认后扩展轮询换取 access_token，全程不需要 client secret、重定向页或 identity 权限。
 *
 * 拿到的 token 带 `gist` scope，长期有效；撤销或过期时 Gist 请求会返回 401，
 * 由 CloudSyncService 清掉本地凭据并回到「未连接」，用户重新点一次授权即可。
 */

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const FALLBACK_VERIFICATION_URI = 'https://github.com/login/device';
const REQUEST_TIMEOUT_MS = 10000;

/** 需要用户授予的权限：读写私密 Gist */
export const GITHUB_OAUTH_SCOPE = 'gist';

/** 创建 OAuth App 的入口，面板里的配置说明用 */
export const OAUTH_APP_SETUP_URL = 'https://github.com/settings/developers';

export type GitHubOAuthErrorReason =
    | 'config'
    | 'cancelled'
    | 'network'
    | 'timeout'
    | 'expired'
    | 'denied'
    | 'http'
    | 'invalid-response';

/** 授权流程的失败原因自带分类，界面据此决定提示语与是否允许重试 */
export class GitHubOAuthError extends Error {
    readonly reason: GitHubOAuthErrorReason;

    constructor(message: string, reason: GitHubOAuthErrorReason) {
        super(message);
        this.name = 'GitHubOAuthError';
        this.reason = reason;
    }
}

/** GitHub 下发的一次性授权信息 */
export interface DeviceAuthorization {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    intervalMs: number;
    expiresAt: number;
}

interface OAuthResponse {
    device_code?: unknown;
    user_code?: unknown;
    verification_uri?: unknown;
    interval?: unknown;
    expires_in?: unknown;
    access_token?: unknown;
    scope?: unknown;
    error?: unknown;
    error_description?: unknown;
}

function asString(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function cancelled(): GitHubOAuthError {
    return new GitHubOAuthError('已取消授权', 'cancelled');
}

/**
 * 发一次表单请求，同时受「单次请求超时」与「调用方取消」两个开关控制。
 *
 * GitHub 的这两个端点接受 form-urlencoded 参数，并在 `Accept: application/json`
 * 时返回 JSON；HTTP 200 也可能带 `error` 字段，所以这里不按状态码判成败。
 */
async function postForm(
    url: string,
    params: Record<string, string>,
    signal?: AbortSignal
): Promise<OAuthResponse> {
    if (signal?.aborted) throw cancelled();

    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams(params).toString(),
            signal: controller.signal
        });
        if (!response.ok) {
            throw new GitHubOAuthError(
                `GitHub 授权服务返回 ${response.status}，请稍后重试`,
                'http'
            );
        }
        return (await response.json()) as OAuthResponse;
    } catch (e) {
        if (e instanceof GitHubOAuthError) throw e;
        if (signal?.aborted) throw cancelled();
        if (timedOut) {
            throw new GitHubOAuthError('连接 GitHub 授权服务超时，请检查网络后重试', 'timeout');
        }
        throw new GitHubOAuthError('无法连接 GitHub 授权服务，请检查网络或代理', 'network');
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
}

/** 可取消的等待；取消时不留下悬空的定时器 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(cancelled());
            return;
        }
        const onAbort = (): void => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            reject(cancelled());
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * 第一步：向 GitHub 申请设备码与用户码。
 * 用户码要在面板里展示给用户，由用户在 verificationUri 页面输入确认。
 */
export async function requestDeviceCode(
    clientId: string,
    signal?: AbortSignal
): Promise<DeviceAuthorization> {
    const id = clientId.trim();
    if (!id) {
        throw new GitHubOAuthError('尚未配置 OAuth App 的 Client ID', 'config');
    }

    const body = await postForm(DEVICE_CODE_URL, {
        client_id: id,
        scope: GITHUB_OAUTH_SCOPE
    }, signal);

    const deviceCode = asString(body.device_code);
    const userCode = asString(body.user_code);
    if (!deviceCode || !userCode) {
        const detail = asString(body.error_description) || asString(body.error);
        throw new GitHubOAuthError(
            detail ? `GitHub 未下发授权码：${detail}` : 'GitHub 未下发授权码，请检查 Client ID 是否启用了 Device Flow',
            'invalid-response'
        );
    }

    return {
        deviceCode,
        userCode,
        verificationUri: asString(body.verification_uri) || FALLBACK_VERIFICATION_URI,
        intervalMs: Math.max(1000, asNumber(body.interval, 5) * 1000),
        expiresAt: Date.now() + Math.max(30, asNumber(body.expires_in, 900)) * 1000
    };
}

/**
 * 第二步：轮询换取 access_token。
 *
 * `authorization_pending` 是正常等待，`slow_down` 要按 GitHub 要求把间隔加 5 秒；
 * 其余 error 都是终态失败。整体有效期取 GitHub 下发的 expires_in，
 * 避免用户一直不确认时后台永远轮询下去。
 */
export async function pollForAccessToken(
    clientId: string,
    authorization: DeviceAuthorization,
    signal?: AbortSignal
): Promise<string> {
    let intervalMs = authorization.intervalMs;

    while (true) {
        if (signal?.aborted) throw cancelled();
        if (Date.now() >= authorization.expiresAt) {
            throw new GitHubOAuthError('授权码已过期，请重新发起登录', 'expired');
        }

        await sleep(Math.min(intervalMs, authorization.expiresAt - Date.now()), signal);

        const body = await postForm(ACCESS_TOKEN_URL, {
            client_id: clientId.trim(),
            device_code: authorization.deviceCode,
            grant_type: DEVICE_GRANT_TYPE
        }, signal);

        const accessToken = asString(body.access_token);
        if (accessToken) {
            const scope = asString(body.scope);
            // scope 为空串时 GitHub 是按应用默认授权返回的，不做额外拦截
            if (scope && !scope.split(',').some(part => part.trim() === GITHUB_OAUTH_SCOPE)) {
                throw new GitHubOAuthError(
                    '授权范围不包含 Gist 权限，请重新授权并允许访问 Gist',
                    'denied'
                );
            }
            return accessToken;
        }

        switch (body.error) {
            case 'authorization_pending':
                break;
            case 'slow_down':
                intervalMs += 5000;
                break;
            case 'expired_token':
                throw new GitHubOAuthError('授权码已过期，请重新发起登录', 'expired');
            case 'access_denied':
                throw new GitHubOAuthError('你已在 GitHub 取消授权', 'denied');
            default: {
                const detail = asString(body.error_description) || asString(body.error);
                throw new GitHubOAuthError(
                    detail ? `授权失败：${detail}` : '授权失败，请稍后重试',
                    'http'
                );
            }
        }
    }
}
