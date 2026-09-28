#!/usr/bin/env bash
#
# Fetch the Pyodide runtime -- the CPython-on-WebAssembly build the simulator
# runs the firmware inside -- and zxing-wasm, the page's QR decoder.
#
# It is about 26 MB of prebuilt binaries and it is deliberately not committed:
# a git repository is a bad place for a WASM blob nobody can read, and putting
# it there would invite the reader to trust it because it is "in the repo". It
# is fetched instead, pinned to one release, and checked against a sha256 that
# is written down here in plain sight. A mismatch stops the script; it never
# unpacks something it could not identify.
#
#   ./build/fetch-assets.sh              # fetch into src/web/pyodide-e24b45d3
#                                        # and src/web/zxing-2416232a
#   ./build/fetch-assets.sh --check      # re-verify what is already on disk
#
# Trust chain, in the order it is established:
#
#   1. pyodide-core-<version>.tar.bz2 is fetched from the pyodide GitHub
#      release and checked against PYODIDE_CORE_SHA256 below.
#   2. That tarball contains pyodide-lock.json, which lists every package in the
#      distribution with its own sha256. Because the tarball is verified, the
#      lock file is too.
#   3. The compiled packages the firmware needs at runtime (Pillow and
#      pycryptodome, and anything they depend on) are fetched
#      separately and checked against the hashes in that lock file. No hash for
#      them is written down here, because it does not need to be -- it is
#      already inside something we verified.
#   4. zxing-wasm is a separate chain of one link: its npm tarball, checked
#      against ZXING_SHA256, with the two files taken out of it checked
#      against their own hashes as well.
#
# Requires: bash, curl, python3, and sha256sum (or shasum).

set -euo pipefail

# ---------------------------------------------------------------------------
# The pin
# ---------------------------------------------------------------------------
#
# Not a guess: this is the version the deployed simulator is running. It is
# recorded in the "version" field of the pyodide-lock.json that ships with the
# runtime, and the check further down re-reads that field after unpacking and
# refuses to continue if it disagrees with this line.
#
# Pyodide 0.26.4 is CPython 3.12.1 built for emscripten 3.1.58, ABI 2024_0.
# Changing this version means changing the ABI tags of every wheel below, so it
# is not a number to bump casually.

PYODIDE_VERSION="0.26.4"
PYODIDE_CORE_URL="https://github.com/pyodide/pyodide/releases/download/${PYODIDE_VERSION}/pyodide-core-${PYODIDE_VERSION}.tar.bz2"
PYODIDE_CORE_SHA256="70dba93432f3653155998cc9001f9c200182343c2f95165a2f9e9e4673fa35e8"

# Where the individual package wheels come from. The GitHub release only
# publishes whole-distribution tarballs -- the full one is 300 MB -- so the
# wheels are taken one at a time from the CDN that Pyodide itself defaults to,
# and every one is checked against the lock file before it is kept.
PYODIDE_CDN="https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full"

# Must match the loadPackage() call in src/web/worker.js. Their
# dependencies are resolved from pyodide-lock.json rather than listed here, so
# this stays the short list of what the firmware actually asks for. The script
# prints the worker's line at the end so any drift is visible on sight.
PYODIDE_PACKAGES=(Pillow pycryptodome)

# ---------------------------------------------------------------------------
# Where things are
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

DEST_DIR="${REPO_ROOT}/src/web/pyodide-e24b45d3"
CHECKSUMS_FILE="${SCRIPT_DIR}/checksums.txt"
MODE="fetch"

usage() {
    cat <<'USAGE'
Usage: fetch-assets.sh [options]

  --dest DIR   Where to put the Pyodide runtime
               (default: <repo>/src/web/pyodide-e24b45d3, which is the name the
               worker loads and which .gitignore excludes). zxing-wasm goes
               beside it, in zxing-2416232a
  --check      Verify what is already on disk and exit. Touches the network
               only if something is missing.
  --force      Re-download even if the destination already verifies
  -h, --help   This message
USAGE
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --dest)    DEST_DIR="$2"; shift 2 ;;
        --check)   MODE="check"; shift ;;
        --force)   MODE="force"; shift ;;
        -h|--help) usage; exit 0 ;;
        *)         echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
    esac
done

die() {
    echo "fetch-assets: $*" >&2
    exit 1
}

step() {
    echo "==> $*"
}

for tool in curl python3; do
    command -v "$tool" >/dev/null 2>&1 || die "required tool not found: ${tool}"
