#!/usr/bin/env bash
# Boots the image as in production (uid 1000, read-only root filesystem, no capability)
# next to Postgres, then checks it serves and stops cleanly.
#
#   docker/smoke-test.sh twake-chat-side-service:dev
set -euo pipefail

IMAGE="${1:?usage: $0 <image>}"
RUN="twake-chat-side-service-smoke-$$"
cleanup() {
  docker rm -f "$RUN-service" "$RUN-postgres" >/dev/null 2>&1 || true
  docker network rm "$RUN" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create "$RUN" >/dev/null
docker run -d --name "$RUN-postgres" --network "$RUN" --network-alias postgres \
  -e POSTGRES_USER=chat_side_service -e POSTGRES_PASSWORD=smoke-test -e POSTGRES_DB=chat_side_service \
  postgres:18 >/dev/null
# Over TCP: the socket answers while the init server still refuses connections
for _ in $(seq 1 30); do
  docker exec "$RUN-postgres" pg_isready -h 127.0.0.1 -U chat_side_service>/dev/null 2>&1 && break
  sleep 1
done

# Only the database is reached at startup
docker run -d --name "$RUN-service" --network "$RUN" \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  -p 127.0.0.1::8080 \
  -e AS_TOKEN=smoke-test -e MATRIX_HOMESERVER_URL=http://synapse:8008 -e MATRIX_SERVER_NAME=example.org \
  -e DATABASE_URL=postgres://chat_side_service:smoke-test@postgres:5432/chat_side_service \
  -e MEET_URL=http://meet -e MEET_CLIENT_ID=smoke-test -e MEET_CLIENT_SECRET=smoke-test \
  -e MEET_SERVICE_ACCOUNT_EMAIL=calls@example.org \
  -e LDAP_URL=ldap://ldap -e LDAP_BASE=dc=example,dc=org \
  "$IMAGE" >/dev/null
API="http://$(docker port "$RUN-service" 8080/tcp | head -1)"

failures=0
expect() {
  if [[ "$2" == "$3" ]]; then
    echo "ok   $1"
  else
    echo "FAIL $1: got '$2'"
    failures=$((failures + 1))
  fi
}
status() { curl -s -o /dev/null -w '%{http_code}' "$@" || true; }

for _ in $(seq 1 60); do
  [[ "$(status "$API/health/ready")" == 200 ]] && break
  sleep 1
done

expect 'ready once started' "$(status "$API/health/ready")" '200'
expect 'alive' "$(status "$API/health/live")" '200'
expect 'runs as uid 1000' "$(docker exec "$RUN-service" stat -c %u /proc/1)" '1000'
expect 'created its table' \
  "$(docker exec "$RUN-postgres" psql -U chat_side_service -tAc "select count(*) from information_schema.tables where table_name = 'call_rooms'")" '1'

expect 'answers the preflight of the browsers' "$(status -X OPTIONS "$API/sfu/get")" '204'
expect 'refuses a token request of the wrong shape' \
  "$(status -X POST -H 'content-type: application/json' -d '{}' "$API/sfu/get")" '400'
expect 'serves no assistants without a harness' "$(status "$API/assistants/me")" '404'

docker kill -s TERM "$RUN-service" >/dev/null
code="$(timeout 40 docker wait "$RUN-service" || echo timeout)"
expect 'stops on SIGTERM with code 0' "$code" '0'

if ((failures > 0)); then
  echo "$failures check(s) failed; service logs:"
  docker logs "$RUN-service" 2>&1 | tail -40
  exit 1
fi
echo "all checks passed"
