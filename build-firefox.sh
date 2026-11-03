#!/bin/bash
set -e

cd "$(dirname "$0")"

echo "=========================================="
echo "  HahaNewTab - Firefox 扩展构建脚本"
echo "=========================================="
echo ""

# 清理旧的构建目录
# dist-firefox 是增量输出（--emptyOutDir=false），不清空会把已删除的旧资源
# 一并复制进发布包，所以每次构建前必须重建
for d in build-firefox dist-firefox; do
    if [ -d "$d" ]; then
        echo "🧹 清理旧构建目录 $d/..."
        rm -rf "$d"
    fi
done

echo "📦 构建 Firefox 版本..."
npm run build:firefox

echo ""
echo "📂 复制构建产物到 build-firefox/..."
mkdir -p build-firefox
cp -r dist-firefox/* build-firefox/

echo ""
echo "✅ 构建完成"
echo ""
echo "构建内容："
ls -1 build-firefox
echo ""
echo "运行 ./sign-firefox.sh 进行签名。"