done

if command -v sha256sum >/dev/null 2>&1; then
    sha256_of() { sha256sum -- "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
    sha256_of() { shasum -a 256 -- "$1" | cut -d' ' -f1; }
else
    die "no sha256 tool found (looked for sha256sum and shasum)"
fi

# Scratch space for everything downloaded, removed however the script exits.
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/seedsigner-sim-assets.XXXXXXXX")"
cleanup() {
    rm -rf -- "${WORK_DIR}"
}
trap cleanup EXIT

# download URL DEST
download() {
    curl --fail --location --silent --show-error \
         --proto '=https' --tlsv1.2 \
         --retry 3 --retry-delay 2 \
         --output "$2" -- "$1" \
        || die "download failed: $1"
}

# ---------------------------------------------------------------------------
# The committed build inputs
# ---------------------------------------------------------------------------
#
# Separate from Pyodide, and cheap, so it runs on every invocation: build/
# checksums.txt lists every file that is committed to this repository and then
# served or packaged as-is. Anyone can also run
#
#     sha256sum -c build/checksums.txt
#
# from the repository root; the loop below exists so that the check works the
# same way on a machine whose sha256 tool is shasum.
#
# The other direction is asked as well, because checking only the files the
# manifest happens to name would miss a file added since it was written: it would
# be served, or packaged into a firmware zip, and be listed nowhere. Which files
# should be listed is not repeated here -- build/update-checksums.sh --list is
# the one place that decides, and the same script is what regenerates the file
# when a change to one of them is deliberate.

UPDATE_CHECKSUMS="${SCRIPT_DIR}/update-checksums.sh"
REGENERATE_HINT="If the change is deliberate, regenerate the manifest with

    ./build/update-checksums.sh

and commit it together with the files that changed."

verify_checksums() {
    [ -f "${CHECKSUMS_FILE}" ] || die "missing ${CHECKSUMS_FILE}"

    local failures=0 checked=0 expected path actual
    while read -r expected path; do
        case "${expected}" in ''|\#*) continue ;; esac

        if [ ! -f "${REPO_ROOT}/${path}" ]; then
            echo "    MISSING  ${path}" >&2
            failures=$((failures + 1))
            continue
        fi

        actual="$(sha256_of "${REPO_ROOT}/${path}")"
        if [ "${actual}" = "${expected}" ]; then
            echo "    ok       ${path}"
        else
            echo "    CHANGED  ${path}" >&2
            echo "               expected ${expected}" >&2
            echo "               got      ${actual}" >&2
            failures=$((failures + 1))
        fi
        checked=$((checked + 1))
    done < "${CHECKSUMS_FILE}"

    [ "${failures}" -eq 0 ] || die "${failures} committed file(s) do not match build/checksums.txt

${REGENERATE_HINT}"
    [ "${checked}" -gt 0 ]  || die "build/checksums.txt listed nothing to check"
}

# The other direction: every file that should be listed, is. The set comes from
# build/update-checksums.sh, so this cannot drift from what regenerating the
# manifest would produce.
verify_manifest_covers() {
    local rel unlisted=0 covered

    [ -x "${UPDATE_CHECKSUMS}" ] || die "missing ${UPDATE_CHECKSUMS}"
    covered="$("${UPDATE_CHECKSUMS}" --list)" || die "could not list the files build/checksums.txt should cover"
    [ -n "${covered}" ] || die "build/update-checksums.sh --list named no files"

    while IFS= read -r rel; do
        [ -n "${rel}" ] || continue
        if awk -v want="${rel}" '$2 == want { found = 1 } END { exit !found }' \
               "${CHECKSUMS_FILE}"; then
            continue
        fi
        echo "    UNLISTED ${rel}" >&2
        unlisted=$((unlisted + 1))
    done <<< "${covered}"

    [ "${unlisted}" -eq 0 ] || die "${unlisted} file(s) are served or packaged into a firmware zip but are not in build/checksums.txt

${REGENERATE_HINT}"
    echo "    ok       every file it should cover is listed ($(echo "${covered}" | wc -l | tr -d ' ') of them)"
}

step "checking committed build inputs against build/checksums.txt"
verify_checksums
verify_manifest_covers

# ---------------------------------------------------------------------------
# zxing-wasm, the QR decoder
# ---------------------------------------------------------------------------
#
# src/web/camera.js decodes every camera frame with zxing-wasm, a WebAssembly
# build of zxing-cpp, in every browser, and falls back to jsQR only if it is
# missing. jsQR alone is slow to find a QR in a real camera frame, and without
# a native BarcodeDetector to point it -- Safari, so every browser on an
# iPhone, and Chrome on Windows and Linux -- can take many seconds.
#
# Two files from one npm tarball: the reader's loader and the binary it
# instantiates. They are taken together because the loader is Emscripten glue
# generated for exactly that binary, and a pair from different releases fails
# in ways that look like anything but a version mismatch. The tarball is checked
# before anything is read out of it, and each file afterwards, so what is on
# disk can be re-verified later without the network.
#
# The directory is named after the tarball's hash, the way pyodide-e24b45d3 is
# named, and for the same reason: sw.js caches such paths forever, which is only
# safe if different bytes always arrive under a different name. camera.js names
# the directory too; the three must change together.

ZXING_VERSION="3.1.4"
ZXING_URL="https://registry.npmjs.org/zxing-wasm/-/zxing-wasm-${ZXING_VERSION}.tgz"
ZXING_SHA256="2416232a155533bdcfa098a22ec9087734b34640ffa2a7add90bc36e145f6da0"

# Beside the Pyodide runtime, wherever --dest puts it: both are served from the
# page's own directory.
ZXING_DIR="$(dirname -- "${DEST_DIR}")/zxing-${ZXING_SHA256:0:8}"

# "path in the tarball  name served  sha256"
ZXING_FILES=(
    "package/dist/iife/reader/index.js      index.js           d33d09ce132a692faffbed0dce656c36cb2573b4b843885a6e036390d1071d95"
    "package/dist/reader/zxing_reader.wasm  zxing_reader.wasm  e8af31edb56d0522f4de74495839385ef019ba8bc90d38e5ecb2f18795d86fb2"
)

# zxing_installed  ->  0 if both files are present and hash correctly.
zxing_installed() {
    local entry member name expected ok=0
    for entry in "${ZXING_FILES[@]}"; do
        read -r member name expected <<< "${entry}"
        if [ ! -f "${ZXING_DIR}/${name}" ]; then
            echo "    missing  ${name}"
            ok=1
        elif [ "$(sha256_of "${ZXING_DIR}/${name}")" != "${expected}" ]; then
            echo "    CHANGED  ${name}"
            ok=1
        fi
    done
    return "${ok}"
}

fetch_zxing() {
    local tarball="${WORK_DIR}/zxing-wasm-${ZXING_VERSION}.tgz" actual entry member name expected

    step "downloading ${ZXING_URL}"
    download "${ZXING_URL}" "${tarball}"

    actual="$(sha256_of "${tarball}")"
    if [ "${actual}" != "${ZXING_SHA256}" ]; then
        die "sha256 mismatch on zxing-wasm -- REFUSING TO UNPACK
  url      ${ZXING_URL}
  expected ${ZXING_SHA256}
  got      ${actual}"
    fi
    echo "    ${actual}"

    mkdir -p "${WORK_DIR}/zxing"
    for entry in "${ZXING_FILES[@]}"; do
        read -r member name expected <<< "${entry}"
        # Read out by name rather than unpacked, so nothing else in the tarball
        # is ever written anywhere.
        python3 - "${tarball}" "${member}" "${WORK_DIR}/zxing/${name}" <<'EXTRACT'
import shutil, sys, tarfile

with tarfile.open(sys.argv[1]) as tf:
    member = tf.getmember(sys.argv[2])
    if not member.isfile():
        sys.exit(f"{sys.argv[2]} is not a regular file in the tarball")
    with tf.extractfile(member) as src, open(sys.argv[3], "wb") as dst:
        shutil.copyfileobj(src, dst)
EXTRACT
        actual="$(sha256_of "${WORK_DIR}/zxing/${name}")"
        [ "${actual}" = "${expected}" ] || die "the verified zxing-wasm tarball holds a ${name} with sha256 ${actual}, but this script pins ${expected}"
    done

    mkdir -p "${ZXING_DIR}"
    for entry in "${ZXING_FILES[@]}"; do
        read -r member name expected <<< "${entry}"
        mv -- "${WORK_DIR}/zxing/${name}" "${ZXING_DIR}/${name}"
    done
    echo "    installed into ${ZXING_DIR}"
}

step "verifying zxing-wasm ${ZXING_VERSION} in ${ZXING_DIR}"
if [ "${MODE}" != "force" ] && zxing_installed; then
    echo "    zxing-wasm ${ZXING_VERSION}: both files present and matching"
elif [ "${MODE}" = "check" ]; then
    die "zxing-wasm in ${ZXING_DIR} does not verify; run without --check to fetch it"
else
    fetch_zxing
fi

# ---------------------------------------------------------------------------
# Is the runtime already here and correct?
# ---------------------------------------------------------------------------
#
# The lock file is the index of everything else, so it is the thing to check
# first. If it is present and correct, every other file can be checked against
# the hashes inside it without going near the network.

LOCK_FILE="${DEST_DIR}/pyodide-lock.json"

# verify_installed  ->  0 if everything in DEST_DIR is present and hashes
# correctly, 1 otherwise. Prints what is wrong either way.
verify_installed() {
    [ -f "${LOCK_FILE}" ] || { echo "    no pyodide-lock.json in ${DEST_DIR}"; return 1; }

    local version
    version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["info"]["version"])' "${LOCK_FILE}" 2>/dev/null || true)"
    if [ "${version}" != "${PYODIDE_VERSION}" ]; then
        echo "    ${DEST_DIR} holds Pyodide ${version:-unknown}, this repo pins ${PYODIDE_VERSION}"
        return 1
    fi

    local ok=0
    local name expected actual
    while read -r name expected; do
        [ -n "${name}" ] || continue
        if [ ! -f "${DEST_DIR}/${name}" ]; then
            echo "    missing  ${name}"
            ok=1
            continue
        fi
        actual="$(sha256_of "${DEST_DIR}/${name}")"
        if [ "${actual}" != "${expected}" ]; then
            echo "    CHANGED  ${name}"
            ok=1
        fi
    done < <(lock_closure "${LOCK_FILE}")

    # The runtime files themselves are not in the lock file, so check they are
    # simply present; the tarball hash is what vouches for their contents.
    local runtime_file
    for runtime_file in pyodide.js pyodide.mjs pyodide.asm.js pyodide.asm.wasm python_stdlib.zip; do
        if [ ! -f "${DEST_DIR}/${runtime_file}" ]; then
            echo "    missing  ${runtime_file}"
            ok=1
        fi
    done

    return "${ok}"
}

