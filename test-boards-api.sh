#!/bin/bash
# 画板云端接口联调（测试实例 127.0.0.1:8090，独立 DATA_DIR）
set -u
B=http://127.0.0.1:8090
PASS=0; FAIL=0
ck() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — 期望[$3] 实际[$2]"; FAIL=$((FAIL+1)); fi }

# 注册测试用户（free = none 等级，上限 3）
EMAIL="boardtest$(date +%s)@test.cn"
TOKEN=$(curl -s -X POST $B/api/auth/register -H 'Content-Type: application/json' -d "{\"name\":\"画板测试\",\"email\":\"$EMAIL\",\"password\":\"test123456\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))')
[ -n "$TOKEN" ] && { echo "PASS 注册测试用户"; PASS=$((PASS+1)); } || { echo "FAIL 注册测试用户"; exit 1; }
AUTH="Authorization: Bearer $TOKEN"

# 未登录访问被拒
ck "未登录访问 401" "$(curl -s -o /dev/null -w '%{http_code}' $B/api/boards)" "401"

# 空列表
ck "初始列表为空" "$(curl -s $B/api/boards -H "$AUTH" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(len(d["boards"]),d["limit"])')" "0 3"

# 文件夹 CRUD
FID=$(curl -s -X POST $B/api/folders -H "$AUTH" -H 'Content-Type: application/json' -d '{"name":"课题一"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["folder"]["id"])')
[ -n "$FID" ] && { echo "PASS 新建文件夹"; PASS=$((PASS+1)); } || echo "FAIL 新建文件夹"
ck "文件夹重命名" "$(curl -s -X PATCH $B/api/folders/$FID -H "$AUTH" -H 'Content-Type: application/json' -d '{"name":"课题一改"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["folder"]["name"])')" "课题一改"
ck "空名建文件夹被拒" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/api/folders -H "$AUTH" -H 'Content-Type: application/json' -d '{"name":"  "}')" "400"

# 画板 CRUD
B1=$(curl -s -X POST $B/api/boards -H "$AUTH" -H 'Content-Type: application/json' -d "{\"name\":\"通路图\",\"folderId\":\"$FID\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["board"]["id"])')
[ -n "$B1" ] && { echo "PASS 新建画板(入文件夹)"; PASS=$((PASS+1)); } || echo "FAIL 新建画板"
ck "保存内容" "$(curl -s -X PUT $B/api/boards/$B1 -H "$AUTH" -H 'Content-Type: application/json' -d '{"payload":{"els":[{"id":"e1","type":"rect"}],"board":{"w":1900,"h":1000}},"thumb":"data:image/jpeg;base64,/9j/xx"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["ok"])')" "True"
ck "读回内容" "$(curl -s $B/api/boards/$B1 -H "$AUTH" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["payload"]["els"][0]["type"],d["board"]["thumb"][:15])')" "rect data:image/jpeg"
ck "重命名" "$(curl -s -X PATCH $B/api/boards/$B1 -H "$AUTH" -H 'Content-Type: application/json' -d '{"name":"通路图终版"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["board"]["name"])')" "通路图终版"
ck "移出文件夹" "$(curl -s -X PATCH $B/api/boards/$B1 -H "$AUTH" -H 'Content-Type: application/json' -d '{"folderId":null}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["board"].get("folderId"))')" "None"

# 数量上限（free=3）
curl -s -X POST $B/api/boards -H "$AUTH" -H 'Content-Type: application/json' -d '{"name":"b2"}' >/dev/null
curl -s -X POST $B/api/boards -H "$AUTH" -H 'Content-Type: application/json' -d '{"name":"b3"}' >/dev/null
ck "第 4 个画板被拒(403)" "$(curl -s -X POST $B/api/boards -H "$AUTH" -H 'Content-Type: application/json' -d '{"name":"b4"}' | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("code"),d.get("limit"))')" "BOARD_LIMIT 3"

# 无效 id 防护（路径穿越）
ck "路径穿越 id 被拒" "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/boards/..%2F..%2Fusers" -H "$AUTH")" "400"

# 超 ID 无效
ck "非法字符 id 400" "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/boards/ABC_def!" -H "$AUTH")" "400"

# import-local（已满 3 个，应全部 skipped）
SKIP=$(curl -s -X POST $B/api/boards/import-local -H "$AUTH" -H 'Content-Type: application/json' -d '{"folders":[{"id":"f0001aa","name":"导入夹"}],"boards":[{"id":"m0001aa","name":"本地板1","payload":{"els":[]}},{"id":"m0002aa","name":"本地板2","payload":{"els":[]}}]}' | python3 -c 'import sys,json;d=json.load(sys.stdin);print(len(d["imported"]),len(d["skipped"]))')
ck "import-local 超限跳过" "$SKIP" "0 2"

# 删除画板后额度释放
curl -s -X DELETE $B/api/boards/$B1 -H "$AUTH" >/dev/null
B5=$(curl -s -X POST $B/api/boards -H "$AUTH" -H 'Content-Type: application/json' -d '{"name":"b5"}' | python3 -c 'import sys,json;print(json.load(sys.stdin).get("ok"))')
ck "删除后额度释放" "$B5" "True"

# 删除文件夹：画板移回全部
BID=$(curl -s $B/api/boards -H "$AUTH" | python3 -c 'import sys,json;print(json.load(sys.stdin)["boards"][0]["id"])')
curl -s -X PATCH $B/api/boards/$BID -H "$AUTH" -H 'Content-Type: application/json' -d "{\"folderId\":\"$FID\"}" >/dev/null
curl -s -X DELETE $B/api/folders/$FID -H "$AUTH" >/dev/null
ck "删文件夹画板移回" "$(curl -s $B/api/boards/$BID -H "$AUTH" | python3 -c 'import sys,json;print(json.load(sys.stdin)["board"].get("folderId"))')" "None"

# 大体积写入（>256kb 走大解析器；<10MB 应成功）
python3 -c "import json;print(json.dumps({'payload':{'els':[],'blob':'x'*300000}}))" > /tmp/big-board.json
ck "300KB 内容可写" "$(curl -s -X PUT $B/api/boards/$BID -H "$AUTH" -H 'Content-Type: application/json' --data @/tmp/big-board.json | python3 -c 'import sys,json;print(json.load(sys.stdin)["ok"])')" "True"

echo; echo "$PASS 通过 / $FAIL 失败"
[ $FAIL -eq 0 ]
