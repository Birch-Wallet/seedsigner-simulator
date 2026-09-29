// Runs the SeedSigner firmware in a Web Worker.
//
// The firmware blocks the CPU waiting for a button press, which would freeze the
// page if it ran on the main thread. In a worker that is fine: the page stays
// responsive, and input is handed over through a SharedArrayBuffer so the
// worker's blocking loop can be woken without any change to SeedSigner itself.

importScripts("pyodide-e24b45d3/pyodide.js", "camera.js");

let pyodide = null;
let keyBuffer = null; // Int32Array over SharedArrayBuffer: [state, keycode]
// Int32Array over SharedArrayBuffer: [signal, live, wait]. Pyodide's interrupt
// buffer is slot 0; the page writes SIGINT there to give the green threads a
// turn, but only while slot 1 says something is live. Slot 2 is only ever
// waited on, as a sleep that the page cannot cut short.
let tickBuffer = null;
let camera = null;    // the page's half of the camera channel, see camera.js
let debug = false;    // ?debug=1 on the page; otherwise js_log says nothing

// "M" mainnet or "T" testnet — matches SettingsConstants in the firmware zip.
let bitcoinNetwork = "T";
// Whether the URL chose that network, and the settings file the page kept from a
// previous visit, if Persistent Settings was on (see index.html).
let networkExplicit = false;
let savedSettings = "";

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
    tickBuffer = new Int32Array(event.data.tickBuffer);
    camera = CameraChannel.forWorker(event.data.cameraBuffer);
    debug = !!event.data.debug;
    if (event.data.bitcoinNetwork) bitcoinNetwork = event.data.bitcoinNetwork;
    networkExplicit = !!event.data.networkExplicit;
    savedSettings = typeof event.data.savedSettings === "string" ? event.data.savedSettings : "";
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

  const threadShim = await (await fetch("browser_threads.py")).text();
  pyodide.FS.writeFile("/firmware/browser_threads.py", threadShim);

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

  // One file off this origin, whole, or null. Synchronous, because the firmware
  // asks for a font in the middle of drawing and the worker cannot come back to
  // its event loop to wait; a worker is allowed a synchronous request.
  pyodide.globals.set("js_fetch_bytes", (url) => {
    const request = new XMLHttpRequest();
    request.open("GET", url, false);
    request.responseType = "arraybuffer";
    try {
      request.send();
    } catch (error) {
      return null;
    }
    return request.status === 200 ? new Uint8Array(request.response) : null;
  });

  // The firmware's settings file, for the page to keep (text) or forget (empty).
  pyodide.globals.set("js_settings_file", (text) => {
    const kept = String(text || "");
    self.postMessage(kept ? { type: "settings-saved", text: kept } : { type: "settings-erased" });
  });

  // Whether a press is waiting, without taking it.
  pyodide.globals.set("js_key_pending", () => Atomics.load(keyBuffer, STATE) !== 0);

  // What the green threads' scheduler parks on between turns. wait_key comes
  // back early for a press and leaves it where it is, for wait_for to take.
  pyodide.globals.set("js_threads", {
    wait_key: (ms) => {
      Atomics.wait(keyBuffer, STATE, 0, ms < 0 ? Infinity : ms);
    },
    wait_ms: (ms) => {
      Atomics.wait(tickBuffer, 2, 0, Math.max(0, ms));
    },
    set_live: (on) => {
      Atomics.store(tickBuffer, 1, on ? 1 : 0);
    },
  });

  // Takes the waiting press, or answers 0. Every read of a key goes through
  // here: wait_for once the scheduler says one is waiting, and the scan screen's
  // polling, which has camera frames to pull at the same time.
  pyodide.globals.set("js_peek_key", () => {
    if (Atomics.load(keyBuffer, STATE) === 0) return 0;
    const key = Atomics.load(keyBuffer, KEYCODE);
    Atomics.store(keyBuffer, STATE, 0);
    return key;
  });

  pyodide.globals.set("js_camera", camera);

  // The tick, for the green threads (see browser_threads.py). Handed over
  // before the shims run; the handler is installed before the page is ever told
  // to send one.
  pyodide.setInterruptBuffer(tickBuffer);

  pyodide.runPython(shims(width, height, bitcoinNetwork, networkExplicit, savedSettings));
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

