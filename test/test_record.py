"""
Recording: the Rec button hands back an MP4, framed as asked.

Two framings, one file each, on each of the two devices. The screen alone has
to come out at exactly the firmware's own size, 320x240 or 240x240, because that
is the point of asking for it; the whole device has to come out at the shell's
own size, rounded up to even, because H.264 will not take an odd one. Both are read out of the file itself -- the ftyp brand, and
the width and height the track header declares -- rather than out of anything
the page says about it.

The length is checked too, loosely: the recording is timestamped as frames
happen rather than on a fixed clock, and a file that came out a tenth as long as
the session, or with no frames after the first, would be the way that goes
wrong.

What the file cannot show here is the absence of the pointer. That holds by
construction -- every frame is composed from the firmware's canvas and a
snapshot of the drawn shell, and nothing is captured off the page -- so the
mouse is left hovering over a key throughout, and a snapshot with a hover glow
in it would be a bug in seedsigner-device.js the eye would catch in the video.

A Chromium built without an H.264 encoder cannot make either file. There the
check is that the button is never offered, and the file checks are reported as
skipped rather than failed.

The 240x240 pass ends on the switch between devices, which restarts the
firmware and so has to ask first.
"""

import os
import struct
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness
from harness import check, report

from playwright.sync_api import sync_playwright

RECORD_SECONDS = 4


def boxes(data, start=0, end=None):
    """The ISO BMFF boxes in data[start:end], as (type, body start, body end)."""
    end = len(data) if end is None else end
    at = start
    while at + 8 <= end:
        size, kind = struct.unpack(">I4s", data[at:at + 8])
        head = 8
        if size == 1:
            size = struct.unpack(">Q", data[at + 8:at + 16])[0]
            head = 16
        elif size == 0:
            size = end - at
        yield kind.decode("latin-1"), at + head, at + size
        at += size


def find(data, path, start=0, end=None):
    """The body of the first box down `path`, e.g. ["moov", "trak", "tkhd"]."""
    for kind, body, stop in boxes(data, start, end):
        if kind == path[0]:
            return (body, stop) if len(path) == 1 else find(data, path[1:], body, stop)
    return None


def describe(data):
    """Brand, track size and duration in seconds, read out of the file."""
    brand = data[8:12].decode("latin-1") if data[4:8] == b"ftyp" else None
    size = duration = None
    tkhd = find(data, ["moov", "trak", "tkhd"])
    if tkhd:
        # The last eight bytes of a track header are width and height, 16.16.
        w, h = struct.unpack(">II", data[tkhd[1] - 8:tkhd[1]])
        size = (w >> 16, h >> 16)
    mvhd = find(data, ["moov", "mvhd"])
    if mvhd:
        body = mvhd[0]
        if data[body] == 1:
            scale, length = struct.unpack(">IQ", data[body + 20:body + 32])
        else:
            scale, length = struct.unpack(">II", data[body + 12:body + 20])
        duration = length / scale if scale else None
    return brand, size, duration


def record(page, mode, display):
    page.locator(f"#rec-mode button[data-mode={mode}]").click()
    check(f"{mode}: the choice is kept in the URL", f"record={mode}" in page.url, page.url)
    # Left over a key the whole time: a pointer the video must not show.
    box = page.locator("#device [data-ssd-control=key1]").bounding_box()
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)

    page.locator("#rec-go").click()
    page.wait_for_function(
        "document.getElementById('rec-go').getAttribute('aria-pressed') === 'true'"
        " && !document.getElementById('rec-go').disabled", timeout=30000)
    began = time.time()
    check(f"{mode}: the framing cannot be changed mid-recording",
          page.locator("#rec-mode button").first.is_disabled())
    harness.press(page, "ArrowDown", 2)
    harness.press(page, "ArrowUp", 2)
    page.wait_for_timeout(max(0, RECORD_SECONDS - (time.time() - began)) * 1000)

    with page.expect_download(timeout=30000) as waiting:
        page.locator("#rec-go").click()
    elapsed = time.time() - began
    download = waiting.value
    path = harness.artifact(f"record-{display}-{mode}.mp4")
    download.save_as(path)
    with open(path, "rb") as handle:
        data = handle.read()
    return download.suggested_filename, data, elapsed


