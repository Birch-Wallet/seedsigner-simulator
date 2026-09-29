"""
The two firmwares, and the page's choice between them.

stock is a SeedSigner release and the default; dev is one commit of SeedSigner's
development branch, pinned in its own section of UPSTREAM. Each is its own zip.
The device panel offers both, labelled from their build-info, and switching is a
reload with ?firmware, the way switching device is a reload with ?display.

What is checked:

  - a plain URL runs the release: the page fetches seedsigner-stock.zip, and the
    panel marks it as the one running;
  - the panel labels the release by its tag and dev by its branch and short
    commit, which is what each UPSTREAM section pins;
  - choosing dev asks first, then reloads with ?firmware=dev, fetches
    seedsigner-dev.zip, and boots it;
  - dev knows which build it is: its version helper, which off a device finds
    nothing to read, is handed the branch and commit, and its own Version
    screen comes up without error.

Needs both zips built: ./build/build-firmware-zip.sh and ./build/build-firmware-zip.sh dev.
"""

import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness
from harness import check, report

from playwright.sync_api import sync_playwright

# Settings, then down past everything to the last entry, which on dev is
# Version: a list stops at its end, so extra presses land there.
TO_SETTINGS = ("ArrowDown", "ArrowRight", "Enter")
TO_LAST = ("ArrowDown",) * 16 + ("Enter",)


def upstream_field(section, key):
    current = None
    with open(os.path.join(harness.REPO, "UPSTREAM"), encoding="utf-8") as handle:
        for line in handle:
            if line.startswith("["):
                current = line.strip().strip("[]")
            elif current == section and "=" in line and not line.startswith("#"):
                name, value = line.split("=", 1)
                if name.strip() == key:
                    return value.strip()
    return None


def keys(page, sequence, gap=500):
    for key in sequence:
        page.keyboard.press(key)
        page.wait_for_timeout(gap)


def main() -> int:
    if not (harness.find_asset("seedsigner-stock.zip") and harness.find_asset("seedsigner-dev.zip")):
        check("both firmware zips are built", False,
              "run ./build/build-firmware-zip.sh and ./build/build-firmware-zip.sh dev")
        return report()

    dev_commit = upstream_field("dev", "commit")
    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context(viewport={"width": 1100, "height": 900})
        # The firmware zips the page fetched. A set, because the service worker
        # passes each request on and it is seen twice.
        zips = set()
        context.on("request", lambda r: r.url.rsplit("/", 1)[-1].startswith("seedsigner-")
                   and r.url.endswith(".zip") and zips.add(r.url.rsplit("/", 1)[-1]))
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        # --- a plain URL is the release --------------------------------------
        log = harness.Log(page)
        page.goto(harness.sim_url(firmware="stock"))
        log.wait("MainMenuScreen", 240, "the release to boot")
        check("a plain URL runs the release", zips == {"seedsigner-stock.zip"}, str(zips))

        page.locator("#ctl-device").click()
        stock_pick = page.locator('#device-panel .pick[data-firmware="stock"]')
        dev_pick = page.locator('#device-panel .pick[data-firmware="dev"]')
        page.wait_for_function(
            "() => !document.querySelector('#device-panel .pick[data-firmware=\"dev\"]').hidden")
        check("the panel marks the release as the one running",
              stock_pick.get_attribute("aria-current") == "true"
              and dev_pick.get_attribute("aria-current") == "false")
        check("and labels it by its tag",
              page.locator("#firmware-label-stock").inner_text() == upstream_field("stock", "tag"),
              page.locator("#firmware-label-stock").inner_text())
        check("and offers dev, labelled by branch and commit",
              dev_pick.is_visible()
              and page.locator("#firmware-label-dev").inner_text() == "dev-" + dev_commit[:7],
              page.locator("#firmware-label-dev").inner_text())

        # --- switching asks, then reloads onto dev ---------------------------
        dev_pick.click()
        check("choosing dev asks before restarting the firmware",
              page.locator("#device-confirm").is_visible())
        zips.clear()
        page.locator("#device-switch").click()
        page.wait_for_url("**firmware=dev**")
        log = harness.Log(page)
        log.wait("MainMenuScreen", 240, "dev to boot")
        check("and runs dev from its own zip", zips == {"seedsigner-dev.zip"}, str(zips))
        with open(harness.find_asset("seedsigner-dev.build-info.json"), encoding="utf-8") as handle:
            committed = datetime.datetime.fromtimestamp(
                json.load(handle)["upstream"]["commit_time"], datetime.timezone.utc)
        check("which knows its branch, commit and commit date",
              log.seen(rf"firmware version: dev {dev_commit[:7]} "
                       + committed.strftime("%Y-%m-%d %H:%M:%S")) is not None,
              "; ".join(line for line in log.lines if "firmware version" in line))

        keys(page, TO_SETTINGS + TO_LAST, gap=400)
        page.wait_for_timeout(800)
        check("its Version screen comes up",
              log.last_screen() == "VersionScreen", log.last_screen())
        harness.save_screen(page, harness.artifact("firmware-dev-version.png"))

        check("nothing raised",
              not log.seen(r"View\.run RAISED|UnhandledException|Traceback"),
              " | ".join(line for line in log.lines
                         if "RAISED" in line or "Error" in line)[:600])
        check("no page errors", not errors, "; ".join(errors[:3]))
        browser.close()

    return report()


if __name__ == "__main__":
    sys.exit(main())
