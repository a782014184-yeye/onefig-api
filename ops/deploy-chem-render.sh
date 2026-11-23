#!/usr/bin/env bash
# chem-render 部署脚本（测试门禁版）
# 铁律：两套回归（test_layout_conflicts.py + test_regression.py）全过才允许部署；
# 任何一步失败立即中止，生产保持旧版本不动。
# 用法：bash backend/ops/deploy-chem-render.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEMO="$ROOT/name-to-svg-demo"
SRV="root@47.98.165.254"
TAG="$(date +%Y%m%d-%H%M)"

echo "== 1/5 语法检查 =="
python3 -m py_compile "$ROOT/backend/ops/chem-render.py"

echo "== 2/5 布局几何回归（16 项断言，含 VD3 立体回读）=="
cd "$DEMO"
python3 test_layout_conflicts.py

echo "== 3/5 原始回归（12 条 / 55 项断言）=="
python3 test_regression.py

echo "== 4/5 部署生产（备份 → 上传 → md5 校验 → 重启）=="
LOCAL_MD5=$(md5 -q "$ROOT/backend/ops/chem-render.py")
ssh "$SRV" "cp /opt/chem-render/chem-render.py /opt/chem-render/chem-render.py.bak-$TAG"
scp -q "$ROOT/backend/ops/chem-render.py" "$SRV:/opt/chem-render/chem-render.py"
REMOTE_MD5=$(ssh "$SRV" "md5sum /opt/chem-render/chem-render.py" | cut -d' ' -f1)
if [ "$LOCAL_MD5" != "$REMOTE_MD5" ]; then
  echo "❌ md5 不一致（local=$LOCAL_MD5 remote=$REMOTE_MD5），中止；生产未重启" >&2
  exit 1
fi
ssh "$SRV" "systemctl restart chem-render && sleep 2 && curl -sf http://127.0.0.1:8098/health"

echo ""
echo "== 5/5 生产冒烟（VD3 立体分子出图）=="
SMOKE=$(ssh "$SRV" "curl -sf -X POST http://127.0.0.1:8098/render -H 'Content-Type: application/json' -d '{\"smiles\":\"C[C@H](CCCC(C)C)[C@H]1CC[C@@H]\\\\2[C@@]1(CCC/C2=C\\\\C=C/3\\\\C[C@H](CCC3=C)O)C\",\"bondScale\":1.5,\"fontScale\":1.5,\"colorMode\":\"element\"}'" | head -c 30)
case "$SMOKE" in
  *'"ok":true'*) echo "✅ 冒烟通过" ;;
  *) echo "❌ 生产冒烟失败：$SMOKE —— 请立即回滚 /opt/chem-render/chem-render.py.bak-$TAG 并 systemctl restart chem-render" >&2; exit 1 ;;
esac

echo ""
echo "✅ 部署完成（备份：/opt/chem-render/chem-render.py.bak-$TAG）"
