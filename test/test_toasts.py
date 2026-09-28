"""
Toasts: SeedSigner's toast threads, run as green threads.

A toast is a thread that takes the renderer's lock, draws itself over the
screen, and holds the lock until its time is up or a key goes down, then puts
the screen back and lets go. Stock firmware only raises microSD toasts and the
simulator has no card, so no toast ever appears in the page, and there is no way
into a running worker to raise one. This checks the mechanism outside the
browser instead, against the firmware's own code: BaseToastOverlayManagerThread's
run(), lifted out of the built zip as it stands, rewritten and scheduled by
browser_threads.py exactly as the worker would, with a stand-in for the screen
and the buttons around it.

- **A key closes it.** The main stack, wanting the lock to draw the next screen,
  waits in the scheduler; the toast sees the key, puts the screen back and lets
  go, promptly rather than after its full duration.
- **Its time closes it**, if nobody presses anything.
- **A key during its delay cancels it** before it is ever drawn.

Plain CPython, no browser and no server: seconds.
"""

import ast
import importlib.util
import os
import sys
import tempfile
import textwrap
import time
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "src", "shims"))
import harness
from harness import check, report

# Held against the key: how long wait_for's taken press still counts as down,
# as worker.js's _KEY_DOWN_S does.
KEY_DOWN_S = 0.3


def upstream_run(zip_path):
    """The source of BaseToastOverlayManagerThread.run, as the zip holds it."""
    with zipfile.ZipFile(zip_path) as archive:
        source = archive.read("seedsigner/gui/toast.py").decode()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.ClassDef) and node.name == "BaseToastOverlayManagerThread":
            for item in node.body:
                if isinstance(item, ast.FunctionDef) and item.name == "run":
                    lines = source.splitlines()[item.lineno - 1:item.end_lineno]
                    return textwrap.dedent("\n".join(lines))
    raise AssertionError("no BaseToastOverlayManagerThread.run in seedsigner/gui/toast.py")


# Everything the run() reaches for, and nothing else. The class keeps the
# upstream name, because that is what browser_threads recognises a toast by.
MODULE = '''
import logging
import threading
import time

logger = logging.getLogger("toast")


class BaseToastOverlayManagerThread(threading.Thread):
    def __init__(self, renderer, hw_inputs, activation_delay=0, duration=3):
        super().__init__()
        self.renderer = renderer
        self.hw_inputs = hw_inputs
        self.activation_delay = activation_delay
        self.duration = duration
        self._toggle_renderer_lock = False
        self.toast = renderer.toast

    def start(self):
        # As seedsigner.models.threads.BaseThread does.
        self.keep_running = True
        super().start()

    def stop(self):
        self.keep_running = False

    def should_keep_running(self):
        return True

{run}
'''


class Screen:
    """The renderer, as far as a toast can tell."""

    def __init__(self, lock):
        self.lock = lock
        self.shown = []
        screen = self

        class Canvas:
            def copy(self):
                return "the screen before"

        class Toast:
            def render(self):
                screen.shown.append("the toast")

        self.canvas = Canvas()
        self.toast = Toast()

    def show_image(self, image=None):
        self.shown.append(image)


class Buttons:
    """has_any_input as worker.js answers it: a press waiting, or one just taken."""

    def __init__(self):
        self.taken_at = -1.0

    def press(self):
        self.taken_at = time.monotonic()

    def has_any_input(self):
        return time.monotonic() - self.taken_at < KEY_DOWN_S


class Page:
    """browser_threads' way out to the page, with nothing on the other side."""

    def __init__(self, sleep):
        self.sleep = sleep

    def wait_key(self, ms):
        self.sleep(0.02 if ms < 0 else min(ms, 20) / 1000)

    def wait_ms(self, ms):
        self.sleep(max(0, ms) / 1000)

    def set_live(self, on):
        pass


def main() -> int:
    zip_path = harness.find_asset(harness.FIRMWARE_ZIP)
    if not zip_path:
        print(f"no {harness.FIRMWARE_ZIP}: run build/build-firmware-zip.sh first",
              file=sys.stderr)
        return 2

    import threading
    real_sleep = time.sleep
    import browser_threads
    lines = []
    browser_threads.install(Page(real_sleep), lines.append)

    # Written to a file, because browser_threads reads run() back with
    # inspect.getsource, as it does from /firmware in the worker.
    folder = tempfile.mkdtemp(prefix="sim-toast-")
    path = os.path.join(folder, "toast_under_test.py")
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(MODULE.format(run=textwrap.indent(upstream_run(zip_path), "    ")))
    spec = importlib.util.spec_from_file_location("toast_under_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    Toast = module.BaseToastOverlayManagerThread

    # --- a key closes it ----------------------------------------------------
    screen, buttons = Screen(threading.Lock()), Buttons()
    toast = Toast(screen, buttons, activation_delay=0, duration=5)
    toast.start()
    check("a toast runs as a green thread",
          any("BaseToastOverlayManagerThread kind=green" in line for line in lines),
          next((line for line in lines if "thread start" in line), ""))
    check("it draws itself and holds the screen", screen.shown == ["the toast"]
          and screen.lock.locked(), str(screen.shown))
    check("no toast rewrite failed",
          not any("cannot rewrite" in line or "failed" in line for line in lines),
          "; ".join(lines))

    buttons.press()                     # wait_for has just taken a key
    started = time.monotonic()
    with screen.lock:                   # and the next screen wants to draw
        waited = time.monotonic() - started
    check("a key closes it promptly, not after its five seconds",
          waited < 0.5, f"{waited:.2f}s")
    check("and it puts the screen back before letting go",
          screen.shown == ["the toast", "the screen before"], str(screen.shown))
    check("and it is gone", not toast.is_alive())

    # --- its time closes it -------------------------------------------------
    screen, buttons = Screen(threading.Lock()), Buttons()
    toast = Toast(screen, buttons, activation_delay=0, duration=0.6)
    toast.start()
    started = time.monotonic()
    with screen.lock:
        waited = time.monotonic() - started
    check("with nobody pressing anything it goes when its time is up",
          0.4 <= waited <= 1.5, f"{waited:.2f}s for a 0.6s toast")
    check("and it puts the screen back then too",
          screen.shown == ["the toast", "the screen before"], str(screen.shown))

    # --- a key in its delay cancels it --------------------------------------
    screen, buttons = Screen(threading.Lock()), Buttons()
    toast = Toast(screen, buttons, activation_delay=1, duration=5)
    toast.start()
    buttons.press()
    time.sleep(0.4)                     # the main stack's own wait: the toast's turn
    check("a key while it is waiting to appear cancels it",
          not toast.is_alive() and "the toast" not in screen.shown
          and not screen.lock.locked(), str(screen.shown))

    return report()


if __name__ == "__main__":
    sys.exit(main())
