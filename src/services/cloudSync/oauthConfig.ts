/**
 * GitHub OAuth App 的 Client ID（应用级公开标识，不是密钥）
 *
 * 这是本项目注册的 OAuth App，内置在扩展里：所有设备、所有使用者都无需再去 GitHub
 * 申请任何东西。Device Flow 不需要 client secret，所以把公开的 Client ID 放在前端是安全的。
 *
 * 自建实例可以用 VITE_GITHUB_CLIENT_ID 在构建时覆盖内置值。
 */

/** 本项目使用的 OAuth App Client ID（已启用 Device Flow） */
export const BUILT_IN_CLIENT_ID = 'Ov23liiV3m3prP5sioJR';

/** 当前生效的 Client ID：构建注入优先，否则用内置值 */
export function githubClientId(): string {
    const fromEnv = (import.meta.env.VITE_GITHUB_CLIENT_ID as string | undefined)?.trim();
    return fromEnv || BUILT_IN_CLIENT_ID.trim();
}
