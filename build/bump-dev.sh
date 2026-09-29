#!/usr/bin/env bash
#
# Move the [dev] pin in UPSTREAM to the current tip of SeedSigner's development
# branch, rebuild it, and publish the new hashes in the same section.
#
#   ./build/bump-dev.sh            move to the tip, if it has moved
#   ./build/bump-dev.sh --force    rebuild and republish even if it has not
#
# The dev firmware is one commit, not "whatever dev is now", so that its zip can
# be rebuilt and compared like the release's. This is the one step that moves
# it, and it is a step a person takes: the result is a diff to UPSTREAM that has
# to be read, tested and committed, never something a build does by itself.
#
# In order:
#
#   1. Resolve the branch's tip with git ls-remote.
#   2. Read requirements.txt at that commit and check it against the dev
#      dependency table in build/build-firmware-zip.sh. If dev has moved a
#      dependency, stop and say which: the table carries a hash for every
#      artifact, and a new hash is something a person checks, not something
#      this script copies.
#   3. Write the new commit into UPSTREAM [dev], build it twice, and require the
#      two builds to agree before writing their hashes into the section.
#
# Requires what build/build-firmware-zip.sh requires.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
UPSTREAM_FILE="${REPO_ROOT}/UPSTREAM"
BUILD="${REPO_ROOT}/build/build-firmware-zip.sh"
SECTION="dev"

FORCE="no"
case "${1:-}" in
    "")         ;;
    --force)    FORCE="yes" ;;
    -h|--help)  sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)          echo "unknown option: $1" >&2; exit 2 ;;
esac

die() {
    echo "bump-dev: $*" >&2
    exit 1
}

step() {
    echo "==> $*"
}

# One key out of UPSTREAM [dev]. The same section-aware reader the build uses.
field() {
    awk -F= -v want="[${SECTION}]" -v key="$1" '
        /^\[/   { inside = ($0 == want); next }
        inside && $1 ~ "^[[:space:]]*" key "[[:space:]]*$" {
            gsub(/[[:space:]]/, "", $2); print $2
        }
    ' "${UPSTREAM_FILE}"
}

# Rewrite one key's value in UPSTREAM [dev], keeping its alignment and
# everything else in the file as it is.
set_field() {
    python3 - "${UPSTREAM_FILE}" "${SECTION}" "$1" "$2" <<'PY'
import re, sys

path, section, key, value = sys.argv[1:]
lines = open(path, encoding="utf-8").read().split("\n")
inside, done = False, False
for i, line in enumerate(lines):
    if line.startswith("["):
        inside = line.strip() == f"[{section}]"
    elif inside and re.match(rf"^{re.escape(key)}\s*=", line):
        lines[i] = re.sub(r"=\s*.*$", lambda m: m.group(0)[: len(m.group(0)) - len(m.group(0).lstrip("= \t"))] + value, line)
        done = True
if not done:
    sys.exit(f"no {key} in [{section}] of {path}")
open(path, "w", encoding="utf-8").write("\n".join(lines))
PY
}

REPO="$(field repo)"
BRANCH="$(field branch)"
CURRENT="$(field commit)"
[ -n "${REPO}" ] && [ -n "${BRANCH}" ] && [ -n "${CURRENT}" ] \
    || die "UPSTREAM [${SECTION}] needs repo, branch and commit"

# --- 1. the tip ---------------------------------------------------------------

step "tip of ${BRANCH} at ${REPO}"
TIP="$(GIT_TERMINAL_PROMPT=0 git ls-remote "${REPO}" "refs/heads/${BRANCH}" | cut -f1)"
[ -n "${TIP}" ] || die "could not resolve ${BRANCH} at ${REPO}"
echo "    pinned  ${CURRENT}"
echo "    tip     ${TIP}"

if [ "${TIP}" = "${CURRENT}" ] && [ "${FORCE}" = "no" ]; then
    echo "The pin is already the tip. Nothing to do (--force rebuilds anyway)."
    exit 0
fi

# --- 2. its dependencies against the table ------------------------------------

case "${REPO}" in
    https://github.com/*) ;;
    *) die "only a GitHub repo can be checked here: ${REPO}" ;;
esac
slug="${REPO#https://github.com/}"
slug="${slug%.git}"
requirements_url="https://raw.githubusercontent.com/${slug}/${TIP}/requirements.txt"

step "checking ${BRANCH}'s requirements.txt against the dev dependency table"
requirements="$(curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 \
    -- "${requirements_url}")" || die "could not fetch ${requirements_url}"
