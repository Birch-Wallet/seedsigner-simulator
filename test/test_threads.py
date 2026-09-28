"""
The firmware's animation threads, running, and the firmware still answering.

SeedSigner draws everything that moves from a background thread, and for a long
time this port had none: no spinner, no pulsing warning, the QR display and the
camera preview each pumped by hand. browser_threads.py runs those threads as
green threads now. What is checked here is what a visitor would see:

- **The camera preview** is SeedSigner's own LivePreviewThread, and keeps up.
- **A warning pulses** with nobody touching anything: two captures of the
  canvas half a second apart are different pictures.
- **An animated QR advances by itself** on a screen that is only waiting for
  a key, and Down and Up make its background darker and brighter.
- **The spinner** is started as a green thread when the xpub is derived.
- **Every key press is answered promptly** while all of that runs: a thread
  taking its turns must never keep the firmware from the lock it needs to draw
  the next screen.

Timings come from inside the page -- when each painted frame arrived -- rather
than from this process's polling of the log, which only looks every quarter of
a second.
"""

import os
import re
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness
from harness import Log, check, report, press
from test_mainnet import wait_screen

from playwright.sync_api import sync_playwright

REEL = harness.artifact("threads-camera.y4m")
SEED_REEL = harness.artifact("qr.y4m")

# Timestamps for every frame painted and every line the worker logged, taken
# on the page as they arrive. paint() and console.log are looked up by name when
# the worker's messages come in, so wrapping them here sees every one.
WATCH = """
() => {
  window.__frames = [];
  window.__lines = [];
  const paint = window.paint;
  window.paint = (bytes) => { window.__frames.push(performance.now()); return paint(bytes); };
  const log = console.log;
  console.log = (...args) => {
    window.__lines.push([performance.now(), String(args[0])]);
    return log.apply(console, args);
  };
}
"""


def line_time(page, pattern, after=0.0):
    """When the first log line matching `pattern` arrived, after `after`."""
    return page.evaluate("""([pattern, after]) => {
      const re = new RegExp(pattern);
      const hit = window.__lines.find(([t, text]) => t > after && re.test(text));
      return hit ? hit[0] : null;
    }""", [pattern, after])


def frames_between(page, start, end):
    return page.evaluate("([a, b]) => window.__frames.filter(t => t > a && t < b).length",
                         [start, end])


def backdrop(page):
    """The grey behind a QR on screen: the commonest colour that is not black."""
    return page.evaluate("""() => {
      const c = document.getElementById('screen');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const counts = {};
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 0) continue;
        if (d[i] !== d[i + 1] || d[i] !== d[i + 2]) continue;
        counts[d[i]] = (counts[d[i]] || 0) + 1;
      }
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      return top ? Number(top[0]) : null;
    }""")


def capture(page):
    return page.evaluate("() => document.getElementById('screen').toDataURL('image/png')")


# How long each press took to reach the screen, in seconds, for the check that
# the firmware kept answering.
ANSWERS = []

# Generous: a press is normally on screen within a frame or two. What this is
# here to catch is a press that never is, or only after an animation lets go.
PROMPT_S = 1.5


def step(page, log, key):
    """Press a key, wait until the firmware has taken it and is waiting for the
    next one, and note how long the press took to show on screen.

    Taken first, then waiting: the log reaches this process asynchronously, so a
    "waiting for a key" line from the press before can still be arriving after
    this one is made, and would otherwise pass for its answer."""
    mark = log.mark()
    pressed = page.evaluate("() => performance.now()")
    page.keyboard.press(key)
    log.wait(r"key index=\d+ .*accepted=True", 60, f"the firmware to take {key}", mark)
    taken = next(i for i in range(mark, len(log.lines))
                 if re.search(r"key index=\d+ .*accepted=True", log.lines[i]))
    log.wait(r"wait_for keys=", 60, f"the firmware to answer {key}", taken + 1)
    try:
        page.wait_for_function("(t) => window.__frames.some((f) => f > t)", arg=pressed,
                               timeout=PROMPT_S * 2000)
    except Exception:
        pass
    shown = first_frame_after(page, pressed)
    ANSWERS.append((key, None if shown is None else (shown - pressed) / 1000))


def to_seed_options(page, log):
    """Scan the published seed and stop on its options menu."""
    window = log.mark()
    press(page, "Enter")            # Scan
    window = wait_screen(log, "SeedFinalizeScreen", window, "the scanned seed", timeout=240)
    step(page, log, "Enter")        # Done
    return wait_screen(log, "SeedOptionsScreen", window, "the seed's own menu")


