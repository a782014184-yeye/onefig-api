#!/bin/bash
# ============================================
#  OneFig AI 链路周巡检（维护规范 3.12.3）
#  在服务器上运行：bash /opt/onefig-api/ops/ai-probe.sh
#  探测四条链路，任一失败退出码 1 并大声报错：
#   1) 百炼 qwen-image-2.0 改图/风格转换（共用模型与 key）
#   2) 火山方舟 Seedream 生图
#   3) 本地抠图服务（127.0.0.1:9000）
#  生图/改图探测均为最小请求，按张计费（约 0.2 元/次量级），建议每周一次。
#  建立日期：2026-10-15（"Model not exist" 事故后）
# ============================================
set -u
cd "$(dirname "$0")/.."   # /opt/onefig-api
ENV_FILE=/opt/onefig-api/onefig-api.env
FAIL=0

ok()  { echo "  ✅ $1"; }
bad() { echo "  ❌ $1"; FAIL=1; }

# 环境变量（仅本地使用，不打印）
# DASHSCOPE key 在 systemd 单元 Environment 行，TOKEN_SECRET 等在 env 文件，两处都查
DASHSCOPE_KEY=$(systemctl show onefig-api -p Environment --value 2>/dev/null | tr " " "\n" \
  | grep "^DASHSCOPE_API_KEY=" | sed "s/^DASHSCOPE_API_KEY=//" | tr -d "\"'")
[ -z "$DASHSCOPE_KEY" ] && DASHSCOPE_KEY=$(grep "^DASHSCOPE_API_KEY=" "$ENV_FILE" 2>/dev/null | sed "s/^DASHSCOPE_API_KEY=//" | tr -d "\"'")
ARK_KEY=$(cat data/ai/ark-key.txt 2>/dev/null | tr -d " \t\r\n")

echo "== OneFig AI 链路巡检 $(date '+%Y-%m-%d %H:%M') =="

# ---- 1) 百炼改图/风格转换：模型是否存在 + 能出图 ----
echo "[1/3] 百炼 qwen-image-2.0（改图/风格转换共用）"
if [ -z "$DASHSCOPE_KEY" ]; then
  bad "DASHSCOPE_API_KEY 未配置（$ENV_FILE）"
else
  # 1x1 红色小图转 base64 data URL，避免依赖任何公网图片 URL
  SRC="data:image/png;base64,$(printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' )"
  RESP=$(curl -s -m 120 -X POST https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation \
    -H "Authorization: Bearer $DASHSCOPE_KEY" -H "Content-Type: application/json" \
    -d "{\"model\":\"qwen-image-2.0\",\"input\":{\"messages\":[{\"role\":\"user\",\"content\":[{\"image\":\"$SRC\"},{\"text\":\"把这张图放大成纯红色方块\"}]}]}}")
  if echo "$RESP" | grep -q '"image"'; then
    ok "出图正常"
  else
    bad "调用失败：$(echo "$RESP" | head -c 200)"
  fi
fi

# ---- 2) 火山方舟 Seedream 生图 ----
echo "[2/3] 火山方舟 Seedream 生图（生成素材）"
if [ -z "$ARK_KEY" ]; then
  bad "ark-key.txt 不存在或为空（data/ai/ark-key.txt）"
else
  RESP=$(curl -s -m 120 -X POST https://ark.cn-beijing.volces.com/api/v3/images/generations \
    -H "Authorization: Bearer $ARK_KEY" -H "Content-Type: application/json" \
    -d '{"model":"doubao-seedream-4-5-251128","prompt":"一个紫色无花果，扁平插画","size":"2048x2048","response_format":"b64_json","watermark":false}')
  if echo "$RESP" | grep -q 'b64_json'; then
    ok "出图正常"
  else
    bad "调用失败：$(echo "$RESP" | head -c 200)"
  fi
fi

# ---- 3) 本地抠图服务 ----
echo "[3/3] 本地抠图服务（127.0.0.1:9000）"
PNG_B64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
TMPPNG=$(mktemp /tmp/ai-probe-XXXX.png)
printf '%s' "$PNG_B64" | base64 -d > "$TMPPNG" 2>/dev/null
CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 60 -X POST http://127.0.0.1:9000/remove-bg -F "image=@$TMPPNG")
rm -f "$TMPPNG"
if [ "$CODE" = "200" ]; then
  ok "服务正常"
else
  bad "HTTP $CODE（服务可能挂了：systemctl status rembg）"
fi

echo "================================"
if [ "$FAIL" -eq 0 ]; then
  echo "🎉 全部通过"
else
  echo "⚠️ 有链路异常，按维护规范 3.12 处理"
fi
exit $FAIL
