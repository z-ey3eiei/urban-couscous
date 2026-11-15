#!/usr/bin/env bash
set -euo pipefail
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
mkdir "$work"/{manifest,cache}
# Reject lockfile references that could turn prefetch into an arbitrary network client.
python3 - "$work/manifest" <<'PY'
import json, pathlib, shutil, sys, urllib.parse
root = pathlib.Path(sys.argv[1])
lock = json.loads(pathlib.Path('package-lock.json').read_text())
packages = lock.get('packages')
if lock.get('lockfileVersion') != 3 or not isinstance(packages, dict):
    raise SystemExit('A version 3 package-lock.json is required')
for name, item in packages.items():
    if not name:
        continue
    target = urllib.parse.urlsplit(item.get('resolved', ''))
    if item.get('link') or target.scheme != 'https' or target.netloc != 'registry.npmjs.org' or not item.get('integrity'):
        raise SystemExit('Dependencies must have integrity hashes and use registry.npmjs.org')
for name in ('package.json', 'package-lock.json'):
    shutil.copyfile(name, root / name)
PY
image=node:22-bookworm-slim
docker pull "$image" >/dev/null
sandbox=(--rm --cap-drop ALL --security-opt no-new-privileges --read-only --user "$(id -u):$(id -g)" --pids-limit 128 --memory 2g --memory-swap 2g --cpus 2 --ulimit nofile=1024:1024 --tmpfs /tmp:rw,nosuid,nodev,mode=1777,size=128m --tmpfs /work:rw,exec,nosuid,nodev,mode=1777,size=1024m --workdir /work)
if ! timeout 180 docker run "${sandbox[@]}" \
    --mount "type=bind,src=$work/manifest,dst=/manifest,readonly" \
    --mount "type=bind,src=$work/cache,dst=/cache" "$image" \
    env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp CI=true npm_config_cache=/cache \
    sh -ec 'cp /manifest/* .; npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org' >"$work/prefetch.log" 2>&1; then
  echo 'Dependency prefetch failed.' >&2
  grep -Eo "\b(EACCES|ENOSPC|EROFS|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EUSAGE|ENOTCACHED|EPERM)\b" "$work/prefetch.log" | sort -u >&2 || true
  exit 1
fi
if ! (ulimit -f 10000; timeout 240 docker run "${sandbox[@]}" --network none \
    --mount "type=bind,src=$PWD,dst=/source,readonly" \
    --mount "type=bind,src=$work/cache,dst=/cache" \
    "$image" \
    env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp CI=true npm_config_cache=/cache \
    sh -ec 'tar -C /source --exclude=.git --exclude=node_modules --exclude=.env --exclude=".env.*" -cf - . | tar -xf -
      npm ci --offline --ignore-scripts --no-audit --no-fund >&2
      npm run lint >&2
      npm run build >&2
      test -f dist/index.html
      tar --format=ustar -cf - -C dist .' >"$work/dist.tar" 2>"$work/build.log"); then
  echo 'Offline lint or build failed.' >&2
  grep -Eo "\b(EACCES|ENOSPC|EROFS|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EUSAGE|ENOTCACHED|EPERM)\b" "$work/build.log" | sort -u >&2 || true
  exit 1
fi
# Read regular archive entries directly. Never extract repository-created paths.
python3 - "$work/dist.tar" <<'PY'
import base64, json, pathlib, re, sys, tarfile
allowed = {'html','css','js','mjs','json','svg','png','jpg','jpeg','webp','ico','woff2'}
files = {}
size = 0
with tarfile.open(sys.argv[1], 'r:') as archive:
    for entry in archive:
        if entry.isdir():
            continue
        path = entry.name.removeprefix('./')
        size += entry.size
        if (not entry.isfile() or len(path) > 240 or
            not all(re.fullmatch(r'[a-zA-Z0-9_@-][a-zA-Z0-9_.@-]*', p) for p in path.split('/')) or
            path.rsplit('.', 1)[-1] not in allowed or path in files or
            len(files) >= 300 or size > 6_000_000):
            raise SystemExit('Invalid or oversized static artifact')
        files[path] = base64.b64encode(archive.extractfile(entry).read()).decode()
if 'index.html' not in files:
    raise SystemExit('The build must produce dist/index.html')
pathlib.Path('site.json').write_text(json.dumps(files, separators=(',', ':')))
PY
