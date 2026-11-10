#!/bin/bash
# release.sh - 本地发版入口
#
# 做的事情：先跑质量门禁 → 解析下一个版本号 → 写进三份 manifest 与 npm 版本文件
#           → 提交 → 打 tag → 推送。
# 推送 tag 后 GitHub Actions 会自动构建、签名、发 Release、更新 updates.json。
#
# 为什么门禁放在本地：以前脚本只做版本 + 提交 + 推送，测试第一次运行是在 push 之后
# 的 CI 上；一旦失败，tag 已经推上去，修完还得再发一个版本（Edge 商店要求版本严格递增）。
# 现在门禁不过就直接退出，不产生提交、不产生 tag、不消耗版本号。
# 门禁用 CI=true，保证与 GitHub Actions 的 vitest / vite 行为一致。
#
# 用法：
#   ./scripts/release.sh                    # 自动版本 +1，并跑完整门禁
#   ./scripts/release.sh 1.0.2.0            # 指定版本号（必须大于已发布的最新版本）
#   ./scripts/release.sh --dry-run          # 只跑门禁并打印计划版本，不改动任何文件、不推送
#   ./scripts/release.sh --skip-check       # 紧急发版：跳过门禁与构建验证（不推荐）
#   以上参数可组合，如 ./scripts/release.sh 1.0.2.0 --dry-run
#
# 断点续推：
#   如果上次提交和 tag 都建好了但推送失败（网络抖动、SSL_ERROR_SYSCALL 等），
#   直接重新运行本脚本即可——它会检测到 HEAD 上未推送的 tag，跳过版本递增，
#   只把已有的提交和 tag 补推上去，不会白白消耗一个版本号。
#
# 注意：版本号只允许 1~4 段数字（每段 0~65535），且不能与已发布版本重复，
# 否则 web-ext sign 会报 "This upload has already been submitted"。
# 版本号一律以 git tag 与 manifest 为准，不再使用可被意外清零的 .build-num。

set -euo pipefail
cd "$(dirname "$0")/.."

REMOTE="origin"
TAG=""

print_usage() {
    cat <<'EOF'
用法：
  ./scripts/release.sh [版本号] [--dry-run] [--skip-check]

  --dry-run      只跑门禁并打印计划版本，不写文件、不提交、不推送
  --skip-check   跳过门禁与构建验证（仅紧急发版使用）
EOF
}

# ---------------------------------------------------------------
# 参数解析：版本号至多一个，标志可任意顺序
# ---------------------------------------------------------------
SKIP_CHECK=0
DRY_RUN=0
VERSION_ARG=""
for arg in "$@"; do
    case "$arg" in
        --skip-check) SKIP_CHECK=1 ;;
        --dry-run) DRY_RUN=1 ;;
        -h|--help) print_usage; exit 0 ;;
        -*) echo "❌ 未知参数: ${arg}"; print_usage; exit 1 ;;
        *)
            if [ -n "$VERSION_ARG" ]; then
                echo "❌ 只能指定一个版本号: ${VERSION_ARG} 与 ${arg}"
                exit 1
            fi
            VERSION_ARG="$arg"
            ;;
    esac
done

# ---------------------------------------------------------------
# 质量门禁：与 .github/workflows/ci.yml 和 release.yml 完全同一组检查
# ---------------------------------------------------------------
run_quality_gates() {
    echo "🔍 质量门禁（CI=true，与 GitHub Actions 一致）..."
    if ! CI=true npm run check; then
        echo ""
        echo "❌ 质量门禁未通过，已中止发版。"
        echo "   没有写入版本号、没有创建提交或 tag、没有推送；版本号不会被消耗。"
        exit 1
    fi

    echo "🔍 构建三个目标（chromium / firefox / edge）..."
    local target
    for target in chromium firefox edge; do
        if ! CI=true npm run "build:${target}"; then
            echo ""
            echo "❌ build:${target} 失败，已中止发版（未提交、未打 tag）。"
            exit 1
        fi
    done
    echo "✅ 门禁通过"
    echo ""
}

# ---------------------------------------------------------------
# 推送（带重试）
# ---------------------------------------------------------------
push_with_retry() {
    local attempt wait_seconds
    for attempt in 1 2 3; do
        echo "  推送尝试 ${attempt}/3..."
        if git push "$REMOTE" HEAD && git push "$REMOTE" "$TAG"; then
            return 0
        fi
        if [ "$attempt" -lt 3 ]; then
            wait_seconds=$((attempt * 5))
            echo "  ⚠️  推送失败，${wait_seconds} 秒后重试"
            sleep "$wait_seconds"
        fi
    done
    return 1
}

print_push_failed_hint() {
    echo ""
    echo "❌ 推送失败。提交和 tag 已经在本地建好了，没有丢失。"
    echo "   网络恢复后直接重新运行本脚本即可补推："
    echo "     ./scripts/release.sh"
    echo "   或者手动推送："
    echo "     git push ${REMOTE} HEAD && git push ${REMOTE} ${TAG}"
    echo ""
    echo "   注意：不要手动再升版本号，否则 ${TAG} 会变成一个永远推不上去的废 tag。"
}

# ---------------------------------------------------------------
# 断点续推：HEAD 已打 tag 但远端没有 → 说明上次推送失败，只补推
# ---------------------------------------------------------------
EXISTING_TAG="$(git tag --points-at HEAD | grep -E '^v[0-9]' | head -n 1 || true)"

