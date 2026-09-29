"""
Every language upstream translates, through the firmware's own Language menu.

The translations are upstream's seedsigner-translations submodule, at the
commit upstream's tree pins, compiled into the zip as upstream compiles them.
The fonts a few scripts need -- Chinese, Japanese, Korean, Arabic, Thai -- are
served beside the zip instead, and the worker fetches each the first time the
firmware opens it, refusing any whose sha256 is not the one the zip names.

What is checked:

  - the Language menu offers the translations, which it only does when their
    .mo files are in the zip;
  - choosing Español changes what the firmware draws: the home screen is not the
    English one any more;
  - choosing 简体中文 does too, and the font it needs was fetched from the fonts
    directory and verified on the way in;
  - nothing raised.
"""

import base64
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness
from harness import check, report

from playwright.sync_api import sync_playwright

# Home is a two by two grid, Scan and Seeds above Tools and Settings, so down
# then right is Settings whichever tile the firmware starts on. Language is the
# first entry in Settings.
TO_LANGUAGE = ("ArrowDown", "ArrowRight", "Enter", "Enter")

# The list, in the firmware's own order (SettingsConstants.ALL_LOCALES):
# English first, then Català, Deutsch, Español, Français, Italiano, Nederlands,
# Čeština, 简体中文. It opens on the current language.
ENGLISH_TO_SPANISH = ("ArrowDown",) * 3 + ("Enter",)
SPANISH_TO_CHINESE = ("ArrowDown",) * 5 + ("Enter",)


def keys(page, sequence, gap=700):
    for key in sequence:
        page.keyboard.press(key)
        page.wait_for_timeout(gap)


def screen(page):
    data_url = page.evaluate("() => document.getElementById('screen').toDataURL('image/png')")
    return base64.b64decode(data_url.split(",", 1)[1])


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context()
        fonts_fetched = []
        context.on("request", lambda r: "/fonts-" in r.url and fonts_fetched.append(r.url))
        page = context.new_page()
        log = harness.Log(page)
        page.goto(harness.sim_url())
        log.wait("MainMenuScreen", 240, "the firmware to boot")
        page.wait_for_timeout(800)
        english = screen(page)

        keys(page, TO_LANGUAGE)
        check("the Language menu opens",
              log.last_screen() == "SettingsEntryUpdateSelectionScreen", log.last_screen())
        check("and offers the translations, not English alone",
              log.seen(r"font fetched: NotoSans") is not None or len(fonts_fetched) > 0,
              "no language needing its own font was drawn in the list")

        keys(page, ENGLISH_TO_SPANISH, gap=1000)
        harness.back_to_home(page, log)
        page.wait_for_timeout(800)
        spanish = screen(page)
        check("choosing Español changes what the firmware draws",
              spanish != english, "the home screen is still the English one")

        keys(page, TO_LANGUAGE)
        keys(page, SPANISH_TO_CHINESE, gap=1000)
        harness.back_to_home(page, log)
        page.wait_for_timeout(800)
        chinese = screen(page)
        check("choosing 简体中文 changes it again",
              chinese not in (english, spanish), "the home screen did not change")
        check("its font came from the fonts directory, verified",
              log.seen(r"font fetched: NotoSansSC-Regular\.ttf .*sha256 verified") is not None
              and any("NotoSansSC-Regular.ttf" in url for url in fonts_fetched),
              f"requests: {fonts_fetched}")
        harness.save_screen(page, harness.artifact("language-zh.png"))

        fetched = [line for line in log.lines if "font fetched:" in line]
        check("each font is fetched once, however often it is drawn",
              len(fetched) == len(set(fetched)), "\n".join(fetched))

        check("nothing raised",
              not log.seen(r"View\.run RAISED|UnhandledException|Traceback|PAGEERROR"),
              "; ".join(line for line in log.lines if "RAISED" in line or "Traceback" in line)[:300])

        browser.close()

    return report()


if __name__ == "__main__":
    sys.exit(main())
