#!/usr/bin/env bash
#
# Build a firmware zip: the Python tree the simulator unpacks into the Pyodide
# filesystem at runtime.
#
# One firmware per section of UPSTREAM, named after it:
#
#   ./build/build-firmware-zip.sh              ->  build/out/seedsigner-stock.zip
#   ./build/build-firmware-zip.sh dev          ->  build/out/seedsigner-dev.zip
#   ./build/build-firmware-zip.sh pr-995       ->  build/out/seedsigner-pr-995.zip
#
# stock is a SeedSigner release, pinned by tag and commit, and the default. dev is
# one commit on SeedSigner's development branch, moved on purpose by
# build/bump-dev.sh. Each pr-<N> is the head of one SeedSigner pull request,
# added, moved and removed by build/pr.sh.
#
# Every build also rewrites build/out/firmwares.json, the list of firmwares the
# page offers, from every build-info.json in the output directory.
#
# The point of this script is that you do not have to trust the zip that is
# being served to you. Run it, and compare its sha256 to the one you downloaded.
# If they match, the served zip is exactly the pinned upstream SeedSigner tree
# plus its translations, compiled from the commit that tree pins for them, plus
# the pinned pure-Python dependencies plus this repository's own stand-in
# packages for the hardware it cannot have, plus deferred-fonts.json naming the
# fonts served beside it by hash, and nothing else.
#
#   ./build/build-firmware-zip.sh
#   sha256sum some-downloaded-seedsigner-stock.zip
#
# For that comparison to mean anything the build has to be reproducible, so:
#
#   * every input is content-addressed -- upstream and the git-pinned
#     dependencies by commit sha, the PyPI dependencies by artifact sha256, and
#     this repository's own stand-in packages by build/checksums.txt;
#   * the zip is written by hand rather than by the zip(1) command, with fixed
#     timestamps (SOURCE_DATE_EPOCH), fixed permissions, fixed entry order, and
#     no __pycache__ or .pyc anywhere;
#   * nothing about the build host leaks in: no paths, no user, no umask, no
#     timezone, no locale.
#
# Two hashes are printed. The first is the sha256 of the zip file, which is what
# you compare against a download. The second is the sha256 of a manifest of
# (sha256, path) over the zip's *contents*, which is independent of how well
# zlib happened to compress. If the zip hashes differ but the manifest hashes
# match, the two builds contain identical files and you are looking at a
# compressor difference, not a supply-chain difference.
#
# Requires: bash, git, curl, python3, and sha256sum (or shasum).

set -euo pipefail

# ---------------------------------------------------------------------------
# Where things are
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

OUT_DIR="${REPO_ROOT}/build/out"
CHECKSUMS_FILE="${REPO_ROOT}/build/checksums.txt"
CACHE_DIR="${FIRMWARE_BUILD_CACHE:-${XDG_CACHE_HOME:-${HOME}/.cache}/seedsigner-sim-build}"
KEEP_STAGING="no"

usage() {
    cat <<'USAGE'
Usage: build-firmware-zip.sh [FIRMWARE] [options]

  FIRMWARE         A section of UPSTREAM, and the name of the zip it builds:
    stock          the default: a SeedSigner release as its own project
                   publishes it                     ->  seedsigner-stock.zip
    dev            one commit of SeedSigner's development branch
                                                    ->  seedsigner-dev.zip
    pr-<N>         the pinned head of SeedSigner pull request <N>, added by
                   build/pr.sh                      ->  seedsigner-pr-<N>.zip

  --out DIR        Write the zip here (default: <repo>/build/out)
  --cache DIR      Cache downloaded PyPI artifacts here
                   (default: $XDG_CACHE_HOME/seedsigner-sim-build)
  --no-cache       Download everything fresh, cache nothing
  --keep-staging   Leave the assembled tree in the output directory, for
                   diffing against an unpacked firmware zip
  -h, --help       This message

Environment:
  SOURCE_DATE_EPOCH   Timestamp stamped into every zip entry. Defaults to the
                      commit date of the pinned upstream commit, so two people
                      who run this with no environment set get the same bytes.
  SS_REPO             Build from this clone URL instead of the pinned one.
  SS_COMMIT           Build from this commit, branch or tag instead of the pin.

                      Either or both, for testing your own SeedSigner fork in
                      the simulator. The zip you get will not hash to what
                      UPSTREAM publishes, because it is not that build, and it
                      says so in seedsigner-<firmware>.build-info.json and in the
                      page's i panel. See README.md.
USAGE
}

FIRMWARE="stock"

while [ "$#" -gt 0 ]; do
    case "$1" in
        --out)          OUT_DIR="$2"; shift 2 ;;
        --cache)        CACHE_DIR="$2"; shift 2 ;;
        --no-cache)     CACHE_DIR=""; shift ;;
        --keep-staging) KEEP_STAGING="yes"; shift ;;
        -h|--help)      usage; exit 0 ;;
        -*)             echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
        *)
            # A section name: checked against UPSTREAM once it has been read.
            case "$1" in
                *[!a-z0-9-]*|-*|"") echo "not a firmware name: $1" >&2; exit 2 ;;
            esac
            FIRMWARE="$1"; shift ;;
    esac
done

die() {
    echo "build-firmware-zip: $*" >&2
    exit 1
}

step() {
    echo "==> $*"
}

for tool in git curl python3; do
    command -v "$tool" >/dev/null 2>&1 || die "required tool not found: ${tool}"
done