if [ -n "$EXISTING_TAG" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
        echo "🧪 dry-run：检测到待补推的 ${EXISTING_TAG}，只跑门禁，不推送"
        if [ "$SKIP_CHECK" -eq 0 ]; then run_quality_gates; fi
        echo "   （真实发版时本分支会直接补推 ${EXISTING_TAG}）"
        exit 0
    fi
    if ! git ls-remote --exit-code --tags "$REMOTE" "refs/tags/${EXISTING_TAG}" >/dev/null 2>&1; then
        TAG="$EXISTING_TAG"
        echo "🔄 检测到 ${TAG} 已在本地提交但尚未推送到 ${REMOTE}"
        echo "   跳过版本递增，直接补推已有的提交和 tag"
        echo ""
        if push_with_retry; then
            echo ""
            echo "✅ 已推送 ${TAG}"
            echo "   GitHub Actions 会开始构建并发布"
            exit 0
        fi
        print_push_failed_hint
        exit 1
    fi
fi

# ---------------------------------------------------------------
# 正常发版：解析版本号
# ---------------------------------------------------------------
# 先同步远端 tag，保证「最新版本」判断基于当前真实发版历史；
# 离线时拉取失败也不阻塞，回退到本地 tag + manifest。
git fetch --tags --quiet 2>/dev/null || true

if [ -n "$VERSION_ARG" ]; then
    VERSION="$(node scripts/resolve-version.js "$VERSION_ARG")"
else
    VERSION="$(node scripts/resolve-version.js)"
fi

TAG="v${VERSION}"

if git rev-parse "$TAG" >/dev/null 2>&1; then
    echo "❌ 本地已存在 tag ${TAG}，请换一个版本号"
    exit 1
fi

# ---------------------------------------------------------------
# 工作区检查
# ---------------------------------------------------------------
# 未跟踪的新文件不会被 git add -u 收进提交：本地有、远端没有，CI 跑的就是另一套代码。
# 已知的本地辅助目录不算（.gitignore 之外的项目数据目录）。
UNTRACKED="$(git ls-files --others --exclude-standard \
    | grep -vE '^(\.codebuddy/|\.workbuddy-ai/)' || true)"
if [ -n "$UNTRACKED" ]; then
    echo "❌ 检测到未跟踪的新文件，git add -u 不会提交它们："
    printf '   %s\n' "$UNTRACKED" | head -20
    echo ""
    echo "   请先 git add 需要的文件，或把不需要的写进 .gitignore，再重新发版。"
    exit 1
fi

# 工作区有未提交改动时先停下；门禁跑的是当前工作区代码，选 y 会把这些改动一起发版
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "⚠️  工作区存在未提交的改动："
    git status --short --untracked-files=no
    echo ""
    if [ "$DRY_RUN" -eq 1 ]; then
        # dry-run 不提交任何东西，不需要也不该在这里等交互输入
        echo "   （dry-run：不会提交这些改动，继续验证门禁）"
    else
        read -r -p "仍然继续发版？这些改动会被一起提交 [y/N] " REPLY
        case "$REPLY" in
            [yY]) ;;
            *) echo "已取消"; exit 1 ;;
        esac
    fi
fi

# ---------------------------------------------------------------
# 门禁：失败就地退出，绝不产生提交 / tag
# ---------------------------------------------------------------
if [ "$SKIP_CHECK" -eq 1 ]; then
    echo "⚠️  --skip-check：跳过质量门禁与构建验证（仅供紧急发版）"
    echo ""
else
    run_quality_gates
fi

if [ "$DRY_RUN" -eq 1 ]; then
    echo "🧪 dry-run 完成。"
    echo "   计划版本：${VERSION}（tag ${TAG}）"
    echo "   未写入版本号、未提交、未打 tag、未推送。"
    exit 0
fi

# ---------------------------------------------------------------
# 写版本号：三份 manifest + npm 版本文件，一次同步避免长期漂移
# ---------------------------------------------------------------
echo "🔧 设置版本号: ${VERSION}"
node -e '
    const fs = require("fs");
    const version = process.argv[1];
    // 三个目标（Chrome / Edge / Firefox）共用同一版本号：
    // Edge 商店要求每次提交的版本号严格递增，漏掉任一份 manifest 都会让
    // 该目标的版本号停留在旧值，下次提交时被判定为「版本未提升」而拒绝。
    for (const f of ["manifest.json", "manifest.edge.json", "manifest.firefox.json"]) {
        const j = JSON.parse(fs.readFileSync(f, "utf8"));
        j.version = version;
        fs.writeFileSync(f, JSON.stringify(j, null, 4) + "\n");
        console.log("   " + f + " -> v" + version);
    }
    // package.json / package-lock.json 也跟着走：release.yml 的 stamp 只改 CI 工作区，
    // 不回写仓库，光靠它这两个文件会永远落后一个版本。
    // 两个文件原本就是 JSON.stringify(..., null, 2) 的格式，重写不会带来额外 diff。
    for (const f of ["package.json", "package-lock.json"]) {
        const j = JSON.parse(fs.readFileSync(f, "utf8"));
        j.version = version;
        if (f === "package-lock.json" && j.packages && j.packages[""]) {
            j.packages[""].version = version;
        }
        fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
        console.log("   " + f + " -> v" + version);
    }
' "$VERSION"

# 只提交已跟踪文件的改动：避免把本地构建产物等文件带进仓库。
# 新增文件已在上面被拦下并要求先 git add，所以这里不会漏文件。
git add -u
git commit -m "chore(release): v${VERSION}"
git tag "$TAG"

echo ""
echo "🚀 推送提交与 tag..."
if ! push_with_retry; then
    print_push_failed_hint
    exit 1
fi

echo ""
echo "✅ 已推送 ${TAG}"
echo "   GitHub Actions 会开始构建并发布："
echo "   https://github.com/$(git remote get-url "$REMOTE" | sed -E 's#.*github.com[:/](.+)\.git#\1#')/actions"
