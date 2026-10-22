#!/usr/bin/env bash
# PostgreSQL 17 on localhost:5432 for the CI database jobs (KOBE-415). A service container cannot
# retry its pull, and Google's Docker Hub mirror sometimes answers 429 (toomanyrequests) at once;
# this tries the mirror and ECR Public's copy of the official image, three rounds a little apart.
set -euo pipefail

password="${1:?usage: ci-postgres.sh <password>}"
images=(mirror.gcr.io/library/postgres:17 public.ecr.aws/docker/library/postgres:17)
name=kobe-ci-postgres

image=""
for attempt in 1 2 3; do
  for candidate in "${images[@]}"; do
    if docker pull -q "$candidate"; then
      image="$candidate"
      break 2
    fi
    echo "::warning::could not pull $candidate (round $attempt of 3)"
  done
  if [ "$attempt" -lt 3 ]; then sleep $((attempt * 15)); fi
done
if [ -z "$image" ]; then
  echo "::error::could not pull postgres:17 from ${images[*]}"
  exit 1
fi

docker run -d --name "$name" -e POSTGRES_PASSWORD="$password" -p 5432:5432 "$image" >/dev/null
# Over TCP: the image's init server listens on its socket only, so this sees the real one.
for _ in $(seq 1 60); do
  if docker exec "$name" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1; then
    echo "postgres:17 ready from $image"
    exit 0
  fi
  sleep 1
done
docker logs "$name" 2>&1 | tail -n 20
echo "::error::postgres did not become ready within 60 s"
exit 1