# sha256sum on GNU systems, shasum -a 256 on macOS.
if command -v sha256sum >/dev/null 2>&1; then
    sha256_of() { sha256sum -- "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
    sha256_of() { shasum -a 256 -- "$1" | cut -d' ' -f1; }
else
    die "no sha256 tool found (looked for sha256sum and shasum)"
fi

# ---------------------------------------------------------------------------
# The dependency pins
# ---------------------------------------------------------------------------
#
# Upstream pins its Python dependencies in requirements.txt, some as PyPI
# versions and some as git or GitHub-archive URLs. Those pins are reproduced
# below, one row per dependency, in a form this script can act on.
#
# We do not shell out to pip. pip resolves, it does not just fetch: given the
# same requirements file on two machines it can pick different artifacts, it
# runs setup.py out of sdists (arbitrary code, arbitrary output), and it writes
# .dist-info directories whose contents depend on the pip and setuptools
# versions installed. None of that survives a byte-for-byte comparison. What we
# want is the narrow thing pip would be used for here: fetch one exact artifact,
# check it is the artifact we meant, unpack the pure-Python module out of it.
# That is what the table below describes, and it is auditable by reading it --
# every byte that enters the build is named and hashed here.
#
# Columns, pipe-separated:
#
#   kind      pypi (fetch an artifact by URL, verify sha256)
#             git  (clone and check out a commit, verified by git itself)
#   module    what lands at the top level of the zip: a package directory or a
#             single .py file
#   dist      distribution name, used to name its licence file
#   release   version, or the commit for git pins
#   url       artifact URL, or clone URL
#   integrity sha256 of the artifact, or the full commit sha
#   subpath   directory inside the unpacked source that contains `module`
#
# EXPECTED_TOP_LEVEL beside it is everything that must be at the top level of
# the finished zip, and nothing else. Checked before the zip is written, so a
# dependency that silently failed to unpack stops the build instead of shipping
# firmware that cannot import.


# One table per dependency set. Each section of UPSTREAM names the one it builds
# with (`deps =`); without one, stock uses the stock table and everything else
# the dev table, since pull requests are proposed against dev.
#
# Each requirements.txt has two entries that do not belong in a zip:
#
#   Pillow
#       A compiled extension. Pyodide ships its own and the worker asks for it
#       with loadPackage() at boot (see src/web/worker.js); a pure-Python
#       stand-in here would shadow the real one.
#   pyzbar
#       Binds libzbar, which has no WebAssembly build. Stock's decode_qr.py
#       imports it at module scope with no try/except, so the import has to
#       succeed: src/fakes/pyzbar is staged below and browser_camera.py replaces
#       the one function that would have called it.
#
# The rest are pinned here, at the versions each firmware's requirements.txt
# names.
#
# stock (0.8.7): embit 0.8.0, qrcode 7.3.1 and urtypes 1.0.1, all from PyPI.

read -r -d '' DEPENDENCIES_STOCK <<'DEPS' || true
pypi|embit|embit|0.8.0|https://files.pythonhosted.org/packages/83/88/b054b00ade6d2a41749e15976cdcec4b7ec4656ac1cb917ce3de395528d1/embit-0.8.0.tar.gz|8bf4b10073c67400370ce523fb16f035fe759f6fdd987c579bdcc268d75ed770|embit-0.8.0/src
pypi|qrcode|qrcode|7.3.1|https://files.pythonhosted.org/packages/94/9f/31f33cdf3cf8f98e64c42582fb82f39ca718264df61957f28b0bbb09b134/qrcode-7.3.1.tar.gz|375a6ff240ca9bd41adc070428b5dfc1dcfbb0f2507f1ac848f6cded38956578|qrcode-7.3.1
pypi|urtypes|urtypes|1.0.1|https://files.pythonhosted.org/packages/60/43/f4acb0faf63bb92070760a3039a8cae1a88c46947c71e77e99a03e196ea5/urtypes-1.0.1.tar.gz|4f1cd0ef34c21ae6f408520ecd9de0d2d157ee885b94ad9e6481cfbb3838558e|urtypes-1.0.1/src
DEPS

# dev: embit 0.8.0 as before; qrcode 8.0, the sdist whose sha256 dev's own
# hash-locked requirements.txt lists; and urtypes at the commit dev pins as a
# GitHub archive, fetched with git for the reason git_checkout gives below.
# build/bump-dev.sh compares this table with dev's requirements.txt whenever the
# pin moves, and stops if they no longer agree.

read -r -d '' DEPENDENCIES_DEV <<'DEPS' || true
pypi|embit|embit|0.8.0|https://files.pythonhosted.org/packages/83/88/b054b00ade6d2a41749e15976cdcec4b7ec4656ac1cb917ce3de395528d1/embit-0.8.0.tar.gz|8bf4b10073c67400370ce523fb16f035fe759f6fdd987c579bdcc268d75ed770|embit-0.8.0/src
pypi|qrcode|qrcode|8.0|https://files.pythonhosted.org/packages/d7/db/6fc9631cac1327f609d2c8ae3680ecd987a2e97472437f2de7ead1235156/qrcode-8.0.tar.gz|025ce2b150f7fe4296d116ee9bad455a6643ab4f6e7dce541613a4758cbce347|qrcode-8.0
git|urtypes|urtypes|7fb280eab3b3563dfc57d2733b0bf5cbc0a96a6a|https://github.com/selfcustody/urtypes.git|7fb280eab3b3563dfc57d2733b0bf5cbc0a96a6a|src
DEPS


EXPECTED_TOP_LEVEL=(
    LICENSE.md
    RPi
    deferred-fonts.json
    embit
    licenses
    main.py
    pyzbar
    qrcode
    seedsigner
    urtypes
)

# The translations are .po sources upstream compiles at build time, with Babel's
# compile_catalog and use_fuzzy (upstream's setup.cfg). The same tool, at one
# pinned artifact, compiles them here. It is a build tool only: it runs on the
# builder, out of its unpacked wheel, and none of it reaches the zip. A wheel is
# pure Python and runs as unpacked, so nothing is installed and pip is not run.
BABEL_URL="https://files.pythonhosted.org/packages/77/f5/21d2de20e8b8b0408f0681956ca2c69f1320a3848ac50e6e7f39c6159675/babel-2.18.0-py3-none-any.whl"
BABEL_SHA256="e2b422b277c2b9a9630c1d7903c2a00d0830c409c59ac8cae9081c92f1aeba35"

# Two import-time stand-ins. See src/fakes/README.md for what they are and are not. Rows are
# source:name-in-the-zip:what the licences manifest should call it.
STAGE_PACKAGES=(
    "${REPO_ROOT}/src/fakes/RPi:RPi:import stand-in, not RPi.GPIO"
    "${REPO_ROOT}/src/fakes/pyzbar:pyzbar:import stand-in, not pyzbar"
)


# ---------------------------------------------------------------------------
# Scratch space
# ---------------------------------------------------------------------------
#
# Deliberately outside the repository: a build must never leave anything behind
# in a tree someone is about to commit.

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/seedsigner-sim-build.XXXXXXXX")"
cleanup() {
    rm -rf -- "${WORK_DIR}"
}
trap cleanup EXIT

STAGING="${WORK_DIR}/staging"
SOURCES="${WORK_DIR}/sources"
mkdir -p "${STAGING}/licenses" "${SOURCES}"

if [ -n "${CACHE_DIR}" ]; then
    mkdir -p "${CACHE_DIR}"
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# fetch_verified URL EXPECTED_SHA256 DEST
#
# Serves the file from the cache when the cached copy hashes correctly, so a
# rebuild is fast and an offline rebuild is possible. The hash is re-checked on
# every use, cached or not, so a poisoned cache cannot get past this.
fetch_verified() {
    local url="$1" expected="$2" dest="$3"
    local cached=""

    if [ -n "${CACHE_DIR}" ]; then
        cached="${CACHE_DIR}/${expected}"
        if [ -f "${cached}" ] && [ "$(sha256_of "${cached}")" = "${expected}" ]; then
            cp -- "${cached}" "${dest}"
            return 0
        fi
    fi

    curl --fail --location --silent --show-error \
         --proto '=https' --tlsv1.2 \
         --retry 3 --retry-delay 2 \
         --output "${dest}" -- "${url}" \
        || die "download failed: ${url}"

    local actual
    actual="$(sha256_of "${dest}")"
    if [ "${actual}" != "${expected}" ]; then
        die "sha256 mismatch for ${url}
  expected ${expected}
  got      ${actual}"
    fi

    if [ -n "${cached}" ]; then
        cp -- "${dest}" "${cached}"
    fi
}

# unpack ARCHIVE DEST
#
# python3 rather than unzip/tar, so that .whl, .zip and .tar.gz all go through
# one code path and the script needs neither unzip nor bzip2 installed.
# tarfile's data filter rejects absolute paths, .. escapes, symlinks pointing
# out of the tree, devices and setuid bits.
unpack() {
    local archive="$1" dest="$2"
    mkdir -p "${dest}"
    python3 - "${archive}" "${dest}" <<'PY'
import sys, tarfile, zipfile

archive, dest = sys.argv[1], sys.argv[2]

if archive.endswith((".whl", ".zip")):
    with zipfile.ZipFile(archive) as zf:
        for name in zf.namelist():
            if name.startswith("/") or ".." in name.split("/"):
                sys.exit(f"refusing to extract unsafe path: {name}")
        zf.extractall(dest)
elif archive.endswith((".tar.gz", ".tgz", ".tar.bz2")):
    with tarfile.open(archive) as tf:
        tf.extractall(dest, filter="data")
else:
    sys.exit(f"do not know how to unpack {archive}")
PY
}

# git_checkout URL COMMIT DEST
#
# The commit sha is the integrity check: git verifies that the object graph it
# received hashes to the sha we asked for, so there is nothing extra to compare.
# This is also why the four dependencies upstream pins as GitHub archive .zip
# URLs are fetched with git here instead. Those URLs name a snapshot of a
# commit, but the zip around it is generated by GitHub on demand and its bytes
# are not promised to be stable, so hashing it would pin the archiver rather
# than the source. Checking out the same commit gets the same files by
# construction.
git_checkout() {
    local url="$1" commit="$2" dest="$3" fallback_ref="${4:-}"

    mkdir -p "${dest}"
    GIT_TERMINAL_PROMPT=0 git -C "${dest}" init --quiet
    GIT_TERMINAL_PROMPT=0 git -C "${dest}" remote add origin "${url}"
    if ! GIT_TERMINAL_PROMPT=0 git -C "${dest}" fetch --quiet --depth 1 origin "${commit}"; then
        [ -n "${fallback_ref}" ] || die "could not fetch ${commit} from ${url}"
        GIT_TERMINAL_PROMPT=0 git -C "${dest}" fetch --quiet --depth 1 origin "${fallback_ref}" \
            || die "could not fetch ${commit} or ${fallback_ref} from ${url}"
    fi
    GIT_TERMINAL_PROMPT=0 git -C "${dest}" -c advice.detachedHead=false \
        checkout --quiet FETCH_HEAD

    # Only when a sha is what was asked for, which is every row of the dependency
    # table and the pin itself. An SS_COMMIT override may name a branch or a tag,
    # which has no sha to compare against here; the caller reads back what it
    # resolved to and records that instead.
    if [ "${#commit}" -eq 40 ] && [ -z "${commit//[0-9a-f]/}" ]; then
        local head
        head="$(git -C "${dest}" rev-parse HEAD)"
        if [ "${head}" != "${commit}" ]; then
            die "checkout of ${url} landed on ${head}, expected ${commit}"
        fi
    fi
}

# What to tell somebody who hits either half of the check below. This build
# never rewrites build/checksums.txt: a build that refreshed the manifest would
# package a modified stand-in and call it correct, which is the one thing
# the manifest is here to stop. Regenerating is a separate command, run on
# purpose, leaving a diff.
REGENERATE_HINT="If the change is deliberate, regenerate the manifest with

    ./build/update-checksums.sh

and commit it together with the files that changed."

# verify_against_manifest DIR
#
# Every file under DIR has to be listed in build/checksums.txt and hash to what
# it says. This is the only input to the zip that is not already content
# addressed: upstream and the git dependencies are pinned by commit, the PyPI
# ones by artifact sha256, and these packages were copied out of the working tree
# as they happened to be. So a modified stand-in produced a different zip
# and nothing in the repository said which byte had moved.
#
# Both directions, because both are the same mistake here: a file that changed
# and a file that was added both end up in the zip, and the directory is copied
# whole. build/fetch-assets.sh --check asks the same two questions of the same
# file, so a checkout can be verified without building anything.
verify_against_manifest() {
    local dir="$1" file rel expected actual

    [ -f "${CHECKSUMS_FILE}" ] || die "missing ${CHECKSUMS_FILE}"

    while IFS= read -r file; do
        rel="${file#"${REPO_ROOT}/"}"
        expected="$(awk -v want="${rel}" '$2 == want { print $1 }' "${CHECKSUMS_FILE}")"
        [ -n "${expected}" ] || die "${rel} would be packaged into the zip but is not listed in build/checksums.txt
${REGENERATE_HINT}"

        actual="$(sha256_of "${file}")"
        if [ "${actual}" != "${expected}" ]; then
            die "${rel} does not match build/checksums.txt
  expected ${expected}
  got      ${actual}
${REGENERATE_HINT}"
        fi
    done < <(find "${dir}" -type f ! -name '*.pyc' ! -path '*/__pycache__/*')
}

# find_license ROOT
#
# Prints the shallowest LICENSE/LICENCE/COPYING file under ROOT. Shallowest,
# because several dependencies also ship a licence deep inside a vendored
# subpackage, and the one at the root is the one that governs the whole
# distribution.
find_license() {
    local root="$1"
    {
        find "${root}" -type f \
            \( -iname 'LICENSE' -o -iname 'LICENSE.*' \
            -o -iname 'LICENCE' -o -iname 'LICENCE.*' \
            -o -iname 'COPYING' -o -iname 'COPYING.*' \) \
        | awk -F/ '{ print NF "\t" $0 }' \
        | LC_ALL=C sort -k1,1n -k2,2
    } | sed -n '1p' | cut -f2-
}

# ---------------------------------------------------------------------------
# 1. The firmware: upstream SeedSigner at the pinned commit
# ---------------------------------------------------------------------------
#
# The pin lives in UPSTREAM rather than in this script, so there is exactly one
# place to look and exactly one place to change it.

UPSTREAM_FILE="${REPO_ROOT}/UPSTREAM"
[ -f "${UPSTREAM_FILE}" ] || die "missing ${UPSTREAM_FILE}"

# upstream_field KEY
#
# One key out of this firmware's section of UPSTREAM. Section-aware, so a key is
# only ever read from the section it belongs to. The same awk program appears in
# .github/workflows/reproducible-build.yml and upstream-tests.yml, which read
# the same file for the same reason.
upstream_field() {
    awk -F= -v want="[${FIRMWARE}]" -v key="$1" '
        /^\[/   { inside = ($0 == want); next }
        inside && $1 ~ "^[[:space:]]*" key "[[:space:]]*$" {
            gsub(/[[:space:]]/, "", $2); print $2
        }
    ' "${UPSTREAM_FILE}"
}

# A key whose value is text rather than a token, such as a pull request's title:
# everything after the first '=', trimmed, and nothing else touched.
upstream_text_field() {
    awk -v want="[${FIRMWARE}]" -v key="$1" '
        /^\[/   { inside = ($0 == want); next }
        inside {
            eq = index($0, "=")
            if (eq == 0) next
            name = substr($0, 1, eq - 1); gsub(/[[:space:]]/, "", name)
            if (name != key) next
            value = substr($0, eq + 1); sub(/^[[:space:]]+/, "", value); sub(/[[:space:]]+$/, "", value)
            print value
        }
    ' "${UPSTREAM_FILE}"
}

grep -qx "\[${FIRMWARE}\]" "${UPSTREAM_FILE}" || die "no [${FIRMWARE}] section in ${UPSTREAM_FILE}"

PINNED_REPO="$(upstream_field repo)"
PINNED_COMMIT="$(upstream_field commit)"
PR_NUMBER="$(upstream_field pr)"
PR_TITLE="$(upstream_text_field title)"

# The dependency table this firmware builds with.
DEPS_NAME="$(upstream_field deps)"
[ -n "${DEPS_NAME}" ] || { [ "${FIRMWARE}" = "stock" ] && DEPS_NAME="stock" || DEPS_NAME="dev"; }
case "${DEPS_NAME}" in
    stock) DEPENDENCIES="${DEPENDENCIES_STOCK}" ;;
    dev)   DEPENDENCIES="${DEPENDENCIES_DEV}" ;;
    *)     die "[${FIRMWARE}] names deps = ${DEPS_NAME}, and there is no such table (stock or dev)" ;;
