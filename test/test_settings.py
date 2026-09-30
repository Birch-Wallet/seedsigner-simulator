"""
Change a setting through the firmware's own menus and see that it takes.

This exists because it once did not, and nothing noticed: every settings
change died on a System Error screen, the network selector among them, which is
the first thing anyone testing against a test network has to touch.

The firmware's settings live in an in-memory filesystem, and with Persistent
Settings off, as a fresh browser has it, nothing here survives a reload. That is
the point: this asks whether the change works at all, not whether it persists.
Persisting is test_persistent_settings.py's.

It also checks the network indicator under the device and the two halves of the
warning above it, and this is the file to check them in: neither is worth
anything unless it follows a change made through the firmware's own menus, which is
what the route below is.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness
from harness import check, report

from playwright.sync_api import sync_playwright

# Home is a two by two grid, Scan and Seeds above Tools and Settings, so down
# then right is Settings whichever tile the firmware starts on.
TO_SETTINGS = ("ArrowDown", "ArrowRight", "Enter")

# Settings, then three down past Language, Persistent settings and Denomination
# to Advanced, then the first entry inside it, which is the Bitcoin network.
# Chosen deliberately over the first setting in the list: this one has options
# the device is not already on, so accepting one is a real change, and it is the
# setting anybody pointing the simulator at a test network has to reach.
TO_NETWORK = ("ArrowDown",) * 3 + ("Enter", "Enter")

# The selection screen opens on the current value, which is Testnet, and Mainnet
# is the entry above it. Deliberately that way round: mainnet is the answer the
# page has to shout about, and the only way to it is the device's own menu.
TO_MAINNET = ("ArrowUp", "Enter")


# The sentence that is up on either network. A seed you rely on is the same seed
# whichever network the device is set to, and typing it here compromises its
# mainnet keys either way, so this half is not a mainnet sentence.
ALWAYS = "Never enter a real seed phrase"

# What mainnet adds, and only mainnet: no secure element under keys that are now
# the real ones.
ONLY_ON_MAINNET = (
    ". On Mainnet this page holds the real mainnet keys for whatever you give it, "
    "with no secure element under them: treat anything typed in as public."
)


def warning(page):
    """What the warning says, and whether its mainnet half is showing.

    Without the pull request's sentence a pull-request build adds: that one is
    test_build_info.py's and test_firmware_choice.py's to check, and this file
    asks the same question of every firmware."""
    said = page.locator("#warning").inner_text()
    if page.locator("#warning-pr").is_visible():
        said = said.replace(page.locator("#warning-pr").inner_text(), "")
    return (said, page.locator("#warning-mainnet").is_visible())


def indicator(page):
    """What the page says the network is, and whether it is saying it loudly.

    The loud half is a class on the body rather than on the indicator, because
    mainnet changes more than one thing: the warning gets heavier and the
    invitation to our own test network is taken away.

    The label itself is one word in the corner of the shell, and CSS sets it in
    capitals; the whole phrase lives on its title, which is what is compared
    here so the assertion reads like the sentence a visitor would say. Both come
    off the same event from the firmware, so neither can be right on its own.
    """
    label = page.locator("#network")
    assert label.inner_text().strip().lower() in label.get_attribute("title").lower()
    return (label.get_attribute("title"),
            page.evaluate("document.body.classList.contains('mainnet')"))


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        log = harness.Log(page)
        page.goto(harness.sim_url())
        log.wait("MainMenuScreen", 240, "the firmware to boot")

        # SeedSigner's own default is Mainnet. This one comes up on Testnet
        # because settings.json says so before the firmware reads it, which is
        # configuration and not a patch, and it is the whole reason a visitor
        # can be pointed at a test network without being told to go and change
        # something first. Read off the page, which was told by the firmware.
        check("a fresh page comes up on Testnet",
              indicator(page) == ("Bitcoin network: Testnet", False),
              str(indicator(page)))
        page.locator("#about > summary").click()
        about = page.locator("#about > div").inner_text()
        check("About opens, and names no outside origin the page talks to",
              page.locator("#about > div").is_visible()
              and "signet" not in about.lower() and "origin is mine" not in about.lower(),
              about[:200])
        page.locator("#about > summary").click()
        said, mainnet_half = warning(page)
        check("the warning is the short one on Testnet",
              page.locator("#warning").is_visible()
              and page.locator("#warning > strong").is_visible()
              and said == ALWAYS and not mainnet_half,
              said)
        page.screenshot(path=harness.artifact("network-testnet.png"), full_page=True)

        for key in TO_SETTINGS:
            page.keyboard.press(key)
            page.wait_for_timeout(400)
        check("the settings menu opens", log.last_screen() == "ButtonListScreen",
              log.last_screen())

        since = log.mark()
        for key in TO_NETWORK:
            page.keyboard.press(key)
            page.wait_for_timeout(700)
        check("the network setting opens for editing",
              log.last_screen() == "SettingsEntryUpdateSelectionScreen",
              log.last_screen())

        # Testnet to Mainnet, which is a real change, so the view calls
        # set_value, and the firmware has to come back from writing it.
        changed = log.mark()
        for key in TO_MAINNET:
            page.keyboard.press(key)
            page.wait_for_timeout(900)

        # The entry screen stays open with the new value marked, rather than
        # popping back to the list, so "still here and not an error screen" is
        # what accepting the change looks like.
        check("the change is accepted rather than raising",
              log.last_screen() == "SettingsEntryUpdateSelectionScreen",
              log.last_screen())
        check("no error screen", not log.seen("SystemError|Traceback", since=since),
              "the settings write raised")
        # And the firmware came back from it, which it did not until the locks
        # were made reentrant. Running the debounced write inline runs it inside
        # the lock save() holds while scheduling it, and one thread taking a
        # plain Lock twice waits for itself forever: the value was stored, the
        # screen stayed up looking correct, and nothing ever drew again.
        check("and the firmware came back from it rather than wedging",
              log.seen(r"display\(\) enter", since=changed) is not None,
              "nothing drew after the settings write")

        # The indicator is fed by the worker reading Settings back after the
        # firmware writes them, so this is the firmware's new value arriving rather
        # than the page guessing what the keypresses above meant.
        check("the network indicator follows the firmware, loudly",
              indicator(page) == ("Bitcoin network: Mainnet", True),
              str(indicator(page)))
        # The short half stays: what changed is that the page now holds real
        # mainnet keys, not whether a seed you rely on may be typed into it.
        said, mainnet_half = warning(page)
        check("the warning keeps its short half and adds the mainnet one",
              page.locator("#warning > strong").is_visible()
              and mainnet_half and said == ALWAYS + ONLY_ON_MAINNET,
              said)
        page.screenshot(path=harness.artifact("network-mainnet.png"), full_page=True)

        harness.save_screen(page, harness.artifact("settings-changed.png"))
        browser.close()

    return report()


if __name__ == "__main__":
    sys.exit(main())
