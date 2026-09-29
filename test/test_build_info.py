"""
The technical details panel, and the one check the page makes about itself.

The panel exists so that a visitor can see what is running without being asked
to take anybody's word for it: the firmware, the pin it was built from, the
published hashes, and the sha256 of the firmware zip the worker actually received.
That last one is the only line with any weight in it, so most of this file is
about it.

Every value the panel shows is checked against something that is not the panel's
own source, for each firmware that has been built: stock, the release, and dev,
the development-branch pin. The tag (or, for dev, the branch), the commit and
both hashes are read out of UPSTREAM here,
not out of build-info.json, because build-info.json is what feeds the panel and
comparing the two would only prove the page can echo a file back. And the
received hash is compared against sha256 of the zip on disk.

Then the part that makes the check a check: a deliberately altered zip is served
from a second server, and the panel has to say so. The panel says nothing when
the hashes match -- they are side by side for anyone to compare -- but a zip
that is not the published build has to go red. A self-check that cannot go red
is decoration.

Nothing here needs the firmware to finish booting, but the hash does not arrive
until the worker has loaded Pyodide and fetched the zip, so this is minutes
rather than seconds.
"""

import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness
from harness import check, report

from playwright.sync_api import sync_playwright

# Every section of UPSTREAM the page can run, which is also the name the build
# gives each zip. Each one built is checked; the suite's own firmware
# (SIM_FIRMWARE) is the one the altered-zip check tampers with.
FIRMWARES = ("stock", "dev")

# The zip has to arrive and be hashed, which happens after Pyodide and its
# binary packages have loaded. That is the whole cost of this file.
HASH_TIMEOUT = 180_000


def upstream_field(firmware, key, required=True):
    """One published value, straight out of UPSTREAM.

    Section-aware for the same reason every other reader of that file is: a key
    is only ever read from the section it belongs to.
    """
    section = None
    with open(os.path.join(harness.REPO, "UPSTREAM"), encoding="utf-8") as handle:
        for line in handle:
            if line.startswith("["):
                section = line.strip().strip("[]")
            elif section == firmware and "=" in line and not line.startswith("#"):
                name, value = line.split("=", 1)
                if name.strip() == key:
                    return value.strip()
    if not required:
        return None
    raise AssertionError(f"no {key!r} in the [{firmware}] section of UPSTREAM")


def pinned_pyodide():
    """The version build/fetch-assets.sh pins, which is where it is written."""
    with open(os.path.join(harness.REPO, "build", "fetch-assets.sh"), encoding="utf-8") as handle:
        found = re.search(r'^PYODIDE_VERSION="([^"]+)"', handle.read(), re.M)
    assert found, "no PYODIDE_VERSION in build/fetch-assets.sh"
    return found.group(1)


def open_panel(page, url):
    page.goto(url)
    # One panel now, behind the i: what the simulator is and what it was built
    # from are the same argument, and the half that makes the claim was not the
    # half that let you check it.
    page.wait_for_selector("#about > summary")
    page.locator("#about > summary").click()
    # Filled in from build-info.json, so waiting for the tag is waiting for that
    # fetch rather than for a fixed number of milliseconds.
    page.wait_for_function("document.getElementById('build-tag').textContent.trim() !== ''")


def text(page, selector):
    return page.locator(selector).inner_text().strip()


def describes(page, firmware):
    """The panel's account of a build, checked against UPSTREAM and the zip."""
    published = upstream_field(firmware, "zip_sha256")

    check(f"[{firmware}] the panel says which firmware is running",
          firmware in text(page, "#build-firmware"), text(page, "#build-firmware"))
    # A release is named by its tag; the dev pin by its branch, and the panel
    # says which it is showing.
    tag = upstream_field(firmware, "tag", required=False)
    name, label = (tag, "Tag") if tag else (upstream_field(firmware, "branch"), "Branch")
    check(f"[{firmware}] and the {label.lower()} UPSTREAM pins",
          text(page, "#build-tag") == name and text(page, "#build-tag-label") == label,
          f"{text(page, '#build-tag-label')}: {text(page, '#build-tag')}")
    check(f"[{firmware}] and the opening line says which it is",
          (name in text(page, "#firmware-line")) if tag
          else ("development branch" in text(page, "#firmware-line")
                and upstream_field(firmware, "commit")[:7] in text(page, "#firmware-line")),
          text(page, "#firmware-line"))
    check(f"[{firmware}] and the commit UPSTREAM pins",
          text(page, "#build-commit") == upstream_field(firmware, "commit"),
          text(page, "#build-commit"))
    commit_url = (re.sub(r"\.git$", "", upstream_field(firmware, "repo"))
                  + "/commit/" + upstream_field(firmware, "commit"))
    check(f"[{firmware}] and links the commit at the upstream repo",
          page.locator("#build-commit").get_attribute("href") == commit_url,
          page.locator("#build-commit").get_attribute("href"))
    check(f"[{firmware}] and the published zip sha256",
          text(page, "#build-published") == published, text(page, "#build-published"))
    check(f"[{firmware}] and the published contents sha256",
          text(page, "#build-contents")
          == upstream_field(firmware, "zip_contents_sha256"),
          text(page, "#build-contents"))
    check(f"[{firmware}] and the Pyodide the repo pins",
          text(page, "#build-pyodide") == pinned_pyodide(), text(page, "#build-pyodide"))

    # The translations are pinned by upstream's own tree, so the build writes the
    # commit it found there and the fonts it served; the panel shows that commit.
    info_path = harness.find_asset(f"seedsigner-{firmware}.build-info.json")
    with open(info_path, encoding="utf-8") as handle:
        info = json.load(handle)
    translations = info.get("translations") or {}
    check(f"[{firmware}] and the translations commit the build recorded",
          translations.get("commit") and text(page, "#build-translations") == translations["commit"],
          f"panel {text(page, '#build-translations')!r}, build-info {translations.get('commit')!r}")
    fonts = (translations.get("fonts") or {}).get("fonts") or {}
    check(f"[{firmware}] with the languages and the deferred fonts it compiled and served",
          len(translations.get("languages", [])) > 1 and fonts
          and all(len(digest) == 64 for digest in fonts.values()),
          f"{len(translations.get('languages', []))} languages, fonts {sorted(fonts)}")


