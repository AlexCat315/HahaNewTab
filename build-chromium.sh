#!/bin/bash
set -e

cd "$(dirname "$0")"

echo "=========================================="
echo "  HahaNewTab - Chromium 扩展构建脚本"
echo "=========================================="
echo ""

# 清理旧的构建目录
# dist-chrome 是增量输出（--emptyOutDir=false），不清空会把已删除的旧资源
# 一并复制进发布包，所以每次构建前必须重建
for d in build-chromium dist-chrome; do
    if [ -d "$d" ]; then
        echo "🧹 清理旧构建目录 $d/..."
        rm -rf "$d"
    fi
done

echo "📦 构建 Chromium 版本..."
npm run build:chromium

echo ""
echo "📂 复制构建产物到 build-chromium/..."
mkdir -p build-chromium
cp -r dist-chrome/* build-chromium/

echo ""
echo "✅ 构建完成"
echo ""
echo "构建内容："
ls -1 build-chromium
echo ""
