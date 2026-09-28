// Runs the SeedSigner firmware in a Web Worker.
//
// The firmware blocks the CPU waiting for a button press, which would freeze the
// page if it ran on the main thread. In a worker that is fine: the page stays
// responsive, and input is handed over through a SharedArrayBuffer so the
// worker's blocking loop can be woken without any change to SeedSigner itself.

importScripts("pyodide-e24b45d3/pyodide.js", "camera.js");

let pyodide = null;
let keyBuffer = null; // Int32Array over SharedArrayBuffer: [state, keycode]
let camera = null;    // the page's half of the camera channel, see camera.js
let debug = false;    // ?debug=1 on the page; otherwise js_log says nothing

// "M" mainnet or "T" testnet — matches SettingsConstants in the firmware zip.
let bitcoinNetwork = "T";

const STATE = 0;
const KEYCODE = 1;

function post(type, payload) {
  self.postMessage({ type, ...payload });
}

function hex(buffer) {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

self.onmessage = async (event) => {
  const { type } = event.data;

  if (type === "init") {
    keyBuffer = new Int32Array(event.data.sharedBuffer);
    camera = CameraChannel.forWorker(event.data.cameraBuffer);
    debug = !!event.data.debug;
    if (event.data.bitcoinNetwork) bitcoinNetwork = event.data.bitcoinNetwork;
    try {
      await boot(event.data.width, event.data.height);
    } catch (error) {
      post("error", { message: String(error && error.message ? error.message : error) });
    }
  }
};

async function boot(width, height) {
  post("status", { stage: "python", message: "loading python…" });
  pyodide = await loadPyodide({ indexURL: "pyodide-e24b45d3/" });

  post("status", { stage: "libraries", message: "loading libraries…" });
  // The renderer draws every screen with Pillow, and pycryptodome is what
  // stands in for pbkdf2_hmac further down, which is the mnemonic to seed path
  // and so is the firmware itself. Dropping that one boots firmware that hangs
  // before the home screen, which is how it was caught.
  //
  // numpy is never reachable: decode_qr imports it inside a try that starts with
  // "import cv2", and opencv is not in this list, so np is None either way.
  await pyodide.loadPackage(["Pillow", "pycryptodome"]);

  post("status", { stage: "firmware-zip", message: "unpacking firmware…" });
  // Built by build/build-firmware-zip.sh from UPSTREAM and published with its
  // own pair of hashes.
  const zip = await (await fetch("seedsigner-stock.zip")).arrayBuffer();

  // Hash what arrived, before unpacking it, and hand it to the page: the panel
  // shows it beside the sha256 UPSTREAM publishes. It has to be these bytes,
  // the ones this worker is about to unpack and run, because a hash taken from
  // anywhere else -- build-info.json most of all -- would only be one claim
  // repeating another.
  const digest = await crypto.subtle.digest("SHA-256", zip);
  post("zip-sha256", { sha256: hex(digest) });

  await pyodide.unpackArchive(zip, "zip", { extractDir: "/firmware" });

  const driver = await (await fetch("browser_display.py")).text();
  pyodide.FS.writeFile("/firmware/browser_display.py", driver);

  const cameraShim = await (await fetch("browser_camera.py")).text();
  pyodide.FS.writeFile("/firmware/browser_camera.py", cameraShim);

  const qrShim = await (await fetch("browser_qr.py")).text();
  pyodide.FS.writeFile("/firmware/browser_qr.py", qrShim);

  post("status", { stage: "starting", message: "starting SeedSigner…" });

  // Frames come back through this callback rather than being polled.
  pyodide.globals.set("js_frame_sink", (bytes) => {
    // Pyodide may hand this over as a proxy or already as a typed array.
    const raw = bytes && typeof bytes.toJs === "function" ? bytes.toJs() : bytes;
    const copy = new Uint8Array(raw);
    if (bytes && typeof bytes.destroy === "function") bytes.destroy();
    self.postMessage({ type: "frame", frame: copy }, [copy.buffer]);
  });

  // Dropped here rather than on the page so the messages are not even built
  // and posted when nobody is reading them.
  pyodide.globals.set("js_log", (msg) => {
    if (debug) self.postMessage({ type: "log", message: String(msg) });
  });

  pyodide.globals.set("js_report_size", (w, h) => {
    self.postMessage({ type: "size", width: w, height: h });
  });

  // What the firmware's settings say the Bitcoin network is. Unlike js_log this
  // is not behind the debug flag: the page shows it to everyone, and it matters
  // most to the visitor who never turns tracing on.
  pyodide.globals.set("js_network", (name, mainnet) => {
    self.postMessage({ type: "network", name: String(name), mainnet: !!mainnet });
  });

  // Blocking read of the next keypress, driven by the page.
  pyodide.globals.set("js_wait_for_key", () => {
    Atomics.wait(keyBuffer, STATE, 0);
    const key = Atomics.load(keyBuffer, KEYCODE);
    Atomics.store(keyBuffer, STATE, 0);
    return key;
  });

  // Same channel, without the parking. The scan screen polls for a press rather
  // than blocking on one, because it has camera frames to pull at the same time.
  pyodide.globals.set("js_peek_key", () => {
    if (Atomics.load(keyBuffer, STATE) === 0) return 0;
    const key = Atomics.load(keyBuffer, KEYCODE);
    Atomics.store(keyBuffer, STATE, 0);
    return key;
  });

  pyodide.globals.set("js_camera", camera);

  pyodide.runPython(shims(width, height, bitcoinNetwork));
  post("ready", {});

  // Blocks for the lifetime of the worker. This is the whole reason the firmware
  // runs here rather than on the page's thread.
  try {
    post("log", { message: "starting controller…" });
    pyodide.runPython(`
import traceback, os
from seedsigner.controller import Controller
js_log("controller imported")
try:
    controller = Controller.get_instance()
    controller.start()
    js_log("controller.start() returned")
except BaseException:
    js_log("controller raised:\\n" + traceback.format_exc()[-1200:])
`);
  } catch (error) {
    post("log", { message: "worker-level failure: " + error });
  }
}

function shims(width, height, network) {
  const net = JSON.stringify(network || "T");
  return `
import sys, json, threading

# The firmware's own logging, surfaced to the browser console.
#
# Without this, logger.info() inside seedsigner/ goes nowhere: only the tracing
# shims below reach js_log, so a view could report exactly why it refused a
# transaction and the message would be invisible. Debugging the signing path
# meant guessing from screen names alone until this existed.
#
# Only when the page asked for debug, and INFO rather than DEBUG, because DEBUG
# on this codebase is thousands of lines per boot.
import logging as _logging


class _JsLogHandler(_logging.Handler):
    def emit(self, record):
        try:
            js_log("[%s] %s" % (record.name.split(".")[-1], record.getMessage()))
        except Exception:
            pass


if ${debug ? "True" : "False"}:
    _root = _logging.getLogger()
    _root.setLevel(_logging.INFO)
    _root.addHandler(_JsLogHandler())
sys.path.insert(0, "/firmware")

# The device's own settings file, written before the firmware reads it. Settings
# loads settings.json from the working directory when it is not running on
# SeedSigner OS, so both of these are configuration, the way a configured device
# would have them, and nothing under seedsigner/ is touched to get them.
#
#   display_config  the panel the page asked for with ?display: the SeedSigner
#                   Plus's 320x240, or the original Waveshare 1.3" hat's 240x240,
#                   which is SeedSigner's own default.
#   network         Mainnet when the page asks for ?network=mainnet; otherwise
#                   testnet. Still changeable in Settings on hardware.
#
# Every key and value here is a SettingsConstants: SETTING__DISPLAY_CONFIGURATION,
# SETTING__NETWORK and TESTNET.
import os, json
os.chdir("/firmware")
_settings = {"display_config": ${JSON.stringify(width === 240 && height === 240
                                              ? "st7789_240x240" : "st7789_320x240")},
             "network": ${net}}
with open("/firmware/settings.json", "w") as handle:
    json.dump(_settings, handle)

# --- no real threads in the browser -----------------------------------------
class _NoThread:
    """
    Stand-in for threading.Thread.

    Two kinds of thread exist in this codebase. SeedSigner's own BaseThread
    subclasses loop on keep_running to animate something, and running one
    synchronously would never return, so those are dropped. Everything else is
    a one-shot helper (startup preloading, for instance) whose work the caller
    may well be waiting on, so those run inline on start().
    """

    def __init__(self, group=None, target=None, name=None, args=(), kwargs=None, daemon=None):
        self._target, self._args, self._kwargs = target, args, kwargs or {}
        self.name, self.daemon = name or "nothread", daemon
        self._done = False

    # The controller blocks waiting for BackgroundImportThread to set up storage,
    # and its run() is a one-shot rather than a loop, so it has to run even
    # though it is a BaseThread. Without it the firmware hangs forever after the
    # splash.
    #
    # The address verification thread is the other kind of exception. It looks
    # like an animation loop -- a while over keep_running -- but it is a search
    # that ends: it walks the derivation path looking for one address and stops
    # when it finds it. Dropped, nothing ever searched, so Verify Address sat
    # showing an index that never moved and its Skip 10 incremented a counter no
    # thread was reading. Run, they answer at once for an address that really is
    # the firmware's, which is the case worth having work.
    RUN_INLINE_ANYWAY = {
        "BackgroundImportThread",
        "BruteForceAddressVerificationThread",
    }

    # How far one of those searches may walk before this gives up on it. Upstream
    # has no bound on the not-found case because on hardware it is a real thread
    # somebody can cancel; here it would be the whole worker, wedged. A device
    # that has just exported its own key is being asked about its own first
    # address, so this only has to be deep enough to be honest about a miss.
    INLINE_SEARCH_LIMIT = 100

    def _is_animation_loop(self):
        if type(self).__name__ in self.RUN_INLINE_ANYWAY:
            return False
        return hasattr(self, "keep_running")

    def _bound_search(self):
        """Stop a search thread walking for ever, since nothing else can."""
        counter = getattr(self, "threadsafe_counter", None)
        if counter is None or not hasattr(counter, "increment"):
            return
        increment = counter.increment
        thread = self

        def bounded(step=1):
            increment(step)
            if counter.cur_count >= _NoThread.INLINE_SEARCH_LIMIT:
                js_log(f"inline search {type(thread).__name__} gave up at "
                       f"{counter.cur_count}")
                thread.keep_running = False

        counter.increment = bounded

    def start(self):
        js_log(f"thread start: {type(self).__name__} "
               f"loop={self._is_animation_loop()} target={getattr(self._target, '__name__', None)}")
        if self._is_animation_loop() or self._done:
            return
        self._done = True
        if type(self).__name__ in _NoThread.RUN_INLINE_ANYWAY and hasattr(self, "keep_running"):
            self._bound_search()
        try:
            self.run()
        except Exception as exc:
            js_log(f"inline thread {self.name} failed: {type(exc).__name__}: {exc}")

    def run(self):
        if self._target:
            self._target(*self._args, **self._kwargs)

    def stop(self): pass
    def join(self, timeout=None): pass
    def is_alive(self): return False

threading.Thread = _NoThread


# A lock that cannot deadlock, because there is nobody here to deadlock with.
#
# A thread's work run inline on start() runs inside whatever lock its starter
# was holding. On a device those are two threads and the second one waits a
# moment for the first. Here they are one thread, and a plain Lock taken twice
# waits for itself forever.
#
# There is one thread in this environment, so the only acquire that can ever
# block is a thread blocking on itself, which is a deadlock rather than
# contention. A reentrant lock turns exactly that case into a pass and leaves
# every other use of a lock as it was.
threading.Lock = threading.RLock

# --- hashlib here has no OpenSSL behind it -----------------------------------
# pbkdf2_hmac is not implemented in Python: it lives in _hashlib, the OpenSSL
# binding, which this build does not have. Every other hash embit wants is pure
# Python and survives, so this is the one hole, and it is directly in the path
# from a mnemonic to seed bytes -- without it loading any seed at all ends in
# InvalidSeedException. pycryptodome is already loaded and its PBKDF2 is the
# real one, so borrow that rather than hand-rolling the derivation.
import hashlib

if not hasattr(hashlib, "pbkdf2_hmac"):
    from Crypto.Hash import SHA256 as _SHA256, SHA512 as _SHA512
    from Crypto.Protocol.KDF import PBKDF2 as _PBKDF2

    _PRF = {"sha256": _SHA256, "sha512": _SHA512}

    def _pbkdf2_hmac(hash_name, password, salt, iterations, dklen=None):
        module = _PRF.get(hash_name)
        if module is None:
            raise ValueError(f"pbkdf2_hmac: no shim for {hash_name}")
        return _PBKDF2(password, salt, dkLen=dklen or module.digest_size,
                       count=iterations, hmac_hash_module=module)

    hashlib.pbkdf2_hmac = _pbkdf2_hmac

# --- nothing here can start a process ----------------------------------------
# Several helpers shell out to a faster native tool and fall back to pure Python
# when the binary is not installed; qr.py does it with qrencode. Emscripten
# raises OSError for that rather than FileNotFoundError, which those fallbacks
# do not catch, so exporting a QR ended in a System Error instead of a QR.
# Reporting the binary as absent is both true here and the case they already
# know how to handle.
#
# call() reports failure by returning non-zero rather than by raising: stock's
# qr.py has no try/except around the qrencode call and only checks the return
# code, so a raise there escapes and every screen that draws a QR ends in a
# visible System Error. "The binary ran and failed" is no less true here than
# "the binary is not installed".
import subprocess

def _no_such_binary(*args, **kwargs):
    raise FileNotFoundError("no processes in the browser")

def _failed_call(*args, **kwargs):
    return 1

subprocess.call = _failed_call
for _name in ("run", "check_call", "check_output", "Popen"):
    setattr(subprocess, _name, _no_such_binary)

# --- draw to the page instead of a panel -------------------------------------
import browser_display

_seen = {"n": 0}
_orig_show = browser_display.BrowserDisplay.show_image
def _traced_show(self, image, x_start=0, y_start=0):
    _seen["n"] += 1
    if _seen["n"] <= 3:
        js_log(f"show_image #{_seen['n']}: mode={image.mode} size={image.size} "
               f"driver={self.width}x{self.height}")
    return _orig_show(self, image, x_start, y_start)
browser_display.BrowserDisplay.show_image = _traced_show

browser_display.install(js_frame_sink, ${width}, ${height})

from seedsigner.gui.renderer import Renderer
from seedsigner.hardware.buttons import HardwareButtons, HardwareButtonsConstants

Renderer.configure_instance()
renderer = Renderer.get_instance()

# --- buttons come from the page, not from GPIO -------------------------------
# The firmware blocks here waiting for a press. In a worker that is exactly what
# we want: js_wait_for_key parks on Atomics.wait until the page posts a key.
def _get_instance(cls):
    if cls._instance is None:
        instance = cls.__new__(cls)
        instance.override_ind = False
        instance.cur_input = None
        instance.cur_input_started = None
        instance.last_input_time = 0
        instance.first_repeat_threshold = 225
        instance.next_repeat_threshold = 250
        cls._instance = instance
    return cls._instance

# Buttons are identified by name ("KEY_UP") here, by GPIO number in older releases.
# Resolving through the constants class works for either.
BUTTON_NAMES = [None, "KEY_UP", "KEY_DOWN", "KEY_LEFT", "KEY_RIGHT",
                "KEY_PRESS", "KEY1", "KEY2", "KEY3"]
BUTTON_VALUES = [None] + [getattr(HardwareButtonsConstants, n) for n in BUTTON_NAMES[1:]]

def _wait_for(self, keys=[]):
    js_log(f'wait_for keys={keys!r}')
    while True:
        index = js_wait_for_key()
        if index < 1 or index >= len(BUTTON_VALUES):
            continue
        value = BUTTON_VALUES[index]
        js_log(f'key index={index} -> {value!r} accepted={not keys or value in keys}')
        if not keys or value in keys:
            self.last_input_time = 0
            return value

def _update_last_input_time(self):
    self.last_input_time = 0

# The scan screen is the one caller that polls for a press instead of blocking on
# one, because it has camera frames to pull at the same time. Without this it
# could never see the press that backs out of scanning, and the only way out of
# the scan loop would be a successful decode.
#
# A press has to stay claimable long enough for every check in one pass of the
# caller's loop to see it, since the scan loop asks about KEY_RIGHT before
# KEY_LEFT. It must not stay forever, or a key nobody wants sits here hiding the
# press behind it.
_PENDING_KEYS = []  # [value, times offered]
_MAX_OFFERS = 4

def _check_for_low(self, key=None, keys=None):
    index = js_peek_key()
    if 1 <= index < len(BUTTON_VALUES):
        _PENDING_KEYS.append([BUTTON_VALUES[index], 0])

    wanted = list(keys) if keys else ([key] if key is not None else [])
    for entry in _PENDING_KEYS:
        entry[1] += 1
        if not wanted or entry[0] in wanted:
            _PENDING_KEYS.remove(entry)
            self.last_input_time = 0
            return True

    _PENDING_KEYS[:] = [e for e in _PENDING_KEYS if e[1] < _MAX_OFFERS]
    return False

HardwareButtons.get_instance = classmethod(_get_instance)
HardwareButtons.wait_for = _wait_for
HardwareButtons.update_last_input_time = _update_last_input_time
# A screen showing a code is deaf for a moment after it opens. Presses aimed at
# the screen before it are still arriving then, and one of them would dismiss a
# transaction before a single frame of it had been read.
import time as _clock

_deaf_until = [0.0]

def _poll_button():
    index = js_peek_key()
    if 1 <= index < len(BUTTON_VALUES):
        _PENDING_KEYS.append([BUTTON_VALUES[index], 0])
    if _clock.monotonic() < _deaf_until[0]:
        _PENDING_KEYS.clear()
        return None
    return _PENDING_KEYS.pop(0)[0] if _PENDING_KEYS else None

HardwareButtons.check_for_low = _check_for_low
HardwareButtons.has_any_input = lambda self: False
HardwareButtons.trigger_override = lambda self, force_release=False: None

# --- the camera, and the QR decode, both come from the page -------------------
import browser_camera
browser_camera.install(js_camera)

# --- the screens that show a QR draw from a thread this port cannot run ------
import browser_qr
browser_qr.install(_poll_button)

js_report_size(renderer.canvas_width, renderer.canvas_height)

# --- trace the screen lifecycle so a stall is locatable ----------------------
from seedsigner.gui.screens.screen import BaseScreen
_orig_display = BaseScreen.display
_orig_run = BaseScreen._run

def _traced_display(self):
    js_log(f"display() enter: {type(self).__name__}")
    try:
        result = _orig_display(self)
        js_log(f"display() exit: {type(self).__name__} -> {result!r}")
        return result
    except BaseException as exc:
        js_log(f"display() RAISED in {type(self).__name__}: {type(exc).__name__}: {exc}")
        raise

def _traced_run(self):
    js_log(f"_run() enter: {type(self).__name__}")
    return _orig_run(self)

BaseScreen.display = _traced_display
BaseScreen._run = _traced_run

# A code on screen must not be dismissed by a press made before it appeared.
#
# browser_qr pumps this screen by drawing a frame and then polling for a key,
# and that poll pops from the same queue check_for_low fills, where a press
# stays claimable for several reads so the scan loop cannot miss it. A press
# aimed at the screen before this one was therefore still sitting there, and
# the code was gone after a single frame. An animated transaction never got to
# animate, so the page had nothing to read back.
#
# Real hardware cannot do this: a button pressed before a screen exists is not
# waiting for it. So the queue is emptied as the screen opens.
from seedsigner.gui.screens.screen import QRDisplayScreen as _QRScreen
_pumped_qr_run = _QRScreen._run

def _qr_run_from_a_clean_queue(self):
    _PENDING_KEYS.clear()
    while js_peek_key():
        pass
    _deaf_until[0] = _clock.monotonic() + 1.5
    return _pumped_qr_run(self)

_QRScreen._run = _qr_run_from_a_clean_queue

# The passphrase keyboard has the same problem and it is worse, because a leaked
# press does not close it, it types a character. The keyboard opens straight
# after a button press on the screen before it, that press is still claimable,
# and the passphrase would come out one letter longer than what was typed.
from seedsigner.gui.screens.seed_screens import SeedAddPassphraseScreen as _KeyboardScreen
_keyboard_run = _KeyboardScreen._run


def _keyboard_run_from_a_clean_queue(self):
    _PENDING_KEYS.clear()
    while js_peek_key():
        pass
    return _keyboard_run(self)


_KeyboardScreen._run = _keyboard_run_from_a_clean_queue

# A browser has no ribbon cable.
#
# When getUserMedia is refused, the firmware shows the screen it shows a real
# device with a loose camera connector: "Hardware Error", "Disconnect power and
# check for a loose camera connection." Nothing is loose and there is no power
# to disconnect; a permission prompt was answered with no. That screen is the
# first thing a visitor who declines the prompt sees, and it sends them looking
# for a fault that does not exist.
#
# The page already says the true thing in red under the device. This makes the
# device agree with it.
from seedsigner.views import view as _view
from seedsigner.gui.screens.screen import ErrorScreen as _ErrorScreen
from seedsigner.gui.screens.screen import ButtonOption as _ButtonOption


def _camera_was_refused(self):
    # Said out loud so a test can tell which of the two screens ran. Screen text
    # is drawn, never logged, so without this there is nothing to check and the
    # wrong message could come back unnoticed.
    print("camera: the browser refused it, saying so instead of blaming a cable")
    self.run_screen(
        _ErrorScreen,
        title="Camera",
        status_headline="The browser said no",
        text="Allow the camera in the address bar, then open Scan again.",
        button_data=[_ButtonOption("Back to Main Menu")],
        show_back_button=False,
    )
    return _view.Destination(_view.MainMenuView, clear_history=True)


_view.CameraConnectionErrorView.run = _camera_was_refused

# Views can stall before they ever construct a Screen, so trace one level up.
#
# Destination.run, and not View.run, which is what this patched for a long time
# and traced nothing at all. View.run is abstract -- its body raises "Must
# implement in the child class" -- and all of upstream's views override it, so
# patching the base class rebound an attribute no call ever looked up and a
# whole boot produced zero lines. Destination.run is the funnel the controller
# drives every transition through, and it wraps instantiation as well as the
# run, so a view that hangs in __init__ before it has a Screen still names
# itself here, which was the point of tracing one level up.
#
# The name comes from the Destination rather than from the instance because the
# instance does not exist yet when the enter line is written -- and that is
# exactly the failure this is here to locate.
from seedsigner.views.view import Destination
_orig_dest_run = Destination.run
def _traced_dest_run(self):
    name = self.View_cls.__name__ if self.View_cls is not None else "None"
    js_log(f"View.run enter: {name}")
    try:
        out = _orig_dest_run(self)
        js_log(f"View.run exit: {name}")
        return out
    except BaseException as exc:
        js_log(f"View.run RAISED {name}: {type(exc).__name__}: {exc}")
        raise
Destination.run = _traced_dest_run

# --- which Bitcoin network the firmware is set to ------------------------------
# The page has to show this, and the page must not be the one that knows it: a
# second copy of a setting is a copy that can disagree with the firmware, and it
# would disagree exactly when someone had just changed the setting. So the value
# is read back out of Settings with upstream's own accessors, at the two moments
# it can be new: once here, before the controller starts, and again after every
# write the firmware makes. set_value is that write, for every settings screen,
# so wrapping it observes the change rather than predicting it.
from seedsigner.models.settings import Settings
from seedsigner.models.settings_definition import SettingsConstants

def _report_network():
    try:
        settings = Settings.get_instance()
        value = settings.get_value(SettingsConstants.SETTING__NETWORK)
        name = settings.get_value_display_name(SettingsConstants.SETTING__NETWORK)
        js_network(str(name), value == SettingsConstants.MAINNET)
    except Exception as exc:
        js_log(f"network report failed: {type(exc).__name__}: {exc}")

_orig_set_value = Settings.set_value
def _traced_set_value(self, *args, **kwargs):
    result = _orig_set_value(self, *args, **kwargs)
    _report_network()
    return result
Settings.set_value = _traced_set_value

_report_network()

import time as _time
_orig_sleep = _time.sleep
def _traced_sleep(seconds):
    if seconds >= 0.5:
        js_log(f"sleep({seconds})")
    return _orig_sleep(seconds)
_time.sleep = _traced_sleep
`;
}