# lock_closure LOCKFILE
#
# Prints "file_name<space>sha256" for every package the firmware needs: the ones
# named in PYODIDE_PACKAGES plus everything they depend on, transitively.
# Resolved from the lock file rather than hardcoded, because the dependency
# edges are Pyodide's to decide and they change between releases.
lock_closure() {
    python3 - "$1" "${PYODIDE_PACKAGES[@]}" <<'PY'
import json, sys

lock = json.load(open(sys.argv[1]))
packages = lock["packages"]

# Pyodide's package keys are normalised (lowercase); "Pillow" is keyed "pillow".
by_name = {key.lower(): key for key in packages}

wanted, seen = list(sys.argv[2:]), set()
while wanted:
    name = wanted.pop()
    key = by_name.get(name.lower())
    if key is None:
        sys.exit(f"pyodide-lock.json has no package named {name!r}")
    if key in seen:
        continue
    seen.add(key)
    wanted.extend(packages[key].get("depends", []))

for key in sorted(seen):
    entry = packages[key]
    print(entry["file_name"], entry["sha256"])
PY
}

if [ "${MODE}" != "force" ] && [ -f "${LOCK_FILE}" ]; then
    step "verifying the Pyodide runtime already in ${DEST_DIR}"
    if verify_installed; then
        echo "    Pyodide ${PYODIDE_VERSION}: all files present and matching"
        step "nothing to do"
        exit 0
    fi
    [ "${MODE}" != "check" ] || die "the runtime in ${DEST_DIR} does not verify; run without --check to re-fetch"
    step "re-fetching"
