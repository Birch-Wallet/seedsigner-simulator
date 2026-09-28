#!/usr/bin/env python3
"""
Regenerate src/web/og-image.png, the 1200x630 preview a shared link shows.

Not part of any build and never run by one. The image is a committed file like
the icons: served as it stands, hashed in build/checksums.txt, and changed only
when a person means it to. Run this when something in the picture changes --
the device art, the firmware's home screen after an UPSTREAM bump, the wording
or the domain -- then look at the result, run ./build/update-checksums.sh, and
commit the image and the manifest together.

What it does: serves the simulator from this checkout, boots the firmware, and
takes the firmware's own 320x240 home screen off its canvas; then composes
build/og-image/og-image.html, which draws the device around that screen with the
site's own seedsigner-device.js, renders it at twice the size, and scales it
down for clean edges. The output is not byte-for-byte reproducible -- fonts and
Chromium versions differ between machines -- which is the other reason this is
a step a person takes rather than one a build does.

Needs what the tests need: `pip install playwright`, `playwright install
chromium`, the Pyodide runtime (build/fetch-assets.sh) and the firmware zip
(build/build-firmware-zip.sh).

    python3 build/make-og-image.py                 # writes src/web/og-image.png
    python3 build/make-og-image.py --out /tmp/og.png
"""

import argparse
import base64
import os
import socket
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "test"))
import harness  # noqa: E402 -- where the Pyodide runtime and the firmware zip live

from playwright.sync_api import sync_playwright  # noqa: E402

WIDTH, HEIGHT = 1200, 630
SCALE = 2
BOOT_TIMEOUT_S = 300


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def serve(port):
    """The simulator and the design page, from one origin, as the tests serve it."""
    roots = [os.path.join(ROOT, "build", "og-image")] + [
        r for r in harness.WEB_ROOTS if os.path.isdir(r)]
    server = subprocess.Popen(
        [sys.executable, os.path.join(ROOT, "test", "serve.py"), "--port", str(port)] + roots,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.time() + 15
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), 0.5):
                return server
        except OSError:
            time.sleep(0.2)
    server.kill()
    sys.exit(f"the server never came up on port {port}")


def home_screen(browser, base):
    """The firmware's home screen, as a data: URL off its own canvas."""
    page = browser.new_page()
    booted = []
    page.on("console", lambda m: "display() enter: MainMenuScreen" in m.text
            and booted.append(True))
    page.goto(f"{base}/index.html?debug=1")
    deadline = time.time() + BOOT_TIMEOUT_S
    while not booted:
        if time.time() > deadline:
            sys.exit("the firmware never reached its home screen")
        page.wait_for_timeout(250)
    page.wait_for_timeout(800)          # its first frame, painted
    screen = page.evaluate("() => document.getElementById('screen').toDataURL('image/png')")
    page.close()
    return screen


def compose(browser, base, screen):
    """The card, rendered at SCALE and scaled down to WIDTH x HEIGHT."""
    page = browser.new_page(viewport={"width": WIDTH, "height": HEIGHT},
                            device_scale_factor=SCALE)
    page.goto(f"{base}/og-image.html")
    page.evaluate("(screen) => window.compose(screen)", screen)
    page.wait_for_timeout(300)
    large = base64.b64encode(page.screenshot()).decode()
    small = page.evaluate("""async ([large, width, height]) => {
      const image = new Image();
      image.src = "data:image/png;base64," + large;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext("2d");
      context.imageSmoothingQuality = "high";
      context.drawImage(image, 0, 0, width, height);
      return canvas.toDataURL("image/png");
    }""", [large, WIDTH, HEIGHT])
    page.close()
    return base64.b64decode(small.split(",", 1)[1])


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--out", default=os.path.join(ROOT, "src", "web", "og-image.png"))
    args = parser.parse_args()

    for name in (harness.FIRMWARE_ZIP, os.path.join("pyodide-e24b45d3", "pyodide.js")):
        if not harness.find_asset(name):
            sys.exit(f"no {name}: run build/fetch-assets.sh and build/build-firmware-zip.sh first")

    port = free_port()
    server = serve(port)
    base = f"http://127.0.0.1:{port}"
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            png = compose(browser, base, home_screen(browser, base))
            browser.close()
    finally:
        server.terminate()
        server.wait(timeout=10)

    with open(args.out, "wb") as handle:
        handle.write(png)
    print(f"wrote {args.out} ({WIDTH}x{HEIGHT}, {len(png)} bytes)")
    print("look at it, then ./build/update-checksums.sh and commit the image with the manifest")


if __name__ == "__main__":
    main()
