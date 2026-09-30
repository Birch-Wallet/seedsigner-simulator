#!/usr/bin/env bash
#
# Pin SeedSigner pull requests as firmwares the simulator offers.
#
#   ./build/pr.sh add 995          pin PR 995's head as [pr-995], build it, publish
#   ./build/pr.sh update 995       move [pr-995] to the PR's current head
#   ./build/pr.sh update --all     the same, for every pinned PR
#   ./build/pr.sh remove 995       drop [pr-995] and its build outputs
#   ./build/pr.sh list             every pinned PR against its current state
#
# A pull request is somebody's proposed change to SeedSigner, not reviewed and
# not merged: the page lists it apart from the release and the development
# branch, and says so wherever it runs. Pinned the same way they are -- one
# commit, its zip rebuilt twice and its hashes published in UPSTREAM -- so what
# a visitor runs can be checked like anything else here, and it moves only when
# someone runs this and commits the result.
#
# The PR is read from GitHub's API: its head commit, its title, the branch it
# targets and whether it is still open. GitHub publishes every pull request's
# head on SeedSigner's own repository, so the commit is fetched from there
# whichever fork it came from. Set GITHUB_TOKEN to lift the API's rate limit for
# anonymous callers, which a handful of PRs never reaches.
#
# Adding or moving one checks the PR's requirements.txt against the dependency
# table of the branch it targets (dev) and stops if they differ, exactly as
# build/bump-dev.sh does for dev. The steps they share are in build/pin-lib.sh.

set -euo pipefail

PIN_TOOL="pr"
# shellcheck source=pin-lib.sh
. "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/pin-lib.sh"

REPO="https://github.com/SeedSigner/seedsigner.git"
API="https://api.github.com/repos/SeedSigner/seedsigner"
OUT_DIR="${PIN_REPO_ROOT}/build/out"

usage() { sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; }

# What GitHub says about PR NUMBER, as shell-safe lines: state, merged, head
# commit, base branch, title.
pr_info() {
    local number="$1" auth=()
    [ -z "${GITHUB_TOKEN:-}" ] || auth=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
    curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 \
        -H "Accept: application/vnd.github+json" ${auth[@]+"${auth[@]}"} \
        -- "${API}/pulls/${number}" \
        | python3 -c '
import json, sys
pr = json.load(sys.stdin)
title = " ".join(pr["title"].split())
print(pr["state"]); print("yes" if pr.get("merged") else "no")
print(pr["head"]["sha"]); print(pr["base"]["ref"]); print(title)
' || pin_die "could not read pull request ${number} from GitHub"
}

pinned_prs() {
    sed -n 's/^\[pr-\([0-9][0-9]*\)\]$/\1/p' "${UPSTREAM_FILE}"
}

number_of() {
    case "${1:-}" in
        ""|*[!0-9]*) pin_die "not a pull request number: ${1:-}" ;;
    esac
    echo "$1"
}

# Pin NUMBER at its current head: check it, write its section, build, publish.
pin_pr() {
    local number="$1" mode="$2" section="pr-$1"
    local state merged head base title
    pin_step "pull request #${number}"
    { read -r state; read -r merged; read -r head; read -r base; read -r title; } <<< "$(pr_info "${number}")"
    echo "    ${title}"
    echo "    ${state}, targets ${base}, head ${head}"

    if [ "${state}" != "open" ]; then
        [ "${merged}" = "yes" ] && state="merged"
        pin_die "#${number} is ${state}; there is nothing to test ahead of dev (./build/pr.sh remove ${number})"
    fi
    [ "${base}" = "dev" ] \
        || pin_die "#${number} targets ${base}, not dev, and there is no dependency table for ${base}"

    if [ "${mode}" = "update" ]; then
        local current
        current="$(pin_field "${section}" commit)"
        if [ "${current}" = "${head}" ]; then
            echo "    already pinned at its head; nothing to do"
            return 0
        fi
        echo "    pinned  ${current}"
    fi

    pin_step "checking #${number}'s requirements.txt against the dev dependency table"
    pin_check_requirements "$(pin_raw_url "${REPO}" "${head}" requirements.txt)" dev

    if [ "${mode}" = "add" ]; then
        # A new section at the end, with placeholder hashes the build replaces.
        {
            echo
            echo "# Pull request #${number}, proposed to SeedSigner and not yet merged."
            echo "# https://github.com/SeedSigner/seedsigner/pull/${number}"
            echo "[${section}]"
            echo "repo   = ${REPO}"
            echo "commit = ${head}"
            echo "pr     = ${number}"
            echo "title  = ${title}"
            echo "deps   = dev"
            echo
            echo "zip_sha256          = 0000000000000000000000000000000000000000000000000000000000000000"
            echo "zip_contents_sha256 = 0000000000000000000000000000000000000000000000000000000000000000"
        } >> "${UPSTREAM_FILE}"
    else
        pin_set_field "${section}" commit "${head}"
        pin_set_field "${section}" title "${title}"
    fi
    pin_build_publish "${section}"
    echo "    [${section}] is pinned at ${head}"
}