fi

if [ "${MODE}" = "check" ]; then
    die "nothing installed in ${DEST_DIR} to check; run without --check to fetch it"
fi

# ---------------------------------------------------------------------------
# Fetch
# ---------------------------------------------------------------------------

TARBALL="${WORK_DIR}/pyodide-core-${PYODIDE_VERSION}.tar.bz2"

step "downloading ${PYODIDE_CORE_URL}"
download "${PYODIDE_CORE_URL}" "${TARBALL}"

step "verifying sha256"
ACTUAL_SHA256="$(sha256_of "${TARBALL}")"
if [ "${ACTUAL_SHA256}" != "${PYODIDE_CORE_SHA256}" ]; then
    # Deliberately fatal, and deliberately before anything is unpacked. A
    # runtime that is not the one this repo pins is not a runtime to run a
    # Bitcoin signer in, whatever the reason for the difference.
    die "sha256 mismatch on the Pyodide runtime -- REFUSING TO UNPACK
  url      ${PYODIDE_CORE_URL}
  expected ${PYODIDE_CORE_SHA256}
  got      ${ACTUAL_SHA256}"
fi
echo "    ${ACTUAL_SHA256}"

step "unpacking"
UNPACKED="${WORK_DIR}/unpacked"
mkdir -p "${UNPACKED}"
python3 - "${TARBALL}" "${UNPACKED}" <<'PY'
import sys, tarfile

