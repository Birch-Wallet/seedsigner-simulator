"""
Drive the firmware through a scan with Chromium's fake camera.

getUserMedia needs a secure context, so this talks to loopback rather than the
machine's LAN address, and it feeds a file instead of a device so the run is
deterministic and needs no hardware.

The firmware already logs every screen it displays, so that log is the oracle:
reaching SeedFinalizeScreen means the QR was decoded, parsed as a SeedQR and
turned into a seed. The screenshot is taken there.

Screens rather than views, which is what this was written against. The view
trace is real now that it wraps Destination.run, but a scan is a screen-shaped
thing: what is being asserted is that the device drew SeedFinalizeScreen.

SCAN_DECODER says which decoder the page must pick.

  zxing-wasm  the default, in every browser. test_scan_native.py's stand-in
              BarcodeDetector is installed, the one that claims a QR on every
              frame and reads rubbish, so a page that consulted native at all
              would show it; this Chromium may or may not have a real one, and
              the run should not depend on which.
  jsQR        the last resort: a copy served without zxing-wasm, simulated by
              refusing every request for it, in a browser without
              BarcodeDetector -- Safari, or Chrome on Windows and Linux. The
              fallback in a browser with one is test_scan_native.py's.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness
from harness import Log, check, report

from playwright.sync_api import sync_playwright
from test_scan_native import STUB

# Which QR to hold up: qr.y4m is the digit-based SeedQR, qr-compact.y4m is the
# raw-bytes CompactSeedQR. Both encode the same seed, so both must land on the
# same fingerprint.
KIND = os.environ.get("QR_KIND", "qr")
DECODER = os.environ.get("SCAN_DECODER", "zxing-wasm")
# One file, one seed, held up to the firmware's camera.
Y4M = harness.artifact(f"{KIND}.y4m")
# The last-resort run is named apart, so it does not overwrite the zxing-wasm
# run of the same file.
NAME = KIND if DECODER == "zxing-wasm" else f"{KIND}-{DECODER.lower()}"
SHOT = harness.artifact(f"scan-proof-{NAME}.png")
PREVIEW_SHOT = harness.artifact(f"scan-preview-{NAME}.png")
# The device's screen on its own, which is what run.py's same_seed step compares
# across the scans. The screenshot beside it is for looking at.
SCREEN = harness.artifact(f"scan-screen-{NAME}.png")

NO_NATIVE = "delete window.BarcodeDetector;"


def main() -> int:
    if not os.path.exists(Y4M):
        print(f"no {Y4M}: run make_qr_y4m.py first", file=sys.stderr)
        return 2

    with sync_playwright() as p:
        browser = p.chromium.launch(args=[
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
            f"--use-file-for-fake-video-capture={Y4M}",
        ])
        context = browser.new_context(
            permissions=["camera"],
            viewport={"width": 900, "height": 900},
            # A request the service worker answers never reaches the route
            # below, and what is under test here is the page, not its cache.
            service_workers="block",
        )
        if DECODER == "jsQR":
            context.add_init_script(NO_NATIVE)
            context.route("**/zxing-*/**", lambda route: route.abort())
        else:
            context.add_init_script(STUB)
        page = context.new_page()
        log = Log(page)

        page.goto(harness.sim_url())

        log.wait(r"display\(\) enter: MainMenuScreen", 240, "the firmware to boot")
        check("the firmware boots to the main menu", True)

        # Scan is the first button on the home screen and starts selected.
        page.keyboard.press("Enter")

        log.wait(r"display\(\) enter: ScanScreen", 90, "the scan screen")
        check("Enter on the home screen opens the scanner", True)

        # Caught during the video's blank lead-in, so this is the live preview
        # with nothing to decode yet.
        decoder = log.wait(r"\[cam\] .*decoding with (\S+)", 60, "the camera to open")
        check(f"the camera opens and picks {DECODER}", decoder.group(1) == DECODER,
              decoder.group(1))
        page.wait_for_timeout(900)
        page.screenshot(path=PREVIEW_SHOT)

        # Nothing has been held up yet, so anything loaded at this point was
        # invented rather than read.
        check("nothing is decoded from the blank lead-in",
              log.seen(r"display\(\) enter: SeedFinalizeScreen") is None)

        line = log.wait(r"display\(\) enter: SeedFinalizeScreen", 180, "the decoded seed")
        check("the QR decodes into a seed", True, line.group(0))

        page.wait_for_timeout(1500)
        page.screenshot(path=SHOT)
        harness.save_screen(page, SCREEN)
        print(f"  screenshots: {PREVIEW_SHOT}\n               {SHOT}")
        print(f"  screen:      {SCREEN}")

        if DECODER != "jsQR":
            calls = page.evaluate("() => window.__detectCalls")
            check("BarcodeDetector is never consulted", calls == 0, f"{calls} detect() calls")

        log.dump("[cam]")
        browser.close()

    return report()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except AssertionError as exc:
        print(f"FAILED: {exc}")
        sys.exit(1)
