"""
The firmwares on offer, and the page's choice between them.

stock is a SeedSigner release and the default; dev is one commit of SeedSigner's
development branch; each pr-<N> is the pinned head of one SeedSigner pull
request. Each is its own zip, pinned in its own section of UPSTREAM, and the
page offers what firmwares.json lists: grouped, labelled from the index, with a
filter once the list is long. Switching is a reload with ?firmware, the way
switching device is a reload with ?display.

What is checked:

  - a plain URL runs the release: the page fetches seedsigner-stock.zip, and the
    panel marks it as the one running;
  - the panel lists every firmware the index names, under its group, the
    release by its tag, dev by branch and short commit, a pull request by its
    number and title;
  - the filter keeps the release and dev and narrows the pull requests;
  - choosing dev asks first, reloads with ?firmware=dev, boots it from its own
    zip, and dev names its branch, commit and commit date on its own Version
    screen;
  - choosing a pull request, when one is built, boots it from its zip, names
    it on the Version screen, and puts the pull request's half of the warning up.

Needs the zips built: ./build/build-firmware-zip.sh <name> for each, and at
least stock and dev.
"""

import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness
from harness import check, report

from playwright.sync_api import sync_playwright

# Settings, then down past everything to the last entry, which on dev and newer
# is Version: a list stops at its end, so extra presses land there.
TO_SETTINGS = ("ArrowDown", "ArrowRight", "Enter")
TO_LAST = ("ArrowDown",) * 16 + ("Enter",)
GROUPS = {"release": "Release", "dev": "Development branch", "pr": "Pull requests, unreviewed"}


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


def build_info(name):
    with open(harness.find_asset(f"seedsigner-{name}.build-info.json"), encoding="utf-8") as handle:
        return json.load(handle)


def keys(page, sequence, gap=500):
    for key in sequence:
        page.keyboard.press(key)
        page.wait_for_timeout(gap)


def open_panel(page):
    if not page.locator("#device-panel").is_visible():
        page.locator("#ctl-device").click()
    page.wait_for_selector("#firmware-list .pick")


def switch_to(page, name):
    """Choose a firmware in the device panel and confirm the restart. Returns
    whether the panel asked first."""
    open_panel(page)
    page.locator(f'#firmware-list .pick[data-firmware="{name}"]').click()
    asked = page.locator("#device-confirm").is_visible()
    page.locator("#device-switch").click()
    page.wait_for_url(f"**firmware={name}**")
    return asked


def boots_as(page, name, zips):
    """After a switch, the firmware boots from its own zip and names itself."""
    log = harness.Log(page)
    log.wait("MainMenuScreen", 240, f"{name} to boot")
    check(f"[{name}] runs from its own zip", zips == {f"seedsigner-{name}.zip"}, str(zips))
    info = build_info(name)
    commit = info["upstream"]["commit"]
    committed = datetime.datetime.fromtimestamp(info["upstream"]["commit_time"],
                                                datetime.timezone.utc)
    version = f"pr-{info['pr']['number']}" if info.get("pr") else info["upstream"].get("branch")
    check(f"[{name}] names its version, commit and commit date",
          log.seen(rf"firmware version: {version} {commit[:7]} "
                   + committed.strftime("%Y-%m-%d %H:%M:%S")) is not None,
          "; ".join(line for line in log.lines if "firmware version" in line))
    keys(page, TO_SETTINGS + TO_LAST, gap=400)
    page.wait_for_timeout(800)
    check(f"[{name}] its Version screen comes up", log.last_screen() == "VersionScreen",
          log.last_screen())
    harness.save_screen(page, harness.artifact(f"firmware-{name}-version.png"))
    check(f"[{name}] nothing raised",
          not log.seen(r"View\.run RAISED|UnhandledException|Traceback"),
          " | ".join(line for line in log.lines if "RAISED" in line)[:400])


def main() -> int:
    index_path = harness.find_asset("firmwares.json")
    if not (index_path and harness.find_asset("seedsigner-stock.zip")
            and harness.find_asset("seedsigner-dev.zip")):
        check("the firmwares are built", False,
              "run ./build/build-firmware-zip.sh for stock, dev and any pr-<N>")
        return report()
    with open(index_path, encoding="utf-8") as handle:
        index = json.load(handle)["firmwares"]
    prs = [entry for entry in index if entry["kind"] == "pr"]

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

        # --- the list is the index -------------------------------------------
        open_panel(page)
        offered = page.eval_on_selector_all("#firmware-list .pick",
                                            "ps => ps.map(p => p.dataset.firmware)")
        check("the panel offers every firmware the index lists, in its order",
              offered == [entry["name"] for entry in index], f"{offered}")
        headings = page.eval_on_selector_all("#firmware-list .pop-title",
                                             "hs => hs.map(h => h.textContent)")
        check("under their groups",
              headings == list(dict.fromkeys(GROUPS[e["kind"]] for e in index)), str(headings))
        stock_pick = page.locator('#firmware-list .pick[data-firmware="stock"]')
        check("the release is marked as the one running",
              stock_pick.get_attribute("aria-current") == "true")
        check("and labelled by its tag",
              upstream_field("stock", "tag") in stock_pick.inner_text(), stock_pick.inner_text())
        dev_pick = page.locator('#firmware-list .pick[data-firmware="dev"]')
        check("dev is labelled by branch and commit",
              "dev-" + upstream_field("dev", "commit")[:7] in dev_pick.inner_text(),
              dev_pick.inner_text())
        for entry in prs:
            text = page.locator(f'#firmware-list .pick[data-firmware="{entry["name"]}"]').inner_text()
            check(f"#{entry['pr']} is offered by number and title",
                  f"#{entry['pr']}" in text and entry["title"][:20] in text, text)

        # The filter: shown once the list is long, but it works either way.
        if prs:
            needle = str(prs[0]["pr"])
            visible = page.evaluate("""(needle) => {
              const box = document.getElementById('firmware-filter');
              box.value = needle;
              box.dispatchEvent(new Event('input'));
              return [...document.querySelectorAll('#firmware-list .pick')]
                .filter(p => !p.hidden).map(p => p.dataset.firmware);
            }""", needle)
            expected = ["stock", "dev"] + [e["name"] for e in prs
                                           if needle in f"#{e['pr']} {e['title']}".lower()]
            check("the filter keeps the release and dev and narrows the pull requests",
                  visible == expected, f"{visible}, wanted {expected}")
            page.evaluate("""() => { const box = document.getElementById('firmware-filter');
                                     box.value = ''; box.dispatchEvent(new Event('input')); }""")
        check("the filter box appears only once the list is long",
              page.locator("#firmware-filter").is_hidden() == (len(index) <= 8))

        # --- dev --------------------------------------------------------------
        zips.clear()
        check("choosing another firmware asks before restarting it", switch_to(page, "dev"))
        boots_as(page, "dev", zips)

        # --- a pull request ----------------------------------------------------
        if prs:
            name = prs[0]["name"]
            page.goto(harness.sim_url(firmware="dev"))
            harness.Log(page).wait("MainMenuScreen", 240, "dev to boot again")
            zips.clear()
            switch_to(page, name)
            boots_as(page, name, zips)
            check(f"[{name}] the warning says it is an unreviewed pull request",
                  f"pull request #{prs[0]['pr']}" in page.locator("#warning").inner_text(),
                  page.locator("#warning").inner_text())
        else:
            print("  (no pull request is built, so none is switched to)")

        check("no page errors", not errors, "; ".join(errors[:3]))
        browser.close()

    return report()


if __name__ == "__main__":
    sys.exit(main())
