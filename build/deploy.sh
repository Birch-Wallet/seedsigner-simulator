#!/usr/bin/env bash
#
# Build every firmware UPSTREAM pins and publish the site into a web root, in
# one run. Meant for the server, after `git pull`, as the user that owns the web
# root; nothing here needs sudo.
#
#   ./build/deploy.sh DEST [--url URL] [--no-delete] [--allow-unpublished]
#
#   DEST                 the web root nginx (or Caddy) serves, e.g.
#                        /srv/seedsigner-simulator
#   --url URL            after publishing, check the live site at URL: headers,
#                        the worker's policy, every firmware zip's hash, a font
#   --no-delete          keep files in DEST that the build does not produce
#                        (by default they are removed, except .well-known/)
#   --allow-unpublished  publish even if a zip does not hash to what UPSTREAM
#                        publishes; the page will then say so to every visitor
#
# In order, stopping at the first thing that fails:
#
#   1. Preflight: the tools, a Python whose tarfile has the extraction filter
#      the build needs, a writable DEST, and ./build/update-checksums.sh --check,
#      so the files about to be served are the committed ones.
#   2. ./build/fetch-assets.sh, then ./build/build-firmware-zip.sh for every
#      section of UPSTREAM, each zip required to hash to its published sha256.
#   3. The site, assembled in a temporary directory: src/web, src/shims, every
#      zip with its build-info, firmwares.json, and the fonts they name. The
#      directory is made 755 first, because rsync copies its mode onto DEST and
#      mktemp makes it 700, which leaves the web server unable to read anything.
#   4. The current DEST kept as DEST.previous (hard links, so it costs almost
#      nothing), then the new site synced into DEST. The command to put the
#      previous one back is printed.
#   5. With --url, the live checks. A failure is reported and the script exits
#      non-zero; nothing is rolled back without being asked.
#
# The web server's own configuration is not touched: the headers it has to send
# are in docs/SELF-HOSTING.md, and --url is how to find out whether it does.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
UPSTREAM_FILE="${REPO_ROOT}/UPSTREAM"
OUT_DIR="${REPO_ROOT}/build/out"

usage() { sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//'; }

die() {
    echo "deploy: $*" >&2
    exit 1
}

step() {
    echo "==> $*"
}

DEST=""
URL=""
DELETE="yes"
ALLOW_UNPUBLISHED="no"
while [ "$#" -gt 0 ]; do
    case "$1" in
        --url)               URL="${2:-}"; shift 2 ;;
        --no-delete)         DELETE="no"; shift ;;
        --allow-unpublished) ALLOW_UNPUBLISHED="yes"; shift ;;
        -h|--help)           usage; exit 0 ;;
        -*)                  echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
        *)                   [ -z "${DEST}" ] || { echo "one destination only" >&2; exit 2; }
                             DEST="${1%/}"; shift ;;
    esac
done
[ -n "${DEST}" ] || { usage >&2; exit 2; }

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum -- "$1" | cut -d' ' -f1
    else shasum -a 256 -- "$1" | cut -d' ' -f1; fi
}

