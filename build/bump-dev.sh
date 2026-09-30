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
# The steps are shared with build/pr.sh, in build/pin-lib.sh.
#
# Requires what build/build-firmware-zip.sh requires.

set -euo pipefail

PIN_TOOL="bump-dev"
# shellcheck source=pin-lib.sh
. "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/pin-lib.sh"
SECTION="dev"

FORCE="no"
case "${1:-}" in
    "")         ;;
    --force)    FORCE="yes" ;;
    -h|--help)  sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)          echo "unknown option: $1" >&2; exit 2 ;;
esac

REPO="$(pin_field "${SECTION}" repo)"
BRANCH="$(pin_field "${SECTION}" branch)"
CURRENT="$(pin_field "${SECTION}" commit)"
[ -n "${REPO}" ] && [ -n "${BRANCH}" ] && [ -n "${CURRENT}" ] \
    || pin_die "UPSTREAM [${SECTION}] needs repo, branch and commit"

# --- 1. the tip ---------------------------------------------------------------

pin_step "tip of ${BRANCH} at ${REPO}"
TIP="$(GIT_TERMINAL_PROMPT=0 git ls-remote "${REPO}" "refs/heads/${BRANCH}" | cut -f1)"
[ -n "${TIP}" ] || pin_die "could not resolve ${BRANCH} at ${REPO}"
echo "    pinned  ${CURRENT}"
echo "    tip     ${TIP}"

if [ "${TIP}" = "${CURRENT}" ] && [ "${FORCE}" = "no" ]; then
    echo "The pin is already the tip. Nothing to do (--force rebuilds anyway)."
    exit 0
fi

# --- 2. its dependencies against the table ------------------------------------

pin_step "checking ${BRANCH}'s requirements.txt against the dev dependency table"
pin_check_requirements "$(pin_raw_url "${REPO}" "${TIP}" requirements.txt)" dev

# --- 3. move the pin, build, publish ------------------------------------------

pin_step "pinning [${SECTION}] to ${TIP}"
pin_set_field "${SECTION}" commit "${TIP}"
pin_build_publish "${SECTION}"

echo
echo "UPSTREAM [${SECTION}] is now ${TIP}."
echo
echo "Next: run the suite against it (SIM_FIRMWARE=dev python3 test/run.py), check"
echo "./build/update-checksums.sh --check, and commit UPSTREAM together with any"
echo "change to the dev dependency table."
