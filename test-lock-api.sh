#!/bin/bash
# 可编辑分享 + 编辑锁联调：独立测试实例（PORT=8090，独立 DATA_DIR）
set -e
BASE=http://127.0.0.1:8090
TD=$(mktemp -d)
PORT=8090 DATA_DIR=$TD node server.js & SRV=$!
sleep 1.2
P=0; F=0
ck() { if [ "$2" = "$3" ]; then P=$((P+1)); else F=$((F+1)); echo "FAIL: $1 (want [$3] got [$2])"; fi; }
J() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }

# 作者 + 两个协作者
A=$(curl -s -X POST $BASE/api/auth/register -H 'Content-Type: application/json' -d '{"email":"owner@test.com","password":"Test123456","name":"作者君"}')
TA=$(echo "$A" | J "d['token']")
B=$(curl -s -X POST $BASE/api/auth/register -H 'Content-Type: application/json' -d '{"email":"pal@test.com","password":"Test123456","name":"小明"}')
TB=$(echo "$B" | J "d['token']")
C=$(curl -s -X POST $BASE/api/auth/register -H 'Content-Type: application/json' -d '{"email":"pal2@test.com","password":"Test123456","name":"小红"}')
TC=$(echo "$C" | J "d['token']")
BID=$(curl -s -X POST $BASE/api/boards -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d '{"name":"协作图"}' | J "d['board']['id']")
curl -s -X PUT $BASE/api/boards/$BID -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d '{"payload":{"els":[{"id":"e1"}]}}' > /dev/null

# 1. 只读分享：协作者拿锁被拒
ST=$(curl -s -X POST $BASE/api/boards/$BID/share -H "Authorization: Bearer $TA" | J "d['shareToken']")
ck "只读分享锁403" $(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/api/shared/$ST/lock -H "Authorization: Bearer $TB") "403"
# 2. state：mode=view
ck "state只读模式" $(curl -s $BASE/api/shared/$ST/state | J "d['mode']") "view"
# 3. 切到可编辑
curl -s -X POST $BASE/api/boards/$BID/share -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d '{"mode":"edit"}' > /dev/null
ck "state可编辑模式" $(curl -s $BASE/api/shared/$ST/state | J "d['mode']") "edit"
# 4. 小明拿锁
ck "小明拿锁" $(curl -s -X POST $BASE/api/shared/$ST/lock -H "Authorization: Bearer $TB" | J "d['ok']") "True"
# 5. 小红抢锁被拒，且知道是小明
R=$(curl -s -X POST $BASE/api/shared/$ST/lock -H "Authorization: Bearer $TC")
ck "小红抢锁409" $(echo "$R" | J "d.get('code','')") "LOCKED"
ck "占用者昵称" $(echo "$R" | J "d.get('lockName','')") "小明"
# 6. state 里能看到锁（小红视角）
ck "state带锁" $(curl -s $BASE/api/shared/$ST/state -H "Authorization: Bearer $TC" | J "'%s-%s' % (d['lock']['name'], d['lock']['mine'])") "小明-False"
# 7. 小明（持锁人）保存成功
ck "持锁保存" $(curl -s -X PUT $BASE/api/shared/$ST -H "Authorization: Bearer $TB" -H 'Content-Type: application/json' -d '{"payload":{"els":[{"id":"e1"},{"id":"e2"}]}}' | J "d['ok']") "True"
# 8. 小红无锁保存被拒
ck "无锁保存409" $(curl -s -o /dev/null -w '%{http_code}' -X PUT $BASE/api/shared/$ST -H "Authorization: Bearer $TC" -H 'Content-Type: application/json' -d '{"payload":{"els":[]}}') "409"
# 9. 只读公开读接口看到小明的改动
ck "只读看到最新" $(curl -s $BASE/api/shared/$ST | J "len(d['payload']['els'])") "2"
# 10. 小明心跳（再次 POST 自己）成功
ck "持锁人心跳" $(curl -s -X POST $BASE/api/shared/$ST/lock -H "Authorization: Bearer $TB" | J "d['ok']") "True"
# 11. 作者本人也能拿锁吗？锁在小明手里 → 409
ck "作者也受限" $(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/api/shared/$ST/lock -H "Authorization: Bearer $TA") "409"
# 12. 小明释放 → 小红拿到
curl -s -X DELETE $BASE/api/shared/$ST/lock -H "Authorization: Bearer $TB" > /dev/null
ck "释放后小红拿锁" $(curl -s -X POST $BASE/api/shared/$ST/lock -H "Authorization: Bearer $TC" | J "d['ok']") "True"
# 13. 未登录拿锁 401
ck "未登录拿锁401" $(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/api/shared/$ST/lock) "401"

echo "PASS=$P FAIL=$F"
kill $SRV; rm -rf $TD
[ $F -eq 0 ]