def verdict(page, timeout=HASH_TIMEOUT):
    # Attached, not visible: the verdict is empty and hidden when the hashes match.
    page.wait_for_selector("#build-verdict:not([data-state=pending])", timeout=timeout,
                           state="attached")
    return (page.locator("#build-verdict").get_attribute("data-state"),
            text(page, "#build-computed"))


def sha256_of(path):
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def serve(root, port):
    """A second server, with ROOT overlaid in front of the usual ones."""
    server = subprocess.Popen(
        [sys.executable, os.path.join(harness.REPO, "test", "serve.py"),
         "--port", str(port), root] + [r for r in harness.WEB_ROOTS if os.path.isdir(r)])
    deadline = time.time() + 15
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), 0.5):
                return server
        except OSError:
            time.sleep(0.25)
    server.kill()
    raise AssertionError(f"the second server never came up on port {port}")


def altered(page):
    """Serve a zip that is not the published one, and require the panel to say so.

    The altered copy goes in a temporary directory served in front of the real
    one, so build/out is never touched: a test that corrupts a build output has
    to put it back, and one that fails halfway through does not.
    """
    firmware = harness.FIRMWARE
    original = harness.find_asset(f"seedsigner-{firmware}.zip")
    if not original:
        check("a built firmware zip to alter", False, f"no seedsigner-{firmware}.zip")
        return

    root = tempfile.mkdtemp(prefix="sim-altered-")
    fake = os.path.join(root, f"seedsigner-{firmware}.zip")
    shutil.copyfile(original, fake)
    with open(fake, "ab") as handle:
        handle.write(b"\n")  # one byte, which is all it should take

    server = serve(root, harness.PORT + 1)
    try:
        open_panel(page, f"http://127.0.0.1:{harness.PORT + 1}"
                         f"/index.html?debug=1&firmware={firmware}")
        state, computed = verdict(page)
        check("an altered zip is reported as altered", state == "differs", state)
        check("and the panel says so in words",
              "not the published build" in text(page, "#build-verdict"),
              text(page, "#build-verdict"))
        check("and what it shows is the hash of the bytes it was actually served",
              computed == sha256_of(fake) and computed != text(page, "#build-published"),
              computed)
        page.screenshot(path=harness.artifact("build-panel-altered.png"), full_page=True)
    finally:
        server.terminate()
        server.wait(timeout=10)
        shutil.rmtree(root, ignore_errors=True)


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context(viewport={"width": 900, "height": 1000})
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        built = [f for f in FIRMWARES if harness.find_asset(f"seedsigner-{f}.build-info.json")]
        check("the suite's own firmware is among those built",
              harness.FIRMWARE in built, f"built: {built}")
        for firmware in built:
            open_panel(page, harness.sim_url(firmware=firmware))
            describes(page, firmware)

            state, computed = verdict(page)
            check(f"[{firmware}] the zip the page received hashes to the published sha256",
                  state == "match", state)
            check(f"[{firmware}] and the panel adds nothing to say so",
                  text(page, "#build-verdict") == "", text(page, "#build-verdict"))
            check(f"[{firmware}] and that hash is the hash of the built zip",
                  computed == sha256_of(harness.find_asset(f"seedsigner-{firmware}.zip")),
                  computed)
            page.screenshot(path=harness.artifact(f"build-panel-{firmware}.png"),
                            full_page=True)

        altered(page)

        check("no page errors", not errors, "; ".join(errors[:3]))
        browser.close()

    return report()


if __name__ == "__main__":
    sys.exit(main())
