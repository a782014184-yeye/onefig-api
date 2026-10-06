#!/bin/bash
# 批注接口联调：独立测试实例
set -e
BASE=http://127.0.0.1:8090
TD=$(mktemp -d)
PORT=8090 DATA_DIR=$TD node server.js & SRV=$!
sleep 1.2
P=0; F=0
ck() { if [ "$2" = "$3" ]; then P=$((P+1)); else F=$((F+1)); echo "FAIL: $1 (want [$3] got [$2])"; fi; }
J() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
A=$(curl -s -X POST $BASE/api/auth/register -H 'Content-Type: application/json' -d '{"email":"c@test.com","password":"Test123456","name":"a"}')
TA=$(echo "$A" | J "d['token']")
BID=$(curl -s -X POST $BASE/api/boards -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d '{"name":"批注板"}' | J "d['board']['id']")
curl -s -X PUT $BASE/api/boards/$BID -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d '{"payload":{"els":[]}}' > /dev/null
ST=$(curl -s -X POST $BASE/api/boards/$BID/share -H "Authorization: Bearer $TA" | J "d['shareToken']")

# 1. 空列表
ck "初始空" $(curl -s $BASE/api/shared/$ST/comments | J "len(d['comments'])") "0"
# 2. 免登录加批注
C=$(curl -s -X POST $BASE/api/shared/$ST/comments -H 'Content-Type: application/json' -d '{"name":"王导","text":"受体换成红色","x":300,"y":200}')
ck "加批注" $(echo "$C" | J "d['ok']") "True"
CID=$(echo "$C" | J "d['comment']['id']")
# 3. 列表含昵称/坐标/时间
ck "批注字段" $(curl -s $BASE/api/shared/$ST/comments | J "'%s-%s-%s' % (d['comments'][0]['name'], d['comments'][0]['x'], d['comments'][0]['done'])") "王导-300-False"
# 4. 无名被拒
ck "无名400" $(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/api/shared/$ST/comments -H 'Content-Type: application/json' -d '{"text":"hi","x":1,"y":1}') "400"
# 5. 标记已解决
ck "标记done" $(curl -s -X PATCH $BASE/api/shared/$ST/comments/$CID -H 'Content-Type: application/json' -d '{"done":true}' | J "d['comment']['done']") "True"
# 6. 无效分享 404
ck "无效分享404" $(curl -s -o /dev/null -w '%{http_code}' $BASE/api/shared/badtoken123/comments) "404"
# 7. 关闭分享 → 批注 404
curl -s -X DELETE $BASE/api/boards/$BID/share -H "Authorization: Bearer $TA" > /dev/null
ck "关分享后404" $(curl -s -o /dev/null -w '%{http_code}' $BASE/api/shared/$ST/comments) "404"

echo "PASS=$P FAIL=$F"
kill $SRV; rm -rf $TD
[ $F -eq 0 ]