esac
case "${PR_NUMBER}" in
    ""|*[!0-9]*) [ -z "${PR_NUMBER}" ] || die "[${FIRMWARE}] has pr = ${PR_NUMBER}, which is not a number" ;;
esac

[ -n "${PINNED_REPO}" ]   || die "no 'repo =' line in the [${FIRMWARE}] section of ${UPSTREAM_FILE}"
[ -n "${PINNED_COMMIT}" ] || die "no 'commit =' line in the [${FIRMWARE}] section of ${UPSTREAM_FILE}"

case "${PINNED_COMMIT}" in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ;;
    *) die "commit in ${UPSTREAM_FILE} is not a sha: ${PINNED_COMMIT}" ;;
esac

# The one supported way to build something that is not the pin: SS_REPO and
# SS_COMMIT. People fork SeedSigner, and the reasonable question "does my fork
# work in this simulator?" had no answer that did not involve editing UPSTREAM
# and then remembering to put it back. Either variable on its own is enough --
# a fork of the pinned repo needs only SS_COMMIT, and a rename only SS_REPO.
#
# SS_COMMIT may be any ref git can fetch, a branch or a tag as well as a sha,
# because somebody testing their own work has one checked out and not a sha
# memorised. Whatever it resolves to is read back afterwards and that is what
# gets recorded, so the build still says exactly what it built.
#
# What an override may NOT do is come out looking like the published build. It
# is not one, its hashes will not match the ones UPSTREAM publishes, and that is
# the correct outcome rather than a fault -- but only if it is visible. See the
# build-info.json section at the bottom, which is where the page reads it from.
OVERRIDDEN="no"
UPSTREAM_REPO="${PINNED_REPO}"
UPSTREAM_COMMIT="${PINNED_COMMIT}"