table="$(sed -n "/^read -r -d '' DEPENDENCIES_DEV <<'DEPS'/,/^DEPS$/p" "${BUILD}" | sed '1d;$d')"
[ -n "${table}" ] || die "no DEPENDENCIES_DEV table in ${BUILD}"

REQUIREMENTS="${requirements}" TABLE="${table}" python3 - <<'PY' || exit 1
import os, re, sys

# Two entries never go in the zip: Pillow is Pyodide's own, and pyzbar is a
# stand-in in src/fakes (see the build script). colorama is Windows-only.
NOT_IN_THE_ZIP = {"pillow", "pyzbar", "colorama"}

# requirements.txt, one entry per logical line: continuations joined, comments
# dropped, then each entry read as `name==version` or `name @ url`, with every
# --hash it lists.
text = re.sub(r"\\\n", " ", os.environ["REQUIREMENTS"])
wanted = {}
for line in text.splitlines():
    line = line.split("#", 1)[0].strip()
    if not line:
        continue
    hashes = re.findall(r"--hash=sha256:([0-9a-f]{64})", line)
    spec = line.split(";", 1)[0].split("--hash", 1)[0].strip()
    if " @ " in spec:
        name, url = (part.strip() for part in spec.split(" @ ", 1))
        commit = re.search(r"([0-9a-f]{40})", url)
        wanted[name.lower()] = ("commit", commit.group(1) if commit else url, hashes)
    elif "==" in spec:
        name, version = (part.strip() for part in spec.split("==", 1))
        wanted[name.lower()] = ("version", version, hashes)
    else:
        wanted[spec.lower()] = ("unpinned", spec, hashes)

table = {}
for row in os.environ["TABLE"].splitlines():
    if not row.strip():
        continue
    kind, module, dist, release, url, integrity, subpath = row.split("|")
    table[dist.lower()] = (kind, release, integrity)

problems = []
for name, (how, value, hashes) in sorted(wanted.items()):
    if name in NOT_IN_THE_ZIP:
        continue
    if name not in table:
        problems.append(f"{name}: in requirements.txt ({value}) but not in the table")
        continue
    kind, release, integrity = table[name]
    if release != value:
        problems.append(f"{name}: requirements.txt pins {value}, the table has {release}")
    elif kind == "pypi" and hashes and integrity not in hashes:
        problems.append(f"{name} {release}: the table's sha256 {integrity} is not one "
                        "requirements.txt lists")
for name in sorted(set(table) - set(wanted)):
    problems.append(f"{name}: in the table but no longer in requirements.txt")

if problems:
    print("dev's dependencies no longer match the dev table in build/build-firmware-zip.sh:",
          file=sys.stderr)
    for problem in problems:
        print(f"  {problem}", file=sys.stderr)
    print("Update the table -- artifact URL, sha256 and subpath, each checked by hand -- "
          "and run this again.", file=sys.stderr)
    sys.exit(1)
print("    they agree")
PY

# --- 3. move the pin, build, publish ------------------------------------------

step "pinning [${SECTION}] to ${TIP}"
set_field commit "${TIP}"

build_hashes() {
    local log
    log="$("${BUILD}" "${SECTION}" "$@" 2>&1)" || { echo "${log}" >&2; die "the build failed"; }
    echo "${log}" | awk '/^    zip       sha256 / { zip = $3 } /^    contents  sha256 / { contents = $3 }
                         END { print zip, contents }'
}

step "building it"
read -r zip1 contents1 <<< "$(build_hashes)"
step "building it again, from nothing cached, to check it reproduces"
read -r zip2 contents2 <<< "$(build_hashes --no-cache)"
[ -n "${zip1}" ] && [ "${zip1}" = "${zip2}" ] && [ "${contents1}" = "${contents2}" ] \
    || die "two builds of ${TIP} disagree (${zip1} / ${zip2}); not publishing either"

set_field zip_sha256 "${zip1}"
set_field zip_contents_sha256 "${contents1}"

# Once more, so the build-info beside the zip carries the hashes just published.
build_hashes >/dev/null

echo
echo "UPSTREAM [${SECTION}] is now ${TIP}"
echo "    zip       sha256 ${zip1}"
echo "    contents  sha256 ${contents1}"
echo
echo "Next: run the suite against it (SIM_FIRMWARE=dev python3 test/run.py), check"
echo "./build/update-checksums.sh --check, and commit UPSTREAM together with any"
echo "change to the dev dependency table."