# One key out of a section of UPSTREAM, as the build reads it.
field() {
    awk -F= -v want="[$1]" -v key="$2" '
        /^\[/   { inside = ($0 == want); next }
        inside && $1 ~ "^[[:space:]]*" key "[[:space:]]*$" {
            gsub(/[[:space:]]/, "", $2); print $2
        }
    ' "${UPSTREAM_FILE}"
}

FIRMWARES="$(sed -n 's/^\[\([a-z0-9-]*\)\]$/\1/p' "${UPSTREAM_FILE}")"
[ -n "${FIRMWARES}" ] || die "no firmware sections in ${UPSTREAM_FILE}"

# --- 1. preflight ---------------------------------------------------------------

step "preflight"
for tool in git curl rsync python3; do
    command -v "${tool}" >/dev/null 2>&1 || die "required tool not found: ${tool}"
done
python3 -c 'import tarfile, sys; sys.exit(0 if hasattr(tarfile, "data_filter") else 1)' \
    || die "$(python3 --version 2>&1) has no tarfile extraction filter, which the build needs:
  use Python 3.12 or later (or 3.11.4, 3.10.12, 3.9.17, 3.8.17 and later), ahead of
  the system one on PATH for this user; see docs/SELF-HOSTING.md"
[ -d "${DEST}" ] || die "no such directory: ${DEST}"
[ -w "${DEST}" ] || die "${DEST} is not writable by $(id -un)"
"${REPO_ROOT}/build/update-checksums.sh" --check >/dev/null \
    || die "build/checksums.txt does not match the working tree; is this a clean checkout?"
echo "    $(python3 --version), firmwares: $(echo ${FIRMWARES})"

# --- 2. fetch and build -----------------------------------------------------------

step "fetching Pyodide and zxing-wasm"
"${REPO_ROOT}/build/fetch-assets.sh" >/dev/null

for firmware in ${FIRMWARES}; do
    step "building ${firmware}"
    log="$("${REPO_ROOT}/build/build-firmware-zip.sh" "${firmware}" 2>&1)" \
        || { echo "${log}" >&2; die "the build of ${firmware} failed"; }
    built="$(echo "${log}" | awk '/^    zip       sha256 / { print $3 }')"
    published="$(field "${firmware}" zip_sha256)"
    echo "    ${built}"
    if [ "${built}" != "${published}" ]; then
        [ "${ALLOW_UNPUBLISHED}" = "yes" ] \
            || die "${firmware} built to ${built}, but UPSTREAM publishes ${published};
  the page would tell every visitor it is not the published build.
  Rebuild from a clean checkout, or pass --allow-unpublished to deploy it anyway."
        echo "    NOT the published ${published}; deploying anyway (--allow-unpublished)"
    fi
done

# --- 3. assemble --------------------------------------------------------------------

step "assembling the site"
SITE="$(mktemp -d "${TMPDIR:-/tmp}/seedsigner-site.XXXXXXXX")"
trap 'rm -rf -- "${SITE}"' EXIT
chmod 755 "${SITE}"
cp -R "${REPO_ROOT}/src/web/." "${SITE}/"
cp "${REPO_ROOT}"/src/shims/*.py "${SITE}/"
for firmware in ${FIRMWARES}; do
    cp "${OUT_DIR}/seedsigner-${firmware}.zip" "${OUT_DIR}/seedsigner-${firmware}.build-info.json" "${SITE}/"
done
cp "${OUT_DIR}/firmwares.json" "${SITE}/"
# The font directories the deployed build-infos name, and no others.
for fonts in $(python3 - "${SITE}" <<'PY'
import glob, json, os, sys
names = set()
for path in glob.glob(os.path.join(sys.argv[1], "seedsigner-*.build-info.json")):
    with open(path, encoding="utf-8") as handle:
        fonts = ((json.load(handle).get("translations") or {}).get("fonts") or {})
    if fonts.get("dir"):
        names.add(fonts["dir"])
print("\n".join(sorted(names)))
PY
); do
    [ -d "${OUT_DIR}/${fonts}" ] || die "a build-info names ${fonts}/, which the build did not write"
    cp -R "${OUT_DIR}/${fonts}" "${SITE}/"
done
echo "    $(find "${SITE}" -type f | wc -l | tr -d ' ') files, $(du -sh "${SITE}" | cut -f1)"

# --- 4. publish ----------------------------------------------------------------------

PREVIOUS="${DEST}.previous"
step "keeping the current site as ${PREVIOUS}"
mkdir -p "${PREVIOUS}"
rsync -a --delete --link-dest="${DEST}" "${DEST}/" "${PREVIOUS}/"

step "publishing into ${DEST}"
sync_flags=(-a)
[ "${DELETE}" = "no" ] || sync_flags+=(--delete --exclude .well-known)
rsync "${sync_flags[@]}" "${SITE}/" "${DEST}/"
echo "    to put the previous site back:"
echo "    rsync -a --delete --exclude .well-known '${PREVIOUS}/' '${DEST}/'"

# --- 5. check the live site ------------------------------------------------------------

[ -n "${URL}" ] || { echo; echo "Deployed. Pass --url to check the live site."; exit 0; }
URL="${URL%/}"
step "checking ${URL}"
failures=0
ok()   { echo "    ok    $*"; }
fail() { echo "    FAIL  $*"; failures=$((failures + 1)); }

headers="$(curl -sI "${URL}/")"
status="$(echo "${headers}" | head -1 | tr -d '\r')"
case "${status}" in *" 200"*) ok "the page answers: ${status}" ;; *) fail "the page answers: ${status}" ;; esac
for header in cross-origin-opener-policy cross-origin-embedder-policy; do
    echo "${headers}" | grep -qi "^${header}:" && ok "${header}" || fail "no ${header} header on the page"
done

policy="$(curl -sI "${URL}/worker.js" | grep -i '^content-security-policy:' | tr -d '\r' || true)"
case "${policy}" in
    *"connect-src 'self'"*) ok "worker.js is confined to this origin" ;;
    *) fail "worker.js has no Content-Security-Policy with connect-src 'self' (see docs/SELF-HOSTING.md)" ;;
esac

for firmware in ${FIRMWARES}; do
    served="$(curl -sf "${URL}/seedsigner-${firmware}.zip" | { sha256sum 2>/dev/null || shasum -a 256; } | cut -d' ' -f1)"
    published="$(field "${firmware}" zip_sha256)"
    [ "${served}" = "${published}" ] && ok "seedsigner-${firmware}.zip is the published build" \
        || fail "seedsigner-${firmware}.zip serves ${served:-nothing}, not ${published}"
done

font="$(cd "${SITE}" && ls -d fonts-*/* 2>/dev/null | head -1 || true)"
if [ -n "${font}" ]; then
    code="$(curl -s -o /dev/null -w '%{http_code}' "${URL}/${font}")"
    [ "${code}" = "200" ] && ok "${font} is served" || fail "${font} answers ${code}"
fi

echo
if [ "${failures}" -eq 0 ]; then
    echo "Deployed and checked."
else
    echo "${failures} check(s) failed. The new site is live; to put the previous one back:"
    echo "  rsync -a --delete --exclude .well-known '${PREVIOUS}/' '${DEST}/'"
    exit 1
fi