if [ -n "${SS_REPO:-}" ] || [ -n "${SS_COMMIT:-}" ]; then
    OVERRIDDEN="yes"
    UPSTREAM_REPO="${SS_REPO:-${PINNED_REPO}}"
    UPSTREAM_COMMIT="${SS_COMMIT:-${PINNED_COMMIT}}"
fi

step "firmware ${FIRMWARE}"
if [ "${OVERRIDDEN}" = "yes" ]; then
    step "OVERRIDE: SS_REPO/SS_COMMIT are set, so this is NOT the published build"
    step "upstream ${UPSTREAM_REPO} @ ${UPSTREAM_COMMIT}  (pin was ${PINNED_REPO} @ ${PINNED_COMMIT})"
else
    step "upstream ${UPSTREAM_REPO} @ ${UPSTREAM_COMMIT}"
fi

UPSTREAM_SRC="${SOURCES}/upstream"
# A pull request's head is fetched by its commit like any other pin; GitHub also
# publishes it as refs/pull/<N>/head, which is the way in should it ever refuse
# the bare commit. Either way HEAD has to land on the pinned sha.
PULL_REF=""
[ -z "${PR_NUMBER}" ] || [ "${OVERRIDDEN}" = "yes" ] || PULL_REF="refs/pull/${PR_NUMBER}/head"
git_checkout "${UPSTREAM_REPO}" "${UPSTREAM_COMMIT}" "${UPSTREAM_SRC}" "${PULL_REF}"

# A ref is not an identity, so what it resolved to is what gets recorded from
# here on. For the pin this changes nothing: git_checkout already refused to
# continue unless HEAD was that exact sha.
UPSTREAM_COMMIT="$(git -C "${UPSTREAM_SRC}" rev-parse HEAD)"
[ "${OVERRIDDEN}" = "no" ] || step "which is commit ${UPSTREAM_COMMIT}"

for required in src/seedsigner src/main.py LICENSE.md; do
    [ -e "${UPSTREAM_SRC}/${required}" ] || die "the tree at ${UPSTREAM_COMMIT} is missing ${required}"
done

# Upstream's translations are a git submodule, and the commit it points at is
# part of upstream's own tree: the pin already pins them, so nothing new is
# pinned here. Read before .git goes below. A tree with no submodule there
# builds English only, as the firmware does without it.
TRANSLATIONS_PATH="src/seedsigner/resources/seedsigner-translations"
TRANSLATIONS_COMMIT="$(git -C "${UPSTREAM_SRC}" ls-tree HEAD "${TRANSLATIONS_PATH}" \
    | awk '$2 == "commit" { print $3 }')"
TRANSLATIONS_REPO=""
if [ -n "${TRANSLATIONS_COMMIT}" ]; then
    TRANSLATIONS_REPO="$(git config -f "${UPSTREAM_SRC}/.gitmodules" \
        --get "submodule.${TRANSLATIONS_PATH}.url" || true)"
    [ -n "${TRANSLATIONS_REPO}" ] || die "the tree at ${UPSTREAM_COMMIT} pins ${TRANSLATIONS_PATH} but .gitmodules names no url for it"

    # Where the translations come from is written in the tree being built, and a
    # pull request's tree is whatever its author made it. Fetching any URL it
    # names would let one point this build at a server of their choosing, or at
    # a file:// repository on the machine running it, whose contents would then
    # be packed into a zip and served. There is one translations repository, so
    # that is the only one fetched; a tree that names another stops here.
    case "${TRANSLATIONS_REPO}" in
        https://github.com/SeedSigner/seedsigner-translations|https://github.com/SeedSigner/seedsigner-translations.git) ;;
        *) die "the tree at ${UPSTREAM_COMMIT} fetches its translations from ${TRANSLATIONS_REPO},
  not from https://github.com/SeedSigner/seedsigner-translations; refusing to fetch it" ;;
    esac
fi

# ---------------------------------------------------------------------------
# 2. Timestamp
# ---------------------------------------------------------------------------
#
# Zip entries carry an mtime, so an unpinned one would make every build differ.
# Defaulting to the pinned commit's own date means two people who set no
# environment variables still agree, and the date is derived from the pin rather
# than being one more magic number to trust.

# The commit's own date, whatever SOURCE_DATE_EPOCH is set to: build-info records
# it, and the page dates the firmware's files by it (see worker.js).
UPSTREAM_COMMIT_TIME="$(git -C "${UPSTREAM_SRC}" show -s --format=%ct HEAD)"
[ -n "${UPSTREAM_COMMIT_TIME}" ] || die "could not read the commit date of ${UPSTREAM_COMMIT}"

