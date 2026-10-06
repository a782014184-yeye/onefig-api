#!/bin/bash
# 分享接口联调：独立测试实例（PORT=8090，独立 DATA_DIR）
set -e
BASE=http://127.0.0.1:8090
TD=$(mktemp -d)
PORT=8090 DATA_DIR=$TD node server.js & SRV=$!
sleep 1.2
P=0; F=0
ck() { if [ "$2" = "$3" ]; then P=$((P+1)); else F=$((F+1)); echo "FAIL: $1 (want $3 got $2)"; fi; }

# 注册 + 建板 + 写内容
R=$(curl -s -X POST $BASE/api/auth/register -H 'Content-Type: application/json' -d '{"email":"share@test.com","password":"Test123456","name":"s"}')
TOKEN=$(echo $R | python3 -c "import json,sys;print(json.load(sys.stdin)['token'])")
B=$(curl -s -X POST $BASE/api/boards -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"name":"分享测试"}')
BID=$(echo $B | python3 -c "import json,sys;print(json.load(sys.stdin)['board']['id'])")
curl -s -X PUT $BASE/api/boards/$BID -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"payload":{"els":[{"id":"e1","type":"rect"}],"board":{"w":1900,"h":1000}}}' > /dev/null

# 1. 开启分享
S=$(curl -s -X POST $BASE/api/boards/$BID/share -H "Authorization: Bearer $TOKEN")
ST=$(echo $S | python3 -c "import json,sys;print(json.load(sys.stdin)['shareToken'])")
ck "开启分享" $(echo $S | python3 -c "import json,sys;print(json.load(sys.stdin)['ok'])") "True"
# 2. 重复开启返回同一 token
S2=$(curl -s -X POST $BASE/api/boards/$BID/share -H "Authorization: Bearer $TOKEN" | python3 -c "import json,sys;print(json.load(sys.stdin)['shareToken'])")
ck "重复开启幂等" $S2 $ST
# 3. 公开访问（无鉴权）
G=$(curl -s $BASE/api/shared/$ST)
ck "公开读取" $(echo $G | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['ok'] and d['name']=='分享测试' and len(d['payload']['els'])==1)") "True"
ck "不泄露用户信息" $(curl -s $BASE/api/shared/$ST | python3 -c "import json,sys;s=json.dumps(json.load(sys.stdin));print('uid' in s or 'email' in s)") "False"
# 4. 画板更新后分享链接看到最新版
curl -s -X PUT $BASE/api/boards/$BID -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"payload":{"els":[{"id":"e1"},{"id":"e2"}]}}' > /dev/null
ck "分享看到最新版" $(curl -s $BASE/api/shared/$ST | python3 -c "import json,sys;print(len(json.load(sys.stdin)['payload']['els']))") "2"
# 5. 乱 token → 404
ck "无效token404" $(curl -s -o /dev/null -w '%{http_code}' $BASE/api/shared/abcdefghijklmnop) "404"
# 6. 关闭分享 → 404
curl -s -X DELETE $BASE/api/boards/$BID/share -H "Authorization: Bearer $TOKEN" > /dev/null
ck "关闭后404" $(curl -s -o /dev/null -w '%{http_code}' $BASE/api/shared/$ST) "404"
# 7. 重新开启 → 新 token 可用
ST2=$(curl -s -X POST $BASE/api/boards/$BID/share -H "Authorization: Bearer $TOKEN" | python3 -c "import json,sys;print(json.load(sys.stdin)['shareToken'])")
ck "重新开启新token" $([ "$ST2" != "$ST" ] && echo yes || echo no) "yes"
# 8. 删除画板 → 分享失效
curl -s -X DELETE $BASE/api/boards/$BID -H "Authorization: Bearer $TOKEN" > /dev/null
ck "删板后404" $(curl -s -o /dev/null -w '%{http_code}' $BASE/api/shared/$ST2) "404"
# 9. 别人的板不能开分享
R2=$(curl -s -X POST $BASE/api/auth/register -H 'Content-Type: application/json' -d '{"email":"share2@test.com","password":"Test123456","name":"s2"}')
T2=$(echo $R2 | python3 -c "import json,sys;print(json.load(sys.stdin)['token'])")
B2=$(curl -s -X POST $BASE/api/boards -H "Authorization: Bearer $T2" -H 'Content-Type: application/json' -d '{"name":"t"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['board']['id'])")
ck "越权开分享404" $(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/api/boards/$B2/share -H "Authorization: Bearer $TOKEN") "404"

echo "PASS=$P FAIL=$F"
kill $SRV; rm -rf $TD
[ $F -eq 0 ]
