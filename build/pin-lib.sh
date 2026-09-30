# Shared by build/bump-dev.sh and build/pr.sh: what moving a pin in UPSTREAM
# involves, whichever pin it is. Sourced, not run.
#
#   pin_field SECTION KEY              one value out of a section
#   pin_set_field SECTION KEY VALUE    rewrite one value in place
#   pin_check_requirements URL TABLE   a requirements.txt against a dependency
#                                      table in build/build-firmware-zip.sh
#   pin_build_publish SECTION          build it twice, require the two to agree,
#                                      and publish their hashes in the section
#
# Every function that can fail says why and exits; none of them leaves UPSTREAM
# half-written, because each writes only after the step that could fail.

PIN_REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM_FILE="${PIN_REPO_ROOT}/UPSTREAM"
BUILD="${PIN_REPO_ROOT}/build/build-firmware-zip.sh"
PIN_TOOL="${PIN_TOOL:-pin}"

pin_die() {
    echo "${PIN_TOOL}: $*" >&2
    exit 1
}

pin_step() {
    echo "==> $*"
}

# One key out of a section. The same section-aware reader the build uses.
pin_field() {
    awk -F= -v want="[$1]" -v key="$2" '
        /^\[/   { inside = ($0 == want); next }
        inside && $1 ~ "^[[:space:]]*" key "[[:space:]]*$" {
            gsub(/[[:space:]]/, "", $2); print $2
        }
    ' "${UPSTREAM_FILE}"
}

# Rewrite one key's value in a section, keeping its alignment and everything
# else in the file as it is. The value is written as given, so it may hold
# spaces (a pull request's title).
pin_set_field() {
    python3 - "${UPSTREAM_FILE}" "$1" "$2" "$3" <<'PY'
import re, sys

path, section, key, value = sys.argv[1:]
lines = open(path, encoding="utf-8").read().split("\n")
inside, done = False, False
for i, line in enumerate(lines):
    if line.startswith("["):
        inside = line.strip() == f"[{section}]"
    elif inside and re.match(rf"^{re.escape(key)}\s*=", line):
        prefix = re.match(rf"^{re.escape(key)}\s*=\s*", line).group(0)
        lines[i] = prefix + value
        done = True
if not done:
    sys.exit(f"no {key} in [{section}] of {path}")
open(path, "w", encoding="utf-8").write("\n".join(lines))
PY
}

# A requirements.txt, fetched from URL, against the dependency table named TABLE
# ("stock" or "dev") in the build script. Two entries never go in the zip, and
# are skipped: Pillow is Pyodide's own, and pyzbar is a stand-in in src/fakes.
# colorama is Windows-only. Anything else has to agree, version for version,
# and a PyPI row's sha256 has to be one the file lists. A mismatch is reported
# and stops everything: the table carries a hash for every artifact, and a new
# hash is something a person checks, not something a script copies.
pin_check_requirements() {
    local url="$1" table_name="$2" requirements table
    requirements="$(curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 \
        -- "${url}")" || pin_die "could not fetch ${url}"
    local upper
    upper="$(echo "${table_name}" | tr '[:lower:]' '[:upper:]')"
    table="$(sed -n "/^read -r -d '' DEPENDENCIES_${upper} <<'DEPS'/,/^DEPS\$/p" "${BUILD}" | sed '1d;$d')"
    [ -n "${table}" ] || pin_die "no DEPENDENCIES_${upper} table in ${BUILD}"

    REQUIREMENTS="${requirements}" TABLE="${table}" TABLE_NAME="${table_name}" python3 - <<'PY' || exit 1
import os, re, sys

NOT_IN_THE_ZIP = {"pillow", "pyzbar", "colorama"}

# One entry per logical line: continuations joined, comments dropped, then each
# entry read as `name==version` or `name @ url`, with every --hash it lists.
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
        wanted[name.lower()] = (commit.group(1) if commit else url, hashes)
    elif "==" in spec:
        name, version = (part.strip() for part in spec.split("==", 1))
        wanted[name.lower()] = (version, hashes)
    else:
        wanted[spec.lower()] = (spec, hashes)

table = {}
for row in os.environ["TABLE"].splitlines():
    if not row.strip():
        continue
    kind, module, dist, release, url, integrity, subpath = row.split("|")
    table[dist.lower()] = (kind, release, integrity)

problems = []
for name, (value, hashes) in sorted(wanted.items()):
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
    print(f"these dependencies do not match the {os.environ['TABLE_NAME']} table in "
          "build/build-firmware-zip.sh:", file=sys.stderr)
    for problem in problems:
        print(f"  {problem}", file=sys.stderr)
    print("Update the table -- artifact URL, sha256 and subpath, each checked by hand -- "
          "and run this again.", file=sys.stderr)
    sys.exit(1)
print(f"    they agree with the {os.environ['TABLE_NAME']} table")
PY
}

# The zip and contents hashes one build of SECTION prints, as "zip contents".
pin_build_hashes() {
    local section="$1"; shift
    local log
    log="$("${BUILD}" "${section}" "$@" 2>&1)" || { echo "${log}" >&2; pin_die "the build of ${section} failed"; }
    echo "${log}" | awk '/^    zip       sha256 / { zip = $3 } /^    contents  sha256 / { contents = $3 }
                         END { print zip, contents }'
}

# Build SECTION, build it again from nothing cached, require the two to agree,
# publish their hashes in the section, and build once more so the build-info
# beside the zip carries the hashes just published.
pin_build_publish() {
    local section="$1" zip1 contents1 zip2 contents2
    pin_step "building ${section}"
    read -r zip1 contents1 <<< "$(pin_build_hashes "${section}")"
    pin_step "building ${section} again, from nothing cached, to check it reproduces"
    read -r zip2 contents2 <<< "$(pin_build_hashes "${section}" --no-cache)"
    [ -n "${zip1}" ] && [ "${zip1}" = "${zip2}" ] && [ "${contents1}" = "${contents2}" ] \
        || pin_die "two builds of ${section} disagree (${zip1} / ${zip2}); not publishing either"

    pin_set_field "${section}" zip_sha256 "${zip1}"
    pin_set_field "${section}" zip_contents_sha256 "${contents1}"
    pin_build_hashes "${section}" >/dev/null

    echo "    zip       sha256 ${zip1}"
    echo "    contents  sha256 ${contents1}"
}

# Where to read a file of a GitHub repo at a commit, for the requirements check.
pin_raw_url() {
    local repo="$1" commit="$2" file="$3" slug
    case "${repo}" in
        https://github.com/*) ;;
        *) pin_die "only a GitHub repo can be read here: ${repo}" ;;
    esac
    slug="${repo#https://github.com/}"
    slug="${slug%.git}"
    echo "https://raw.githubusercontent.com/${slug}/${commit}/${file}"
}