def to_privacy_warning(page, log, window):
    """Export Xpub, single sig, native segwit, animated QR, up to the warning."""
    step(page, log, "ArrowDown")    # [Export xpub]
    step(page, log, "Enter")
    window = wait_screen(log, "ButtonListScreen", window, "the sig type list")
    step(page, log, "Enter")        # Single Sig
    window = wait_screen(log, "ButtonListScreen", window, "the script type list")
    step(page, log, "Enter")        # Native Segwit
    window = wait_screen(log, "ButtonListScreen", window, "the QR format list")
    step(page, log, "Enter")        # Animated, the default
    return wait_screen(log, "WarningScreen", window, "the privacy warning")


def first_frame_after(page, after):
    return page.evaluate("(a) => window.__frames.find(t => t > a) ?? null", after)


def session(p):
    shutil.copyfile(SEED_REEL, REEL)
    browser = p.chromium.launch(args=[
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        f"--use-file-for-fake-video-capture={REEL}",
    ])
    context = browser.new_context(permissions=["camera"], viewport={"width": 900, "height": 900})
    page = context.new_page()
    log = Log(page)
    page.goto(harness.sim_url())
    page.evaluate(WATCH)
    log.wait(r"display\(\) enter: MainMenuScreen", 300, "the firmware to boot")
    return browser, page, log


def main() -> int:
    if not os.path.exists(SEED_REEL):
        print(f"no {SEED_REEL}: run make_qr_y4m.py first", file=sys.stderr)
        return 2

    with sync_playwright() as p:
        browser, page, log = session(p)

        window = to_seed_options(page, log)
        opened = line_time(page, r"display\(\) enter: ScanScreen")
        closed = line_time(page, r"display\(\) exit: ScanScreen", opened or 0)
        check("the camera preview is SeedSigner's own thread",
              log.seen(r"thread start: LivePreviewThread kind=green") is not None)
        if opened and closed and closed - opened > 500:
            rate = frames_between(page, opened, closed) / ((closed - opened) / 1000)
            check("and it keeps up, at better than 6 frames a second", rate >= 6,
                  f"{rate:.1f} fps over {(closed - opened) / 1000:.1f}s")

        window = to_privacy_warning(page, log, window)
        page.wait_for_timeout(300)
        before = capture(page)
        page.wait_for_timeout(500)
        check("a warning pulses with nobody touching anything", capture(page) != before)
        check("from its own WarningEdgesThread",
              log.seen(r"thread start: WarningEdgesThread kind=green") is not None)

        step(page, log, "Enter")        # I understand
        window = wait_screen(log, "SeedExportXpubDetailsScreen", window,
                             "the key to be derived", timeout=120)
        check("the spinner runs as a green thread while the key is derived",
              log.seen(r"thread start: LoadingScreenThread kind=green") is not None)

        press(page, "Enter")            # Export as QR
        wait_screen(log, "QRDisplayScreen", window, "the animated xpub QR")
        page.wait_for_timeout(600)
        first = capture(page)
        page.wait_for_timeout(700)
        check("an animated QR advances by itself on a screen waiting for a key",
              capture(page) != first)
        check("drawn by SeedSigner's own QRDisplayThread",
              log.seen(r"thread start: QRDisplayThread kind=green") is not None)
        page.wait_for_timeout(1600)     # past the screen's deaf moment

        # Down and Up set the code's background darker and brighter. The
        # brightness reaches the image through qr.py's qrencode call, so this
        # is also the check that the qrencode stand-in honours --background.
        start = backdrop(page)
        press(page, "ArrowDown")
        page.wait_for_timeout(1600)     # past the brightness tip
        darker = backdrop(page)
        check("Down makes the code's background darker",
              darker is not None and start is not None and darker < start,
              f"{start} -> {darker}")
        press(page, "ArrowUp")
        page.wait_for_timeout(1600)
        check("and Up brings it back", backdrop(page) == start, f"{darker} -> {backdrop(page)}")

        window = log.mark()
        press(page, "Enter")
        page.wait_for_timeout(1500)
        check("and every thread ends when its screen closes",
              log.seen(r"thread end: QRDisplayThread", window) is not None)
        check("no thread failed to be rewritten",
              log.seen(r"green: cannot rewrite|green thread \w+ failed") is None,
              str(log.seen(r"green: cannot rewrite|green thread \w+ failed")))
        check("nothing raised", log.seen(r"RAISED|PAGEERROR|Traceback") is None,
              str(log.seen(r"RAISED|PAGEERROR|Traceback")))
        slow = [(k, t) for k, t in ANSWERS if t is None or t > PROMPT_S]
        check(f"every press was on screen within {PROMPT_S}s",
              ANSWERS and not slow,
              ", ".join(f"{k} {'never' if t is None else f'{t:.2f}s'}" for k, t in slow)
              or f"slowest {max(t for _, t in ANSWERS):.2f}s of {len(ANSWERS)}")
        browser.close()

    return report()


if __name__ == "__main__":
    sys.exit(main())