if [ -z "${SOURCE_DATE_EPOCH:-}" ]; then
    SOURCE_DATE_EPOCH="${UPSTREAM_COMMIT_TIME}"
    [ -n "${SOURCE_DATE_EPOCH}" ] || die "could not read the commit date of ${UPSTREAM_COMMIT}"
fi
export SOURCE_DATE_EPOCH
step "SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}"

# .git was only needed for the checkout and the date above. Removing it now
# keeps it out of the staged tree by construction rather than by filtering.
rm -rf -- "${UPSTREAM_SRC}/.git"

# Verbatim. Nothing in this repository patches the firmware -- the hardware seams
# are replaced from outside, by src/shims (which the worker writes into the
# filesystem after unpacking) and by the stand-in packages staged below.
cp -R -- "${UPSTREAM_SRC}/src/seedsigner" "${STAGING}/seedsigner"
cp    -- "${UPSTREAM_SRC}/src/main.py"    "${STAGING}/main.py"

# The MIT notice travels with the code it covers.
cp    -- "${UPSTREAM_SRC}/LICENSE.md"     "${STAGING}/LICENSE.md"
cp    -- "${UPSTREAM_SRC}/LICENSE.md"     "${STAGING}/licenses/SeedSigner.LICENSE"

# ---------------------------------------------------------------------------
# 2b. The translations: upstream's submodule, at the commit upstream pins
# ---------------------------------------------------------------------------
#
# What the firmware looks for: seedsigner-translations/l10n/<lang>/LC_MESSAGES/
# messages.mo under its resources, and any fonts it needs for a script its own
# fonts lack under seedsigner-translations/fonts. A language is offered only if
# its .mo is there (SettingsConstants.get_detected_languages).
#
# The .mo files go in the zip, compiled here as upstream compiles them. The
# fonts do not: the ones for Chinese, Japanese, Korean, Arabic and Thai come to
# some 22MB, most visitors never change language, and the zip is downloaded
# again whenever it changes. So they are published beside it in a directory
# named by a hash of what is in it, and deferred-fonts.json in the zip names each
# one with its sha256. The worker fetches a font the first time the firmware
# opens it and refuses one that does not hash to what the zip says.

TRANSLATION_LANGUAGES=""
FONTS_DIR_NAME=""
FONTS_SRC=""
if [ -n "${TRANSLATIONS_COMMIT}" ]; then
    step "translations ${TRANSLATIONS_REPO} @ ${TRANSLATIONS_COMMIT}"
    TRANSLATIONS_SRC="${SOURCES}/translations"
    git_checkout "${TRANSLATIONS_REPO}" "${TRANSLATIONS_COMMIT}" "${TRANSLATIONS_SRC}"
    rm -rf -- "${TRANSLATIONS_SRC}/.git"
    [ -d "${TRANSLATIONS_SRC}/l10n" ] || die "the translations at ${TRANSLATIONS_COMMIT} have no l10n directory"

    step "babel 2.18.0, to compile them"
    babel_dir="${SOURCES}/babel"
    mkdir -p "${babel_dir}"
    fetch_verified "${BABEL_URL}" "${BABEL_SHA256}" "${babel_dir}/${BABEL_URL##*/}"
    unpack "${babel_dir}/${BABEL_URL##*/}" "${babel_dir}/unpacked"

    # Upstream's own settings: messages domain, fuzzy entries kept. Quiet, because
    # it narrates every catalogue it writes.
    PYTHONPATH="${babel_dir}/unpacked" PYTHONDONTWRITEBYTECODE=1 \
        python3 -c 'import sys; from babel.messages.frontend import main; sys.exit(main())' \
        --quiet compile --use-fuzzy --domain messages --directory "${TRANSLATIONS_SRC}/l10n" \
        || die "babel could not compile the translations"

    staged_translations="${STAGING}/seedsigner/resources/seedsigner-translations"
    mkdir -p "${staged_translations}"
    while IFS= read -r mo; do
        rel="${mo#"${TRANSLATIONS_SRC}/"}"
        mkdir -p "${staged_translations}/$(dirname -- "${rel}")"
        cp -- "${mo}" "${staged_translations}/${rel}"
    done < <(find "${TRANSLATIONS_SRC}/l10n" -type f -name 'messages.mo' | LC_ALL=C sort)

    TRANSLATION_LANGUAGES="$( (cd -- "${staged_translations}/l10n" && find . -mindepth 1 -maxdepth 1 -type d) \
        | sed 's|^\./||' | LC_ALL=C sort | tr '\n' ' ')"
    [ -n "${TRANSLATION_LANGUAGES}" ] || die "no messages.mo came out of the translations"
    step "languages: ${TRANSLATION_LANGUAGES}"

    translations_license="$(find_license "${TRANSLATIONS_SRC}")"
    [ -n "${translations_license}" ] || die "the translations carry no licence file; refusing to redistribute them"
    cp -- "${translations_license}" "${staged_translations}/LICENSE"
    cp -- "${translations_license}" "${STAGING}/licenses/seedsigner-translations.LICENSE"

    [ ! -d "${TRANSLATIONS_SRC}/fonts" ] || FONTS_SRC="${TRANSLATIONS_SRC}/fonts"
fi

# The fonts' names and hashes, and the directory named by them. Written even
# when there are none, so the zip always has the same shape.
FONTS_DIR_NAME="$(python3 - "${FONTS_SRC}" "${STAGING}/deferred-fonts.json" <<'PY'
import hashlib, json, os, sys

source, out = sys.argv[1], sys.argv[2]
fonts = {}
if source:
    for name in sorted(os.listdir(source)):
        if name.lower().endswith((".ttf", ".otf")):
            with open(os.path.join(source, name), "rb") as handle:
                fonts[name] = hashlib.sha256(handle.read()).hexdigest()
listing = "".join(f"{digest}  {name}\n" for name, digest in sorted(fonts.items()))
directory = ("fonts-" + hashlib.sha256(listing.encode("utf-8")).hexdigest()[:8]) if fonts else None
with open(out, "w", encoding="utf-8") as handle:
    json.dump({"dir": directory, "fonts": fonts}, handle, indent=2, sort_keys=True)
    handle.write("\n")
print(directory or "")
PY
)"
[ -z "${FONTS_DIR_NAME}" ] || step "fonts, served beside the zip from ${FONTS_DIR_NAME}/"

# ---------------------------------------------------------------------------
# 3. This repository's stand-in packages
# ---------------------------------------------------------------------------
#
# Each one shadows a module the firmware imports and this environment cannot
# provide. They are top-level entries in the zip for exactly that reason:
# /firmware is first on sys.path, so the import in unmodified SeedSigner code
# finds ours. The list was chosen above:
#
#   RPi        an import stand-in for RPi.GPIO, which stock imports unguarded.
#   pyzbar     an import stand-in for the zbar binding, for the same reason.
#
# Each one is checked against build/checksums.txt before it is copied, so that
# last clause names a specific set of bytes rather than whatever the working tree
# happened to hold. It is the same manifest build/fetch-assets.sh --check reads,
# and the same two questions: does every file hash to what it should, and is
# every file in the directory listed at all.

