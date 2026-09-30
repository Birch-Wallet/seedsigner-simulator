#!/usr/bin/env python3
"""
Write firmwares.json, the list of firmwares the page offers, into a build
output directory.

    python3 build/firmware-index.py build/out

Every firmware whose seedsigner-<name>.build-info.json is in the directory, in
the order the page shows them: the release, the development branch, then pull
requests, newest first. Written from the build-infos rather than from UPSTREAM,
so it lists exactly what has been built there and so will be served.
build/build-firmware-zip.sh runs it after every build, and build/pr.sh after
removing one.
"""
import glob, json, os, sys

out = sys.argv[1]
entries = []
for path in glob.glob(os.path.join(out, "seedsigner-*.build-info.json")):
    name = os.path.basename(path)[len("seedsigner-"):-len(".build-info.json")]
    with open(path, encoding="utf-8") as handle:
        info = json.load(handle)
    up, pr = info.get("upstream", {}), info.get("pr")
    commit = up.get("commit", "")
    if pr:
        kind, label = "pr", f"#{pr['number']}"
    elif up.get("branch"):
        kind, label = "dev", f"{up['branch']}-{commit[:7]}"
    else:
        kind, label = "release", up.get("tag", name)
    entry = {"name": name, "kind": kind, "label": label, "commit": commit}
    if pr:
        entry.update(pr=pr["number"], title=pr.get("title", ""), url=pr.get("url", ""))
    entries.append(entry)

rank = {"release": 0, "dev": 1, "pr": 2}
entries.sort(key=lambda e: (rank[e["kind"]], -e.get("pr", 0), e["name"]))
with open(os.path.join(out, "firmwares.json"), "w", encoding="utf-8") as handle:
    json.dump({"firmwares": entries}, handle, indent=2)
    handle.write("\n")