function shims(width, height, network, explicit, saved) {
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
# With Persistent Settings on, the file the firmware last saved is kept by the
# page, and it comes back here as the starting point, the way a device finds its
# own on the microSD card. The panel the page is showing always wins over it,
# and so does a network the URL names.
#
# Every key and value here is a SettingsConstants: SETTING__DISPLAY_CONFIGURATION,
# SETTING__NETWORK and TESTNET.
import os, json
os.chdir("/firmware")
_settings = {}
_saved = ${JSON.stringify(saved || "")}
if _saved:
    try:
        _restored = json.loads(_saved)
        if isinstance(_restored, dict):
            _settings.update(_restored)
    except ValueError as exc:
        js_log(f"saved settings unreadable, starting from defaults: {exc}")
_settings["display_config"] = ${JSON.stringify(width === 240 && height === 240
                                             ? "st7789_240x240" : "st7789_320x240")}
if ${explicit ? "True" : "False"} or "network" not in _settings:
    _settings["network"] = ${net}
with open("/firmware/settings.json", "w") as handle:
    json.dump(_settings, handle)

# --- a wall clock as fine as the device's -------------------------------------
# time.time() here is Date.now(): it moves in whole milliseconds, so two reads
# less than one apart are equal. On a Pi it has microseconds, and stock relies on
# that without saying so: ScanScreen divides its frame count by the time since the
# scan started, and a first frame decoded inside the same millisecond -- which
# Safari manages -- ends in ZeroDivisionError. time.monotonic() is
# performance.now(), microseconds even here, so the wall clock is read once and
# carried forward on it.
import time as _wall
_wall_origin = _wall.time() - _wall.monotonic()
_wall.time = lambda: _wall_origin + _wall.monotonic()

# --- threads, taking turns ----------------------------------------------------
# Pyodide is one thread. SeedSigner's animation threads -- the spinner, the
# pulsing warning edge, scrolling labels, animated QRs, the camera preview -- run
# as green threads instead, taking turns with the firmware wherever it waits,
# and on a tick while it computes. The one-shots still run inline; anything else
# loop-shaped is still dropped. See browser_threads.py. It has to be in place
# before seedsigner.models.threads is imported, which binds Thread and Lock.
import browser_threads
browser_threads.install(js_threads, js_log)

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

# Except qrencode, which is answered here rather than reported missing.
#
# qr.py's fallback for a missing qrencode drops the background colour it was
# asked for, so every QR came out on qrimage()'s default #444 whatever the
# brightness: Up and Down on a QR screen showed the brightness tip and changed
# nothing. On a device qrencode is there and that fallback never runs. So the
# one command qr.py sends is carried out with the qrcode library already in the
# zip -- same margin, module size, error correction and colours, the same PNG
# where qr.py reads it -- and upstream stays on the path a device takes.
import shlex

_QR_LEVELS = {"L": 1, "M": 0, "Q": 3, "H": 2}   # qrcode.constants.ERROR_CORRECT_*

def _qrencode(argv):
    import qrcode
    options = {"-m": "4", "-s": "3", "-l": "L", "-t": "PNG", "-o": None}
    colours = {"--foreground": "000000", "--background": "ffffff"}
    data = None
    words = iter(argv[1:])
    for word in words:
        if word in options:
            options[word] = next(words, None)
        elif word.split("=", 1)[0] in colours and "=" in word:
            name, value = word.split("=", 1)
            colours[name] = value
        else:
            data = word
    if data is None or options["-o"] is None or options["-t"] != "PNG":
        return 1
    try:
        qr = qrcode.QRCode(error_correction=_QR_LEVELS.get(options["-l"].upper(), 1),
                           box_size=int(options["-s"]), border=int(options["-m"]))
        qr.add_data(data)
        qr.make(fit=True)
        image = qr.make_image(fill_color="#" + colours["--foreground"],
                              back_color="#" + colours["--background"])
        image.save(options["-o"])
    except Exception as exc:
        js_log(f"qrencode stand-in failed: {type(exc).__name__}: {exc}")
        return 1
    return 0

def _call(cmd, *args, **kwargs):
    argv = shlex.split(cmd) if isinstance(cmd, str) else list(cmd)
    if argv and argv[0] == "qrencode":
        return _qrencode(argv)
    return 1

subprocess.call = _call
for _name in ("run", "check_call", "check_output", "Popen"):
    setattr(subprocess, _name, _no_such_binary)

# os.popen goes through a shell, and a shell whose command is not found says so
# on stderr and exits 127: whoever reads its stdout reads nothing, and nothing
# is raised. SeedSigner's version helpers count on exactly that when they ask
# git for a branch, tag or commit off a device, and fall back when the answer
# is empty; os.popen on top of the Popen above raised instead, and the firmware
# died on its splash screen.
import io
import os

class _NothingRan(io.StringIO):
    def close(self):
        super().close()
        return 127 << 8        # os.popen's close(): the shell's wait status

def _popen(cmd, mode="r", buffering=-1):
    return _NothingRan("")

os.popen = _popen

# --- fonts for the other languages, fetched when first opened ----------------
# The firmware opens every font through Fonts.get_font, looking in its own fonts
# and then in seedsigner-translations/fonts, where upstream keeps the ones for
# Chinese, Japanese, Korean, Arabic and Thai. Those are some 22MB, so the build
# serves them beside the zip rather than in it (build/build-firmware-zip.sh),
# and the zip's deferred-fonts.json names each with its sha256. The first time
# the firmware asks for one it is fetched, checked against that hash, and put
# where the firmware was going to look; from then on it is an ordinary file.
import hashlib as _hashlib

_FONTS_HOME = "/firmware/seedsigner/resources/seedsigner-translations/fonts"
try:
    with open("/firmware/deferred-fonts.json") as _handle:
        _deferred_fonts = json.load(_handle)
except FileNotFoundError:
    _deferred_fonts = {"dir": None, "fonts": {}}

def _fetch_deferred_font(filename, expected):
    url = f"{_deferred_fonts['dir']}/{filename}"
    data = js_fetch_bytes(url)
    if data is None:
        raise OSError(f"could not fetch the font {url}")
    body = data.to_bytes()
    actual = _hashlib.sha256(body).hexdigest()
    if actual != expected:
        raise OSError(f"{url} is not the font the firmware zip names: "
                      f"sha256 {actual}, expected {expected}")
    os.makedirs(_FONTS_HOME, exist_ok=True)
    with open(os.path.join(_FONTS_HOME, filename), "wb") as handle:
        handle.write(body)
    js_log(f"font fetched: {filename} ({len(body)} bytes, sha256 verified)")

from seedsigner.gui.components import Fonts as _Fonts
_orig_get_font = _Fonts.get_font.__func__
def _get_font(cls, font_name, size, file_extension="ttf"):
    filename = f"{font_name}.{file_extension}"
    expected = _deferred_fonts["fonts"].get(filename)
    if expected and not os.path.exists(os.path.join(_FONTS_HOME, filename)):
        _fetch_deferred_font(filename, expected)
    return _orig_get_font(cls, font_name, size, file_extension)
_Fonts.get_font = classmethod(_get_font)

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
# The firmware blocks here waiting for a press. Here that wait is the green
# threads' turn: the scheduler steps whatever is due and parks on the key buffer
# in between, and a press ends it.
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

# A screen showing a code is deaf for a moment after it opens. Presses aimed at
# the screen before it are still arriving then, and one of them would dismiss a
# transaction before a single frame of it had been read.
import time as _clock

_deaf_until = [0.0]

# When a key was last taken, for has_any_input below.
_key_taken_at = [-1.0]

def _wait_for(self, keys=[]):
    js_log(f'wait_for keys={keys!r}')
    while True:
        browser_threads.idle_until(js_key_pending, wake_on_key=True)
        index = js_peek_key()
        if index < 1 or index >= len(BUTTON_VALUES):
            continue
        _key_taken_at[0] = _clock.monotonic()
        if _clock.monotonic() < _deaf_until[0]:
            js_log(f'key index={index} dropped: the screen is still opening')
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
    # The scan loop polls here once a pass, so it is where the preview gets its turn.
    browser_threads.step_due()
    index = js_peek_key()
    if 1 <= index < len(BUTTON_VALUES):
        _PENDING_KEYS.append([BUTTON_VALUES[index], 0])
        _key_taken_at[0] = _clock.monotonic()

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
HardwareButtons.check_for_low = _check_for_low
# Whether a button is down right now. On hardware that is a read of the GPIO
# pins, and it stays true for as long as a finger is on the key; a toast polls
# it to know when to get out of the way. Here a press is an event, and wait_for
# has usually taken it before the toast next looks, so "down" is a press still
# waiting or one taken in the last moment -- about as long as a press lasts.
_KEY_DOWN_S = 0.3

def _has_any_input(self):
    return bool(js_key_pending()) or _clock.monotonic() - _key_taken_at[0] < _KEY_DOWN_S

HardwareButtons.has_any_input = _has_any_input
HardwareButtons.trigger_override = lambda self, force_release=False: None

# --- the camera, and the QR decode, both come from the page -------------------
import browser_camera
browser_camera.install(js_camera, max(${width}, ${height}))

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
# The press that opened this screen, or one just after it, is still arriving as
# it opens: sitting in the queue check_for_low fills, where a press stays
# claimable for several reads so the scan loop cannot miss it, or still on its
# way from the page. Either would dismiss the code after a single frame, and an
# animated transaction would never get to animate, so the page had nothing to
# read back.
#
# Real hardware cannot do this: a button pressed before a screen exists is not
# waiting for it. So the queue is emptied as the screen opens, and wait_for
# ignores presses for a moment after.
from seedsigner.gui.screens.screen import QRDisplayScreen as _QRScreen
_upstream_qr_run = _QRScreen._run

def _qr_run_from_a_clean_queue(self):
    _PENDING_KEYS.clear()
    while js_peek_key():
        pass
    _deaf_until[0] = _clock.monotonic() + 1.5
    return _upstream_qr_run(self)

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

# --- Persistent Settings, kept by the page --------------------------------------
# Off SeedSigner OS the firmware counts the microSD as always inserted and keeps
# its settings in settings.json in the working directory, which here is memory
# that a reload wipes. So every file the firmware saves is handed to the page to
# keep, and when Persistent Settings is turned off -- the firmware deletes the
# file itself -- the page forgets it too. Only the file the firmware wrote is
# ever sent, and only while the setting is on; nothing is inferred from it.
# The file the firmware loaded at boot is not sent back -- it was read before
# this is installed -- so a panel or network the URL chose for one visit is kept
# only if a setting is then changed during that visit.
def _send_settings_file(text):
    js_settings_file(text)

_orig_save = Settings.save
def _kept_save(self, *args, **kwargs):
    result = _orig_save(self, *args, **kwargs)
    try:
        if (self._data.get(SettingsConstants.SETTING__PERSISTENT_SETTINGS)
                == SettingsConstants.OPTION__ENABLED
                and os.path.exists(Settings.SETTINGS_FILENAME)):
            with open(Settings.SETTINGS_FILENAME) as handle:
                _send_settings_file(handle.read())
    except Exception as exc:
        js_log(f"keeping settings failed: {type(exc).__name__}: {exc}")
    return result
Settings.save = _kept_save

_orig_set_value = Settings.set_value
def _traced_set_value(self, attr_name, value, *args, **kwargs):
    result = _orig_set_value(self, attr_name, value, *args, **kwargs)
    if (attr_name == SettingsConstants.SETTING__PERSISTENT_SETTINGS
            and value == SettingsConstants.OPTION__DISABLED):
        _send_settings_file("")
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