MANIFEST_STAGED=""

for entry in "${STAGE_PACKAGES[@]}"; do
    IFS=':' read -r source name description <<< "${entry}"
    [ -f "${source}/__init__.py" ] || die "missing ${source}/__init__.py"
    step "stand-in ${name} (${source#"${REPO_ROOT}/"})"
    verify_against_manifest "${source}"
    cp -R -- "${source}" "${STAGING}/${name}"
    MANIFEST_STAGED="${MANIFEST_STAGED}$(printf '%-22s %-26s %s' "${name}" "this repository" "${description}")
"
done

# ---------------------------------------------------------------------------
# 4. Dependencies
# ---------------------------------------------------------------------------

MANIFEST="${WORK_DIR}/licenses-manifest.txt"
{
    echo "Third-party code redistributed inside this firmware zip."
    echo "Licence texts are the files alongside this one."
    echo "Written by build/build-firmware-zip.sh; see THIRD-PARTY.md for the full picture."
    echo
    printf '%-22s %-26s %s\n' "MODULE" "DISTRIBUTION" "RELEASE"
    printf '%-22s %-26s %s\n' "seedsigner, main.py" "SeedSigner" "commit ${UPSTREAM_COMMIT}"
    if [ -n "${TRANSLATIONS_COMMIT}" ]; then
        printf '%-22s %-26s %s\n' "seedsigner .mo files" "seedsigner-translations" "commit ${TRANSLATIONS_COMMIT}"
    fi
    printf '%s' "${MANIFEST_STAGED}"
} > "${MANIFEST}"

while IFS='|' read -r kind module dist release url integrity subpath; do
    [ -n "${kind}" ] || continue
    case "${kind}" in \#*) continue ;; esac

    step "dependency ${module} (${dist} ${release})"

    dep_dir="${SOURCES}/dep-${module}"
    mkdir -p "${dep_dir}"

    case "${kind}" in
        pypi)
            artifact="${dep_dir}/${url##*/}"
            fetch_verified "${url}" "${integrity}" "${artifact}"
            unpack "${artifact}" "${dep_dir}/unpacked"
            rm -f -- "${artifact}"
            ;;
        git)
            git_checkout "${url}" "${integrity}" "${dep_dir}/unpacked"
            rm -rf -- "${dep_dir}/unpacked/.git"
            ;;
        *)
            die "unknown dependency kind '${kind}' for ${module}"
            ;;
    esac

    source_path="${dep_dir}/unpacked/${subpath}/${module}"
    [ -e "${source_path}" ] || die "${dist} ${release}: expected ${subpath}/${module} in the unpacked source, not found"
    cp -R -- "${source_path}" "${STAGING}/${module}"

    license_file="$(find_license "${dep_dir}/unpacked")"
    [ -n "${license_file}" ] || die "${dist} ${release}: no licence file in the source; refusing to redistribute it"
    cp -- "${license_file}" "${STAGING}/licenses/${dist}.LICENSE"

    printf '%-22s %-26s %s\n' "${module}" "${dist}" "${release}" >> "${MANIFEST}"
done <<< "${DEPENDENCIES}"

cp -- "${MANIFEST}" "${STAGING}/licenses/MANIFEST.txt"

# ---------------------------------------------------------------------------
# 5. Scrub
# ---------------------------------------------------------------------------
#
# Compiled bytecode is host-specific and timestamped, so it can never be part of
# a reproducible artifact. Nothing in this build generates any, but a dependency
# could ship some, and the check below turns that into a build failure rather
# than a silent difference between two people's zips.

find "${STAGING}" -type d -name '__pycache__' -prune -exec rm -rf -- {} +
find "${STAGING}" -type f \( -name '*.pyc' -o -name '*.pyo' \) -delete

leftovers="$(find "${STAGING}" \( -name '__pycache__' -o -name '*.pyc' -o -name '*.pyo' \) -print)"
[ -z "${leftovers}" ] || die "bytecode survived the scrub:
${leftovers}"

# ---------------------------------------------------------------------------
# 6. Check the tree before writing anything
# ---------------------------------------------------------------------------
#
# Fail loudly here rather than ship a zip that unpacks into firmware which
# cannot import. Both directions are checked: a missing entry means a dependency
# did not unpack, an unexpected one means something got in that nobody declared.

actual_top_level="$( (cd -- "${STAGING}" && find . -mindepth 1 -maxdepth 1) | sed 's|^\./||' | LC_ALL=C sort | tr '\n' ' ')"
expected_top_level="$(printf '%s\n' "${EXPECTED_TOP_LEVEL[@]}" | LC_ALL=C sort | tr '\n' ' ')"

if [ "${actual_top_level}" != "${expected_top_level}" ]; then
    die "staged tree does not have the expected top level
  expected: ${expected_top_level}
  actual:   ${actual_top_level}"
fi

[ -f "${STAGING}/seedsigner/controller.py" ] || die "staged seedsigner package looks wrong: no controller.py"

for entry in "${STAGE_PACKAGES[@]}"; do
    IFS=':' read -r _ name _ <<< "${entry}"
    [ -f "${STAGING}/${name}/__init__.py" ] || die "staged ${name} package looks wrong: no __init__.py"
done

# ---------------------------------------------------------------------------
# 7. Write the zip
# ---------------------------------------------------------------------------
#
# Written entry by entry rather than with zip(1), because the things that make a
# zip non-reproducible are all defaults zip(1) takes from the host: entry order
# from readdir, mtimes from the filesystem, permissions from the umask, and a
# "created by" byte from the platform. Every one of those is pinned below.

# Named after the firmware, so both can sit in one directory and be served side
# by side, and so a downloaded file says which pin it is meant to match.
mkdir -p "${OUT_DIR}"
OUT_ZIP="${OUT_DIR}/seedsigner-${FIRMWARE}.zip"
OUT_MANIFEST="${OUT_DIR}/seedsigner-${FIRMWARE}.zip.manifest"

step "writing ${OUT_ZIP}"
python3 - "${STAGING}" "${OUT_ZIP}" "${OUT_MANIFEST}" "${SOURCE_DATE_EPOCH}" <<'PY'
import hashlib
import os
import sys
import time
import zipfile

staging, out_zip, out_manifest, epoch = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])

# gmtime, not localtime: a zip stores a bare DOS timestamp with no zone, so
# local time would make the artifact depend on the builder's TZ.
stamp = time.gmtime(epoch)[:6]
if stamp[0] < 1980:
    sys.exit("SOURCE_DATE_EPOCH is before 1980, which a zip timestamp cannot represent")

entries = []  # (archive name, source path, or None for a directory)
for root, dirnames, filenames in os.walk(staging):
    dirnames.sort()
    filenames.sort()
    for name in dirnames:
        full = os.path.join(root, name)
        entries.append((os.path.relpath(full, staging).replace(os.sep, "/") + "/", None))
    for name in filenames:
        full = os.path.join(root, name)
        if os.path.islink(full):
            sys.exit(f"refusing to archive a symlink: {full}")
        entries.append((os.path.relpath(full, staging).replace(os.sep, "/"), full))