# Remove NUMBER's section, with the two comment lines this script wrote above
# it, and its build outputs, then rewrite the firmware list.
unpin_pr() {
    local number="$1"
    python3 - "${UPSTREAM_FILE}" "${number}" <<'PY'
import sys

path, number = sys.argv[1], sys.argv[2]
lines = open(path, encoding="utf-8").read().split("\n")
try:
    start = lines.index(f"[pr-{number}]")
except ValueError:
    sys.exit(f"no [pr-{number}] in {path}")
end = start + 1
while end < len(lines) and not lines[end].startswith("[") \
        and not lines[end].startswith("# Pull request #"):
    end += 1
while start > 0 and lines[start - 1].startswith("#") and (
        f"#{number}" in lines[start - 1] or f"/pull/{number}" in lines[start - 1]):
    start -= 1
kept = lines[:start] + lines[end:]
text = "\n".join(kept).rstrip("\n") + "\n"
open(path, "w", encoding="utf-8").write(text)
PY
    rm -f -- "${OUT_DIR}/seedsigner-pr-${number}.zip" \
             "${OUT_DIR}/seedsigner-pr-${number}.zip.manifest" \
             "${OUT_DIR}/seedsigner-pr-${number}.build-info.json"
    [ ! -d "${OUT_DIR}" ] || python3 "${PIN_REPO_ROOT}/build/firmware-index.py" "${OUT_DIR}"
    echo "    [pr-${number}] removed"
}

next_steps() {
    echo
    echo "Next: run the suite against each PR you touched, for example"
    echo "  SIM_FIRMWARE=pr-${1} python3 test/run.py build_info firmware_choice settings scan_seedqr"
    echo "then check ./build/update-checksums.sh --check and commit UPSTREAM."
}

command="${1:-}"
case "${command}" in
    add)
        number="$(number_of "${2:-}")"
        ! grep -qx "\\[pr-${number}\\]" "${UPSTREAM_FILE}" \
            || pin_die "#${number} is already pinned (./build/pr.sh update ${number})"
        pin_pr "${number}" add
        next_steps "${number}"
        ;;
    update)
        if [ "${2:-}" = "--all" ]; then
            numbers="$(pinned_prs)"
            [ -n "${numbers}" ] || { echo "No pull requests are pinned."; exit 0; }
            for number in ${numbers}; do pin_pr "${number}" update; done
            next_steps "<N>"
        else
            number="$(number_of "${2:-}")"
            grep -qx "\\[pr-${number}\\]" "${UPSTREAM_FILE}" \
                || pin_die "#${number} is not pinned (./build/pr.sh add ${number})"
            pin_pr "${number}" update
            next_steps "${number}"
        fi
        ;;
    remove)
        number="$(number_of "${2:-}")"
        pin_step "unpinning pull request #${number}"
        unpin_pr "${number}"
        echo
        echo "Commit UPSTREAM; the page stops offering it once build/out is redeployed."
        ;;
    list)
        numbers="$(pinned_prs)"
        [ -n "${numbers}" ] || { echo "No pull requests are pinned."; exit 0; }
        for number in ${numbers}; do
            pinned="$(pin_field "pr-${number}" commit)"
            { read -r state; read -r merged; read -r head; read -r base; read -r title; } <<< "$(pr_info "${number}")"
            [ "${merged}" = "yes" ] && state="merged"
            if [ "${state}" != "open" ]; then status="${state}: remove it"
            elif [ "${head}" = "${pinned}" ]; then status="pinned at its head"
            else status="head moved to ${head:0:7}: update it"
            fi
            printf '#%-6s %s  %-34s %s\n' "${number}" "${pinned:0:7}" "${status}" "${title}"
        done
        ;;
    -h|--help|"")
        usage
        ;;
    *)
        echo "unknown command: ${command}" >&2
        usage >&2
        exit 2
        ;;
esac
