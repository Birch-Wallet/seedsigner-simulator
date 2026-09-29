"""
New seed from a photo, which is the camera's other half.

The hardware Camera has two modes and this port only ever replaced one of them.
The video stream is what a QR scan reads, and it was shimmed from the start; the
single-frame mode is what "new seed" uses to take one still, and it was not, so
it fell through to the real `from picamera import PiCamera` and the flow died on
`No module named 'picamera'` at camera.py line 63.

Driven to the picture and no further: what is being
asserted is that the camera opens, takes a frame and hands back an image, which
is the part that was raising.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness
from harness import Log, check, report

from playwright.sync_api import sync_playwright

SHOT = harness.artifact("image-entropy.png")

# Home -> Tools -> New seed (the camera one, first in the list).
TO_THE_CAMERA = ["ArrowDown", "Enter", "Enter"]


def press(page, key, gap=1000):
    page.keyboard.press(key)
    page.wait_for_timeout(gap)


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch(args=[
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
        ])
        context = browser.new_context(
            permissions=["camera"], viewport={"width": 1100, "height": 900})
        page = context.new_page()
        log = Log(page)

        page.goto(harness.sim_url())
        log.wait(r"display\(\) enter: MainMenuScreen", 240, "the firmware to boot")

        for key in TO_THE_CAMERA:
            press(page, key)
        log.wait(r"display\(\) enter: ToolsImageEntropyLivePreviewScreen", 90,
                 "the live preview")
        check("the camera opens for the preview", True)

        # The preview fills the screen. The firmware asks for a square as big as
        # the screen's longer side and crops its middle to the screen; handed a
        # smaller square it cropped a strip and drew it down the left, and the
        # rest of a 320x240 screen was not the camera at all. Chrome's fake
        # camera is one flat colour behind a turning shape, so the band across
        # the middle of the left third and of the right third should agree.
        page.wait_for_timeout(2000)
        thirds = page.evaluate("""() => {
          const canvas = document.getElementById('screen');
          const ctx = canvas.getContext('2d');
          const w = canvas.width, h = canvas.height, third = Math.floor(w / 3);
          const mean = (x0) => {
            const d = ctx.getImageData(x0, 30, third, 40).data, sum = [0, 0, 0];
            for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) sum[c] += d[i + c];
            return sum.map((v) => v / (d.length / 4));
          };
          return { w, h, left: mean(0), right: mean(w - third) };
        }""")
        apart = max(abs(a - b) for a, b in zip(thirds["left"], thirds["right"]))
        check("the preview fills the screen, not a strip down its left",
              thirds["w"] == 320 and apart < 24,
              f"{thirds['w']}x{thirds['h']}: left third "
              f"{[round(v) for v in thirds['left']]}, right third "
              f"{[round(v) for v in thirds['right']]}")

        # Select takes the picture, which is the call that used to raise. Newer
        # firmware first fills a pool of distinct preview frames and ignores
        # Select until it is full, as a person watching its progress bar would
        # wait; so Select is pressed again until the picture is taken.
        page.wait_for_timeout(2000)
        final = r"display\(\) enter: ToolsImageEntropyFinalImageScreen"
        for _ in range(10):
            press(page, "Enter", gap=3000)
            if log.seen(final):
                break
        log.wait(final, 90, "the picture it took")
        check("it takes a still and shows it back", True)

        harness.save_screen(page, SHOT)
        print(f"  screen: {SHOT}")

        # Named, not any ModuleNotFoundError: stock's controller imports numpy at
        # boot purely to time how long it takes, which fails here and is logged
        # and swallowed, and has nothing to do with the camera or with anything
        # this build uses -- the only numpy code in the tree is commented out.
        check("picamera is never reached",
              log.seen(r"No module named 'picamera") is None)
        check("and nothing raised on the way", log.seen(r"View\.run RAISED") is None)
        check("no System Error",
              log.seen(r"display\(\) enter: UnhandledException") is None)

        browser.close()

    return report()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except AssertionError as exc:
        print(f"FAILED: {exc}")
        sys.exit(1)