# One canonical order, by archive name, independent of the order in which the
# filesystem happened to hand back its directory listings.
entries.sort(key=lambda item: item[0])

manifest = []

with zipfile.ZipFile(out_zip, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
    zf.comment = b""
    for arcname, source in entries:
        info = zipfile.ZipInfo(arcname, date_time=stamp)
        info.create_system = 3  # Unix, whatever the host actually is
        if source is None:
            info.external_attr = (0o40755 << 16) | 0x10
            info.compress_type = zipfile.ZIP_STORED
            zf.writestr(info, b"")
        else:
            with open(source, "rb") as handle:
                data = handle.read()
            # Fixed permissions: the umask of whoever ran the build must not
            # reach the artifact.
            info.external_attr = 0o100644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, data)
            manifest.append(f"{hashlib.sha256(data).hexdigest()}  {arcname}")

manifest_text = "\n".join(manifest) + "\n"
with open(out_manifest, "w", encoding="utf-8") as handle:
    handle.write(manifest_text)

with open(out_zip, "rb") as handle:
    zip_digest = hashlib.sha256(handle.read()).hexdigest()

print(f"    files     {len(manifest)}")
print(f"    zip       sha256 {zip_digest}")
print(f"    contents  sha256 {hashlib.sha256(manifest_text.encode('utf-8')).hexdigest()}")
PY

# The deferred fonts, beside the zip, under the name deferred-fonts.json gives
# them. An older fonts-* directory goes unless the other firmware's build-info in
# the same directory still names it: the two firmwares share one directory when
# they pin the same translations, and each needs its own when they do not.
python3 - "${OUT_DIR}" "${FIRMWARE}" "${FONTS_DIR_NAME}" <<'PY'
import glob, json, os, shutil, sys

out, firmware, mine = sys.argv[1], sys.argv[2], sys.argv[3]
keep = {mine} if mine else set()
for info_path in glob.glob(os.path.join(out, "seedsigner-*.build-info.json")):
    if os.path.basename(info_path) == f"seedsigner-{firmware}.build-info.json":
        continue
    try:
        with open(info_path, encoding="utf-8") as handle:
            fonts = ((json.load(handle).get("translations") or {}).get("fonts") or {})
        if fonts.get("dir"):
            keep.add(fonts["dir"])
    except (OSError, ValueError):
        pass
for path in glob.glob(os.path.join(out, "fonts-*")):
    if os.path.isdir(path) and os.path.basename(path) not in keep:
        shutil.rmtree(path)