def session(browser, display):
    """Both recordings on one device. False when this browser cannot encode."""
    page = browser.new_page(viewport={"width": 1200, "height": 900}, accept_downloads=True)
    log = harness.Log(page)
    page.goto(harness.sim_url(display=display))
    log.wait("MainMenuScreen", 240, f"the firmware to boot at {display}")
    screen = tuple(page.evaluate(
        "() => [document.getElementById('screen').width, document.getElementById('screen').height]"))
    wanted = tuple(int(v) for v in display.split("x"))
    check(f"{display}: the firmware draws a {display} screen", screen == wanted, str(screen))
    check(f"{display}: the device switch says so",
          page.locator(f"#display-size button[data-display='{display}']")
              .get_attribute("aria-pressed") == "true")

    shell = page.evaluate(
        "() => [document.querySelector('#device .ssd-svg').viewBox.baseVal.width,"
        "       document.querySelector('#device .ssd-svg').viewBox.baseVal.height]")
    can = page.evaluate(f"() => SimRecorder.supported({shell[0]}, {shell[1]})")
    page.wait_for_timeout(500)
    offered = page.locator("#rec").is_visible()
    if not can:
        check(f"{display}: without an H.264 encoder, recording is not offered", not offered)
        page.close()
        return False
    check(f"{display}: recording is offered once the firmware is up", offered)

    even = lambda v: int(-(-round(v, 2) // 2) * 2)
    want = {"screen": wanted, "device": (even(shell[0]), even(shell[1]))}
    for mode in ("screen", "device"):
        tag = f"{display} {mode}"
        name, data, elapsed = record(page, mode, display)
        brand, size, duration = describe(data)
        check(f"{tag}: the download is an .mp4 named for its framing",
              name.startswith(f"seedsigner-{mode}-") and name.endswith(".mp4"), name)
        check(f"{tag}: the file is an MP4", brand is not None, repr(data[:12]))
        check(f"{tag}: the video is {want[mode][0]}x{want[mode][1]}",
              size == want[mode], str(size))
        check(f"{tag}: it runs about as long as the recording did",
              duration is not None and abs(duration - elapsed) < 1.5,
              f"{duration}s of video for {elapsed:.1f}s recorded")
        check(f"{tag}: and the button is ready for another",
              page.locator("#rec-go").get_attribute("aria-pressed") == "false"
              and not page.locator("#rec-go").is_disabled())

    check(f"{display}: nothing on the page threw",
          not any(line.startswith("PAGEERROR") for line in log.lines),
          "; ".join(line for line in log.lines if line.startswith("PAGEERROR")))
    check(f"{display}: and no recording error was shown",
          page.locator("#record-hint").inner_text() == "",
          page.locator("#record-hint").inner_text())

    if display == "240x240":
        switch(page)
    page.close()
    return True


def switch(page):
    """The other device is a restart, so it is asked for first, and the answer
    counts: no keeps this session, yes reloads at the other size and keeps the
    rest of the URL."""
    before = page.url
    page.once("dialog", lambda dialog: dialog.dismiss())
    page.locator("#display-size button[data-display='320x240']").click()
    page.wait_for_timeout(500)
    check("declining the switch keeps the session", page.url == before, page.url)

    page.once("dialog", lambda dialog: dialog.accept())
    with page.expect_navigation():
        page.locator("#display-size button[data-display='320x240']").click()
    check("accepting it reloads at 320x240, keeping ?debug",
          "display=320x240" in page.url and "debug=1" in page.url, page.url)


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for display in ("320x240", "240x240"):
            if not session(browser, display):
                print(f"  skip the {display} MP4 checks: this Chromium has no H.264 encoder")
        browser.close()
    return report()


if __name__ == "__main__":
    sys.exit(main())