with tarfile.open(sys.argv[1]) as tf:
    # The data filter refuses absolute paths, .. escapes, symlinks pointing out
    # of the tree, device nodes and setuid bits.
    tf.extractall(sys.argv[2], filter="data")
PY

[ -f "${UNPACKED}/pyodide/pyodide-lock.json" ] || die "the tarball did not contain pyodide/pyodide-lock.json"

# The hash already proves this is the file we meant, so this is a guard against
# the pin itself being wrong -- a URL and a hash that agree with each other but
# name a different release than PYODIDE_VERSION claims.
UNPACKED_VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["info"]["version"])' "${UNPACKED}/pyodide/pyodide-lock.json")"
if [ "${UNPACKED_VERSION}" != "${PYODIDE_VERSION}" ]; then
    die "the verified tarball says it is Pyodide ${UNPACKED_VERSION}, but this script pins ${PYODIDE_VERSION}"
fi

mkdir -p "${DEST_DIR}"
for asset in "${UNPACKED}"/pyodide/*; do
    cp -- "${asset}" "${DEST_DIR}/"
done
step "installed the runtime into ${DEST_DIR}"

# ---------------------------------------------------------------------------
# The compiled packages the firmware loads at runtime
# ---------------------------------------------------------------------------
#
# These stay out of the firmware zip: they are compiled extensions built for
# emscripten, so they can only come from Pyodide, and the worker asks for them
# by name with loadPackage() once the interpreter is up.

step "fetching the packages the firmware loads at boot (${PYODIDE_PACKAGES[*]}) and their dependencies"

# Resolved into a variable first, deliberately. Feeding the loop from a process
# substitution would discard this command's exit status -- set -e and pipefail
# both ignore it -- so a lock file that failed to resolve would leave the loop
# with nothing to do and the script would go on to report success having
# verified nothing.
package_closure="$(lock_closure "${DEST_DIR}/pyodide-lock.json")"
[ -n "${package_closure}" ] || die "resolved no packages from pyodide-lock.json"

while read -r file_name expected; do
    [ -n "${file_name}" ] || continue

    target="${DEST_DIR}/${file_name}"
    if [ -f "${target}" ] && [ "$(sha256_of "${target}")" = "${expected}" ]; then
        echo "    ok        ${file_name}"
        continue
    fi

    download "${PYODIDE_CDN}/${file_name}" "${WORK_DIR}/${file_name}"

    actual="$(sha256_of "${WORK_DIR}/${file_name}")"
    if [ "${actual}" != "${expected}" ]; then
        die "sha256 mismatch on ${file_name} -- REFUSING TO INSTALL IT
  url      ${PYODIDE_CDN}/${file_name}
  expected ${expected}   (from the verified pyodide-lock.json)
  got      ${actual}"
    fi

    mv -- "${WORK_DIR}/${file_name}" "${target}"
    echo "    fetched   ${file_name}"
done <<< "${package_closure}"

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

step "done"
echo
echo "  Pyodide ${PYODIDE_VERSION} in ${DEST_DIR}"
echo "  core tarball sha256 ${PYODIDE_CORE_SHA256}"
echo

# Printed rather than parsed and enforced: this script does not own
# worker.js, and a check that breaks when someone reformats JavaScript
# would be worse than useless. Read the line; it should ask for exactly the
# packages named in PYODIDE_PACKAGES above.
WORKER="${REPO_ROOT}/src/web/worker.js"
if [ -f "${WORKER}" ]; then
    echo "  This script fetched: ${PYODIDE_PACKAGES[*]}"
    echo "  ${WORKER##*/} asks for:"
    grep -n "loadPackage" "${WORKER}" | sed 's/^/    /' || true
fi
