"""
Recording: the Rec button hands back an MP4, framed as asked.

Two framings on each of the two devices, and the device framing on both
backgrounds. The screen alone has to come out at exactly twice the firmware's
own size, 640x480 or 480x480: the smallest size at which H.264, which keeps
colour at half resolution in 2x2 blocks, gives every LCD pixel a block of its
own. A device recording has to put the LCD on the same grid -- a whole, even
scale, starting on an even column and row. The whole
device has to come out centred, with the same padding on every side of the
shell -- a little of it, not the art's own uneven room for a drop shadow -- and
rounded up to even, because H.264 will not take an odd size. Sizes are read out
of the file itself -- the ftyp brand, and the width and height the track header
declares -- and the shell's own size out of a second device the test draws, not
out of anything the recorder says about its frame.

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
firmware and so has to ask first, in the device panel itself.
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


def choose(page, mode, background):
    """Pick the framing and background in the bar's recording panel."""
    page.locator("#ctl-settings").click()
    page.locator(f"#rec-mode button[data-mode={mode}]").click()
    check(f"{mode}: the choice is kept in the URL", f"record={mode}" in page.url, page.url)
    light = page.locator("#rec-bg button[data-bg=light]")
    if mode == "screen":
        check("screen: the background choice is off, since there is none",
              light.is_disabled())
    else:
        page.locator(f"#rec-bg button[data-bg={background}]").click()
        check(f"device {background}: the background is kept in the URL",
              f"recbg={background}" in page.url, page.url)
    page.locator("#ctl-settings").click()   # and closed again


def record(page, mode, display, background="dark"):
    choose(page, mode, background)
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
    path = harness.artifact(f"record-{display}-{mode}-{background}.mp4")
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
    check(f"{display}: the device panel marks it as the one running",
          page.locator(f"#device-panel .pick[data-display='{display}']")
              .get_attribute("aria-current") == "true")

    # The shell's own size, from a second device drawn here for the purpose.
    probe = f"""SeedSignerDevice.render(document.createElement('div'),
        {{ screenWidth: {wanted[0]}, screenHeight: {wanted[1]} }})"""
    body = page.evaluate(f"() => {probe}.bodyRect")
    # Pixel perfect: in a device recording each LCD pixel is a whole, even
    # square of video pixels starting on an even row and column, which is what
    # lines it up with H.264's 2x2 colour blocks.
    lcd = page.evaluate(f"""() => {{
      const shell = {probe}, size = SimRecorder.frameSize(shell), r = shell.screenRect;
      return {{ x: size.x + r.x, y: size.y + r.y, w: r.width, h: r.height }};
    }}""")
    scale = lcd["w"] / wanted[0]
    check(f"{display}: a device recording scales the LCD by a whole, even factor",
          scale == int(scale) and scale % 2 == 0 and lcd["h"] == wanted[1] * scale,
          f"{lcd['w']}x{lcd['h']} for {display}")
    check(f"{display}: and puts it on an even column and row",
          lcd["x"] % 2 == 0 and lcd["y"] % 2 == 0, f"at {lcd['x']},{lcd['y']}")
    # Whether the page should have offered it: asked at the size it films at.
    can = page.evaluate(f"""() => {{
      const size = SimRecorder.frameSize({probe});
      return SimRecorder.supported(size.width, size.height);
    }}""")
    page.wait_for_timeout(500)
    offered = page.locator("#rec-go").is_visible()
    if not can:
        check(f"{display}: without an H.264 encoder, recording is not offered", not offered)
        page.close()
        return False
    check(f"{display}: recording is offered once the firmware is up", offered)

    for mode, background in (("screen", "dark"), ("device", "dark"), ("device", "light")):
        tag = f"{display} {mode}" + (f" {background}" if mode == "device" else "")
        name, data, elapsed = record(page, mode, display, background)
        brand, size, duration = describe(data)
        check(f"{tag}: the download is an .mp4 named for its framing",
              name.startswith(f"seedsigner-{mode}-") and name.endswith(".mp4"), name)
        check(f"{tag}: the file is an MP4", brand is not None, repr(data[:12]))
        if mode == "screen":
            # Two video pixels to an LCD pixel each way: the smallest size at
            # which H.264's half-resolution colour cannot smear one into the next.
            film = (wanted[0] * 2, wanted[1] * 2)
            check(f"{tag}: the video is {film[0]}x{film[1]}", size == film, str(size))
        elif size:
            across = size[0] - body["width"]
            down = size[1] - body["height"]
            check(f"{tag}: the shell has the same padding across as down",
                  abs(across - down) <= 1, f"{size}: {across:.0f} across, {down:.0f} down")
            share = down / 2 / body["height"]
            check(f"{tag}: and a little of it, not the art's room for a shadow",
                  0.04 <= share <= 0.12, f"{share:.1%} of the shell's height each side")
            check(f"{tag}: at an even size", size[0] % 2 == 0 and size[1] % 2 == 0, str(size))
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
    """The other device is a restart, so it is asked for first, in the panel,
    and the answer counts: Cancel keeps this session, Switch reloads at the
    other size and keeps the rest of the URL."""
    before = page.url
    page.locator("#ctl-device").click()
    page.locator("#device-panel .pick[data-display='320x240']").click()
    check("choosing the other device asks first",
          page.locator("#device-confirm").is_visible())
    page.locator("#device-cancel").click()
    page.wait_for_timeout(300)
    check("cancelling keeps the session", page.url == before
          and not page.locator("#device-confirm").is_visible(), page.url)

    page.locator("#device-panel .pick[data-display='320x240']").click()
    with page.expect_navigation():
        page.locator("#device-switch").click()
    check("switching reloads at 320x240, keeping ?debug",
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