PY
if [ -n "${FONTS_DIR_NAME}" ]; then
    mkdir -p "${OUT_DIR}/${FONTS_DIR_NAME}"
    for font in "${FONTS_SRC}"/*; do
        case "${font}" in *.ttf|*.otf|*.TTF|*.OTF) cp -- "${font}" "${OUT_DIR}/${FONTS_DIR_NAME}/" ;; esac
    done
    step "wrote ${OUT_DIR}/${FONTS_DIR_NAME}/"
fi

if [ "${KEEP_STAGING}" = "yes" ]; then
    rm -rf -- "${OUT_DIR}/staging-${FIRMWARE}"
    cp -R -- "${STAGING}" "${OUT_DIR}/staging-${FIRMWARE}"
    step "staged tree kept at ${OUT_DIR}/staging-${FIRMWARE}"
fi

# ---------------------------------------------------------------------------
# 8. What this build is, written down for the page
# ---------------------------------------------------------------------------
#
# The simulator shows a visitor what it is running: the firmware, the pin it
# came from, the hashes to compare against, what the zip carries and which
# Pyodide interprets it. That description has to be produced by the build, not
# maintained beside it, or it becomes one more thing that can drift and be wrong
# exactly when someone is checking. Every field below is read out of UPSTREAM,
# out of the dependency table in this file, out of build/fetch-assets.sh, or out
# of what the translations step above found in upstream's tree and compiled.
#
# Beside the zip and not inside it: the zip's bytes are the thing being
# compared, and nothing added here may touch them.
#
# The two hashes are the ones UPSTREAM publishes, deliberately, rather than the
# ones this run just printed. They are what a reader is asked to compare
# against, so a build that stopped reproducing has to show up as a mismatch on
# the page rather than quietly publishing whatever it produced.
#
# Which is also what makes an SS_REPO/SS_COMMIT override announce itself with no
# special case: the published hashes stay published hashes, the zip beside them
# is a different zip, and the page's own check compares the two and puts up "the
# firmware zip this page loaded is not the published build" in as many words. The
# three fields below add what that verdict cannot say on its own -- that the
# difference is an override rather than tampering, and what it was built from.
#
# A build from the pin writes exactly the bytes it wrote before this existed.
# Nothing is added to describe a build that has not changed, so a deployment does
# not have to be touched for a firmware nobody rebuilt.

# A release is named by its tag; the dev pin by the branch its commit is on.
UPSTREAM_TAG="$(upstream_field tag)"
UPSTREAM_BRANCH="$(upstream_field branch)"
PUBLISHED_ZIP_SHA256="$(upstream_field zip_sha256)"
PUBLISHED_CONTENTS_SHA256="$(upstream_field zip_contents_sha256)"

[ -n "${UPSTREAM_TAG}${UPSTREAM_BRANCH}${PR_NUMBER}" ] || die "no 'tag =', 'branch =' or 'pr =' line in the [${FIRMWARE}] section of ${UPSTREAM_FILE}"
[ -n "${PUBLISHED_ZIP_SHA256}" ]       || die "no 'zip_sha256 =' line in the [${FIRMWARE}] section of ${UPSTREAM_FILE}"
[ -n "${PUBLISHED_CONTENTS_SHA256}" ]  || die "no 'zip_contents_sha256 =' line in the [${FIRMWARE}] section of ${UPSTREAM_FILE}"

# What the panel shows in its first two rows, which is where a reader starts.
# There is no tag on an override -- the pin's tag describes the pin's commit and
# nothing else -- so the row says what happened instead of showing a release name
# that would be a lie or an empty box that would say nothing at all.
INFO_FIRMWARE_TEXT="${FIRMWARE}"
if [ "${OVERRIDDEN}" = "yes" ]; then
    INFO_FIRMWARE_TEXT="${FIRMWARE}, but NOT the published build: built from an SS_REPO / SS_COMMIT override rather than from the pin in UPSTREAM, so none of the hashes below will match and that is correct"
    UPSTREAM_TAG="none: an override is not a release"
    UPSTREAM_BRANCH=""
    PR_NUMBER=""
fi

# The runtime is fetched by another script and pinned there, which makes that
# script the one place the version is written down.
ASSETS_SCRIPT="${REPO_ROOT}/build/fetch-assets.sh"
[ -f "${ASSETS_SCRIPT}" ] || die "missing ${ASSETS_SCRIPT}"
PYODIDE_VERSION="$(sed -n 's/^PYODIDE_VERSION="\([^"]*\)".*$/\1/p' "${ASSETS_SCRIPT}" | sed -n 1p)"
[ -n "${PYODIDE_VERSION}" ] || die "no PYODIDE_VERSION= line in ${ASSETS_SCRIPT}"

OUT_INFO="${OUT_DIR}/seedsigner-${FIRMWARE}.build-info.json"

step "writing ${OUT_INFO}"
INFO_FIRMWARE="${INFO_FIRMWARE_TEXT}" \
INFO_REPO="${UPSTREAM_REPO}" \
INFO_COMMIT="${UPSTREAM_COMMIT}" \
INFO_COMMIT_TIME="${UPSTREAM_COMMIT_TIME}" \
INFO_TAG="${UPSTREAM_TAG}" \
INFO_BRANCH="${UPSTREAM_BRANCH}" \
INFO_PR_NUMBER="${PR_NUMBER}" \
INFO_PR_TITLE="${PR_TITLE}" \
INFO_ZIP="seedsigner-${FIRMWARE}.zip" \
INFO_ZIP_SHA256="${PUBLISHED_ZIP_SHA256}" \
INFO_CONTENTS_SHA256="${PUBLISHED_CONTENTS_SHA256}" \
INFO_PYODIDE="${PYODIDE_VERSION}" \
INFO_DEPENDENCIES="${DEPENDENCIES}" \
INFO_OVERRIDDEN="${OVERRIDDEN}" \
INFO_PINNED_REPO="${PINNED_REPO}" \
INFO_PINNED_COMMIT="${PINNED_COMMIT}" \
INFO_BUILT_SHA256="$(sha256_of "${OUT_ZIP}")" \
INFO_TRANSLATIONS_REPO="${TRANSLATIONS_REPO}" \
INFO_TRANSLATIONS_COMMIT="${TRANSLATIONS_COMMIT}" \
INFO_LANGUAGES="${TRANSLATION_LANGUAGES}" \
python3 - "${OUT_INFO}" "${STAGING}/deferred-fonts.json" <<'PY'
import json
import os
import sys

# The same rows the build just acted on, so the list a reader is shown is the
# list that was fetched rather than a description of it.
dependencies = []
for line in os.environ["INFO_DEPENDENCIES"].splitlines():
    if not line.strip() or line.startswith("#"):
        continue
    kind, module, dist, release = line.split("|")[:4]
    dependencies.append({"name": dist, "version": release,
                         "module": module, "kind": kind})

info = {
    "firmware": os.environ["INFO_FIRMWARE"],
    "upstream": {
        "repo": os.environ["INFO_REPO"],
        "commit": os.environ["INFO_COMMIT"],
        # Seconds since the epoch, as git records the commit.
        "commit_time": int(os.environ["INFO_COMMIT_TIME"]),
    },
    "zip": {
        "name": os.environ["INFO_ZIP"],
        "published_sha256": os.environ["INFO_ZIP_SHA256"],
        "published_contents_sha256": os.environ["INFO_CONTENTS_SHA256"],
    },
    "pyodide": os.environ["INFO_PYODIDE"],
    "dependencies": dependencies,
}
# A release has a tag; the dev pin has the branch its commit is on instead.
if os.environ["INFO_TAG"]:
    info["upstream"]["tag"] = os.environ["INFO_TAG"]
if os.environ["INFO_BRANCH"]:
    info["upstream"]["branch"] = os.environ["INFO_BRANCH"]
# A pull request: its number, its title as pinned, and where to read it.
if os.environ["INFO_PR_NUMBER"]:
    number = int(os.environ["INFO_PR_NUMBER"])
    web = os.environ["INFO_REPO"].removesuffix(".git")
    info["pr"] = {"number": number, "title": os.environ["INFO_PR_TITLE"],
                  "url": f"{web}/pull/{number}"}

# The translations, which upstream's own tree pins, and the fonts served beside
# the zip for them, with the hashes the zip's deferred-fonts.json holds them to.
if os.environ["INFO_TRANSLATIONS_COMMIT"]:
    with open(sys.argv[2], encoding="utf-8") as handle:
        deferred = json.load(handle)
    info["translations"] = {
        "repo": os.environ["INFO_TRANSLATIONS_REPO"],
        "commit": os.environ["INFO_TRANSLATIONS_COMMIT"],
        "languages": os.environ["INFO_LANGUAGES"].split(),
        "fonts": deferred,
    }

# Only on an override, so a build from the pin writes what it always wrote. The
# two hashes above stay the published ones on purpose: they are what a reader is
# asked to compare against, and here they are what this zip is being said not to
# be. published_build says so for a machine; the firmware line above says so for
# a person; the zip's own sha256 is here so the two can be compared without
# fetching anything.
if os.environ["INFO_OVERRIDDEN"] == "yes":
    info["published_build"] = False
    info["override"] = {
        "reason": "SS_REPO / SS_COMMIT were set, so this was built from a tree "
                  "this repository does not pin. It is not the published build, "
                  "its hashes will not match the published ones, and that is the "
                  "expected result rather than a failure.",
        "pinned_repo": os.environ["INFO_PINNED_REPO"],
        "pinned_commit": os.environ["INFO_PINNED_COMMIT"],
        "built_sha256": os.environ["INFO_BUILT_SHA256"],
    }

# Nothing dated, nothing about this machine, nothing from a set: two runs of
# this script write the same bytes, the same way the zip beside it does.
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump(info, handle, indent=2)
    handle.write("\n")
PY

# ---------------------------------------------------------------------------
# 9. The list the page offers
# ---------------------------------------------------------------------------
#
# Every firmware whose build-info sits in this directory, in the order the page
# shows them: the release, the development branch, then pull requests, newest
# first. Rewritten whole by every build, from the build-infos rather than from
# UPSTREAM, so it lists exactly what has been built here and so will be served.

step "writing ${OUT_DIR}/firmwares.json"
python3 "${SCRIPT_DIR}/firmware-index.py" "${OUT_DIR}" || die "could not write firmwares.json"

step "done"
echo
echo "  ${OUT_ZIP}"
echo "  ${OUT_MANIFEST}"
echo "  ${OUT_INFO}"
[ -z "${FONTS_DIR_NAME}" ] || echo "  ${OUT_DIR}/${FONTS_DIR_NAME}/"
echo

if [ "${OVERRIDDEN}" = "yes" ]; then
    # Last thing on the screen, because the first thing was minutes ago and the
    # mistake this guards against is walking away with a zip you think is the
    # published one.
    echo "THIS IS NOT THE PUBLISHED BUILD."
    echo
    echo "  built from  ${UPSTREAM_REPO} @ ${UPSTREAM_COMMIT}"
    echo "  the pin is  ${PINNED_REPO} @ ${PINNED_COMMIT}"
    echo
    echo "So its sha256 will not be the one the [${FIRMWARE}] section of UPSTREAM"
    echo "publishes, and a page serving it will say the zip it loaded is not the"
    echo "published build. That is the right answer for a build from your own tree,"
    echo "not a fault. Unset SS_REPO and SS_COMMIT and rebuild to get the pinned one."
else
    echo "Compare the zip sha256 above with the seedsigner-${FIRMWARE}.zip you were served,"
    echo "and with the [${FIRMWARE}] section of UPSTREAM."
    echo "If those differ but the contents sha256 matches, the two builds hold the"
    echo "same files and you are looking at a zlib difference, not a code difference."
fi
