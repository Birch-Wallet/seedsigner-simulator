"""
Persistent Settings, kept by this browser the way a device keeps them on its
microSD card.

Off SeedSigner OS the firmware writes its settings to a settings.json it can
always reach, and deletes the file when Persistent Settings is turned off. In
the simulator that file lives in memory, so the page keeps a copy: whatever the
firmware last saved, while the setting is on, and nothing once it is off.

Driven entirely through the firmware's own menus. What is checked:

  - with the setting on, a change survives a reload, and the page's storage
    holds the firmware's own file;
  - the panel the URL asks for and a network the URL names still win over what
    was saved, so a saved Plus layout cannot turn up on the hat and a link that
    says testnet means testnet;
  - turning the setting off erases the saved copy, and the next reload is back
    on the defaults.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness
from harness import check, report

from playwright.sync_api import sync_playwright

KEY = "seedsigner-sim:settings"

# Home is a two by two grid, Scan and Seeds above Tools and Settings, so down
# then right is Settings whichever tile the firmware starts on.
TO_SETTINGS = ("ArrowDown", "ArrowRight", "Enter")
# Language, then Persistent settings.
TO_PERSISTENT = ("ArrowDown", "Enter")
# Past Persistent settings and Denomination to Advanced, then its first entry,
# the Bitcoin network (see test_settings.py).
TO_NETWORK = ("ArrowDown",) * 3 + ("Enter", "Enter")
# The two-option selection screens open on the current value: Enabled is above
# Disabled, Mainnet above Testnet.
UP_AND_TAKE = ("ArrowUp", "Enter")
DOWN_AND_TAKE = ("ArrowDown", "Enter")


def keys(page, sequence, gap=700):
    for key in sequence:
        page.keyboard.press(key)
        page.wait_for_timeout(gap)


def boot(page, **params):
    log = harness.Log(page)
    page.goto(harness.sim_url(**params))
    log.wait("MainMenuScreen", 240, "the firmware to boot")
    page.wait_for_timeout(500)
    return log


def saved(page):
    text = page.evaluate(f"() => localStorage.getItem({json.dumps(KEY)})")
    return json.loads(text) if text else None


def network(page):
    return page.locator("#network").get_attribute("title")


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context()
        page = context.new_page()

        log = boot(page)
        check("a fresh browser has nothing saved", saved(page) is None, str(saved(page)))

        # --- on ------------------------------------------------------------
        keys(page, TO_SETTINGS + TO_PERSISTENT)
        check("the Persistent Settings entry opens",
              log.last_screen() == "SettingsEntryUpdateSelectionScreen", log.last_screen())
        keys(page, UP_AND_TAKE, gap=1200)
        kept = saved(page)
        check("turning it on saves the firmware's settings in this browser",
              kept is not None and kept.get("persistent_settings") == "E",
              str(kept)[:200])

        page.reload()
        log = boot(page)
        keys(page, TO_SETTINGS + TO_NETWORK)
        keys(page, UP_AND_TAKE, gap=1200)
        check("a change made with it on is saved as it is made",
              (saved(page) or {}).get("network") == "M", str(saved(page))[:200])
        check("no error screen on the way",
              not log.seen("SystemError|Traceback|UnhandledException"), "")

        # --- a reload keeps it -----------------------------------------------
        page.reload()
        log = boot(page)
        check("after a reload the saved network is back",
              network(page) == "Bitcoin network: Mainnet", network(page))

        # --- the URL still wins ----------------------------------------------
        page.goto(harness.sim_url(network="testnet"))
        log = harness.Log(page)
        log.wait("MainMenuScreen", 240, "the firmware to boot")
        page.wait_for_timeout(500)
        check("a network the URL names wins over the saved one",
              network(page) == "Bitcoin network: Testnet", network(page))

        page.goto(harness.sim_url(display="240x240"))
        log = harness.Log(page)
        log.wait("MainMenuScreen", 240, "the firmware to boot")
        page.wait_for_timeout(500)
        size = page.evaluate(
            "() => [document.getElementById('screen').width, document.getElementById('screen').height]")
        check("the panel the URL asks for wins over the saved one", size == [240, 240], str(size))
        check("and the settings came along with it",
              network(page) == "Bitcoin network: Mainnet", network(page))

        # --- off erases it ---------------------------------------------------
        page.goto(harness.sim_url())
        log = boot(page)
        keys(page, TO_SETTINGS + TO_PERSISTENT)
        keys(page, DOWN_AND_TAKE, gap=1200)
        check("turning it off erases the saved copy", saved(page) is None, str(saved(page))[:200])

        page.reload()
        log = boot(page)
        check("and the next reload is back on the defaults",
              network(page) == "Bitcoin network: Testnet" and saved(page) is None,
              f"{network(page)}, saved {saved(page)}")
        check("no error screen anywhere",
              not log.seen("SystemError|Traceback|UnhandledException"), "")

        browser.close()

    return report()


if __name__ == "__main__":
    sys.exit(main())
