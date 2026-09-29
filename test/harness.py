"""
Shared plumbing for the tests: where to point them, and how to read the firmware's
own log.

The log is the oracle for almost everything here. The firmware narrates every
screen it puts up ("display() enter: <ScreenName>"), the camera says which
decoder it chose. Asserting on those lines is a statement about what the firmware actually did,
which a screenshot is not.

Only ?debug=1 asks the worker for that narration and puts it on the console,
which is where these tests read it from, so sim_url() always adds it. Without it every test in this suite would
sit and time out against firmware that is working perfectly.
"""

import base64
import os
import re
import time
from urllib.parse import urlencode

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

PORT = int(os.environ.get("SIM_PORT", "8770"))

# Loopback rather than the machine's LAN address, deliberately: getUserMedia
# only runs in a secure context, and 127.0.0.1 counts as one without anybody
# having to produce a certificate.
BASE_URL = os.environ.get("SIM_URL", f"http://127.0.0.1:{PORT}").rstrip("/")

# Videos and screenshots. Everything written here is generated; nothing in it is
# an input to anything else, so it can be deleted at any time.
ARTIFACT_DIR = os.environ.get("SIM_ARTIFACT_DIR", os.path.join(REPO, "test", "artifacts"))

# The firmware the page runs, built by build/build-firmware-zip.sh: stock, the
# release, unless SIM_FIRMWARE=dev asks for the development-branch pin. Every
# test runs against whichever it is, through sim_url() below.
FIRMWARE = "dev" if os.environ.get("SIM_FIRMWARE") == "dev" else "stock"
FIRMWARE_ZIP = f"seedsigner-{FIRMWARE}.zip"

# The build outputs, none of which is committed. build/build-firmware-zip.sh
# assembles the firmware zip from its pinned upstream SeedSigner commit
# and leaves it in build/out; build/fetch-assets.sh downloads the Pyodide
# runtime into src/web/pyodide-e24b45d3. Both are looked for in a list rather
# than at one path, so a deploy that puts everything in one directory still
# works.
# SIM_ASSETS replaces the list, which is how the suite is pointed at an
# already-built tree.
ASSET_DIRS = [d for d in os.environ.get("SIM_ASSETS", "").split(os.pathsep) if d] or [
    os.path.join(REPO, "build", "out"),
    os.path.join(REPO, "src", "web"),
]

# What the server overlays, in priority order: the page and its scripts, then
# the shims the worker fetches by name at boot, then the build outputs.
WEB_ROOTS = [os.path.join(REPO, "src", "web"), os.path.join(REPO, "src", "shims")]
WEB_ROOTS += [d for d in ASSET_DIRS if d not in WEB_ROOTS]


def find_asset(name):
    """First ASSET_DIRS entry holding <name>, or None if the build has not run."""
    for directory in ASSET_DIRS:
        candidate = os.path.join(directory, name)
        if os.path.exists(candidate):
            return candidate
    return None



def page_error(message):
    """Is this console message a real problem? Every one is, now that the page
    loads nothing it does not serve itself. Kept as the one place to say so."""
    return True


def sim_url(page="index.html", **params):
    """A URL for the simulator, with tracing on: ?debug=1 is what puts the
    firmware's narration on the console, which is what these tests read."""
    params.setdefault("debug", "1")
    if FIRMWARE != "stock":
        params.setdefault("firmware", FIRMWARE)
    return f"{BASE_URL}/{page}?{urlencode(params)}"


def artifact(name):
    """Absolute path to a generated file, with the directory made on demand."""
    os.makedirs(ARTIFACT_DIR, exist_ok=True)
    return os.path.join(ARTIFACT_DIR, name)


def save_screen(page, path):
    """Write the device's screen, at the 320x240 the firmware drew it.

    Not a screenshot. A screenshot of the page also holds the title, the warning
    box and the hint line, all of them rendered with whatever
    fonts the machine has and none of them anything the firmware can influence; a
    screenshot of the canvas element holds whatever CSS scaled it to, and those
    scaled edge pixels move by one when anything else on the page changes
    height. Reading the canvas's own pixels instead gets exactly the bytes
    SeedSigner's renderer put there and nothing else.
    """
    data_url = page.evaluate(
        "() => document.getElementById('screen').toDataURL('image/png')")
    with open(path, "wb") as handle:
        handle.write(base64.b64decode(data_url.split(",", 1)[1]))


# --- checks ------------------------------------------------------------------
# Deliberately not an assert: a run that stops at the first failure tells you one
# thing per run, and these runs are slow.

_failures = []


def check(name, condition, detail=""):
    print(("  ok   " if condition else "  FAIL ") + name + (f"  {detail}" if detail else ""),
          flush=True)
    if not condition:
        _failures.append(name)


def report():
    """Exit code for the whole file: 0 only if every check passed."""
    print()
    if _failures:
        print(f"FAILED: {len(_failures)} check(s): {_failures}")
        return 1
    print("all checks passed")
    return 0


# --- reading the firmware's log ------------------------------------------------


class Log:
    """Everything the page has said, in order, with the waiting built in."""

    def __init__(self, page):
        self.lines = []
        self.page = page
        page.on("console", lambda m: self.lines.append(m.text))
        # A page error is invisible otherwise, and a test that fails because the
        # worker threw should say so rather than just time out.
        page.on("pageerror", lambda e: self.lines.append(f"PAGEERROR {e}"))

    def mark(self):
        """Index to search from, so a later phase cannot pass on a line an
        earlier phase produced."""
        return len(self.lines)

    def wait(self, pattern, timeout, what, since=0):
        deadline = time.time() + timeout
        matcher = re.compile(pattern)
        while time.time() < deadline:
            for line in self.lines[since:]:
                found = matcher.search(line)
                if found:
                    return found
            self.page.wait_for_timeout(250)
        raise AssertionError(f"timed out after {timeout}s waiting for {what}\n  "
                             + "\n  ".join(self.lines[-40:]))

    def seen(self, pattern, since=0):
        """For asserting a line is absent, which is how the refusal tests work."""
        matcher = re.compile(pattern)
        for line in self.lines[since:]:
            found = matcher.search(line)
            if found:
                return found
        return None

    def last_screen(self):
        """The screen most recently put up, which is the one being looked at."""
        for line in reversed(self.lines):
            found = re.search(r"display\(\) enter: (\w+)", line)
            if found:
                return found.group(1)
        return None

    def dump(self, needle):
        for line in self.lines:
            if needle in line:
                print("  " + line)


def press(page, key, times=1):
    """Press a device key through the page's keyboard, with room for the firmware
    to answer between presses."""
    for _ in range(times):
        page.keyboard.press(key)
        page.wait_for_timeout(220)


def back_to_home(page, log):
    """Climb the back stack until the home screen is up again.

    Up walks off the top of a list or a keyboard onto the top nav's back arrow,
    and a click there returns RET_CODE__BACK_BUTTON. It is the one gesture that
    works on every screen a test can land on. Home is the one screen with no back
    arrow, so this has to notice it has arrived rather than pressing once more
    and diving back in.
    """
    for _ in range(12):
        if log.last_screen() == "MainMenuScreen":
            return
        press(page, "ArrowUp", 6)
        press(page, "Enter")
        page.wait_for_timeout(500)
    raise AssertionError("could not get back to the home screen\n  "
                         + "\n  ".join(log.lines[-30:]))
