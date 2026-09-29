"""
A SeedSigner camera whose frames and QR payloads both come from the browser.

SeedSigner reads QR codes with pyzbar, a binding to the zbar C library, and there
is no zbar in WASM. Porting it is not the answer, because the page already decodes
QR codes -- with zxing-wasm, or jsQR if that cannot be loaded -- and it already
owns the camera through getUserMedia. So the fake sits at the two
places where SeedSigner reaches for hardware, the video stream and the decode, and
everything above them runs unmodified: ScanScreen, DecodeQR's parsing of SeedQR,
CompactSeedQR, PSBT and UR payloads, and every view that consumes them.

The page, not this module, holds the camera. The worker thread is permanently
blocked inside the controller's main loop and can never service a postMessage, so
a SharedArrayBuffer is the only channel that works here -- the same reason the
buttons already use one. The page writes frames and decoded payloads into it; the
calls below read them out synchronously, which is what SeedSigner's blocking scan
loop expects.

Frames and payloads are deliberately not tied to each other. extract_qr_data()
ignores the image it is handed and reports whatever the page decoded most
recently, because the decode ran in JavaScript against the page's own copy of the
frame. The image that arrives here matters only for the preview.

The preview is SeedSigner's own LivePreviewThread, run as a green thread (see
browser_threads.py). It reads the stream the way the device's preview does:
the latest frame, whenever it gets a turn, without taking it from the decode
loop that is reading the same stream.
"""

from PIL import Image

import browser_threads

from seedsigner.hardware.camera import Camera, CameraConnectionError
from seedsigner.models.decode_qr import DecodeQR

# The bridge into the page, supplied by install(). Five calls:
# start(timeout_ms, side), stop(), frame(timeout_ms), peekFrame(since_seq) and
# payload().
_js = None

# The screen's longer side, supplied by install(): no preview frame is published
# larger than the screen it is drawn on.
_screen_side = 320

# The last frame the preview drew, so it only draws a frame once.
_preview_seq = [0]

# How long a frame read parks before giving up and letting the scan loop go round
# again. Long enough not to spin, short enough that stopping the camera is not
# noticeably delayed.
_FRAME_WAIT_MS = 2000

# Long enough to cover a getUserMedia permission prompt. The worker is parked for
# this whole time, which is harmless: the page's own thread is what draws the
# prompt and it stays free.
_START_WAIT_MS = 30000


def _to_bytes(js_array):
    """Copy a JS Uint8Array into Python bytes."""
    to_py = getattr(js_array, "to_py", None)
    return bytes(to_py()) if to_py is not None else bytes(js_array)


class _BrowserVideoStream:
    """
    Stands in for pivideostream.VideoStream.

    Nothing is read through it -- frames come over the SharedArrayBuffer -- but
    ScanScreen watches `camera._video_stream` to decide whether the camera is
    still live, so the attribute has to hold something and then become None.
    """

    def stop(self):
        pass


def _start_video_stream_mode(self, resolution=(512, 384), framerate=12, format="bgr"):
    """
    Ask the page for the camera and wait until it is actually delivering frames.

    `framerate` and `format` are the caller's preferences for a sensor this
    process does not own; getUserMedia negotiates its own. `resolution` is kept:
    the page publishes the square the caller asked for, capped at the screen and
    cropped from the middle of the stream rather than squeezed. Failing to open
    the camera raises CameraConnectionError, which is the same error the picamera
    backend raises and which SeedSigner already routes to CameraConnectionErrorView.
    """
    if self._video_stream is not None:
        self.stop_video_stream_mode()

    error = _js.start(_START_WAIT_MS, _preview_side(resolution))
    if error:
        raise CameraConnectionError(str(error))

    self._video_stream = _BrowserVideoStream()


def _read_video_stream(self, as_image=False):
    """
    Return the most recent camera frame.

    The decode loop, on the main stack, parks until a frame it has not seen
    arrives: blocking here is what paces SeedSigner's scan loop, which would
    otherwise spin against a still image as fast as Python can run. The live
    preview, a green thread, must never park -- nothing else runs while it
    does -- so it gets the newest frame it has not drawn yet, or None, which its
    loop already expects.
    """
    if self._video_stream is None:
        raise Exception("Must call start_video_stream_mode first.")

    if not browser_threads.on_main():
        frame = _js.peekFrame(_preview_seq[0])
        if frame is None:
            return None
        _preview_seq[0] = frame.seq
    else:
        # The preview's turn, before parking for the next frame.
        browser_threads.step_due()
        frame = _js.frame(_FRAME_WAIT_MS)
    if frame is None:
        return None

    image = Image.frombytes("RGB", (frame.w, frame.h), _to_bytes(frame.bytes))

    # The real camera rotates by 90 degrees to undo how the sensor is mounted in
    # the case, plus whatever the user set. A getUserMedia stream arrives upright.
    return image


def _stop_video_stream_mode(self):
    if self._video_stream is not None:
        self._video_stream.stop()
        self._video_stream = None
    _js.stop()


class _BrowserSingleFrame:
    """
    Stands in for the PiCamera object single-frame mode holds.

    Nothing is read through it, the same as the video stream above: the frame
    comes over the SharedArrayBuffer. But Camera uses `_picamera` to know
    whether the mode is open, and capture_frame's own guard reads it, so it has
    to hold something and then become None.
    """

    def close(self):
        pass


def _start_single_frame_mode(self, resolution=(720, 480)):
    """
    Open the camera for a still, rather than for a stream.

    This is the other half of the hardware camera and it was missing, which is
    why "new seed from a photo" died on `No module named 'picamera'`: stock
    reaches for the single-frame API there and for the video stream nowhere
    near it, so patching only the stream left the whole flow on the real
    picamera import.

    `resolution` is handled exactly as in the stream case: the page publishes
    the square asked for, capped at the screen.
    """
    if self._video_stream is not None:
        self.stop_video_stream_mode()
    if self._picamera is not None:
        self.stop_single_frame_mode()

    error = _js.start(_START_WAIT_MS, _preview_side(resolution))
    if error:
        raise CameraConnectionError(str(error))

    self._picamera = _BrowserSingleFrame()


def _capture_frame(self):
    """
    One frame, as a PIL image, from the stream the page is already publishing.

    The real one sets the exposure and white balance manually, takes a JPEG and
    rotates it by 90 degrees plus the user's setting. None of that applies: the
    browser owns the exposure, there is no JPEG in the middle, and a
    getUserMedia stream arrives upright, which is the same reason
    read_video_stream does not rotate either.

    It is the published preview frame, so it is capped at the screen's size
    rather than the full resolution asked for. What this image is used for is entropy -- it is
    hashed, and the sensor noise in it is the point -- and a quarter-megapixel
    of real camera output has far more of that than a seed needs. It is also
    what the visitor is shown, at a size the screen would have scaled it to
    anyway.
    """
    if self._picamera is None:
        raise Exception("Must call start_single_frame_mode first.")

    frame = _js.frame(_FRAME_WAIT_MS)
    if frame is None:
        raise CameraConnectionError("the camera did not deliver a frame")

    return Image.frombytes("RGB", (frame.w, frame.h), _to_bytes(frame.bytes))


def _stop_single_frame_mode(self):
    if self._picamera is not None:
        self._picamera.close()
        self._picamera = None
    _js.stop()


def _extract_qr_data(image, is_binary: bool = False):
    """
    Report the payload the page has decoded, or None.

    The image is ignored: this is the pyzbar call, and the decode it stands in for
    has already happened in JavaScript. Payloads are returned as bytes exactly as
    pyzbar returns them, so CompactSeedQR's raw entropy survives the trip
    unmangled and DecodeQR's own type detection is what decides what it is.

    Each payload is handed over once. The page will not publish another until this
    one has been claimed, so a QR held in front of the camera does not flood the
    decoder with repeats of itself.
    """
    payload = _js.payload()
    return None if payload is None else _to_bytes(payload)


def _preview_side(resolution):
    """
    The square the page publishes for a camera opened at `resolution`.

    The firmware asks for the size it will crop from: the new-seed preview asks
    for a square as big as the screen's longer side and crops its middle to the
    screen, taking for granted that what it asked for is what arrives. A smaller
    square cropped that way is a strip down the left of the screen. Scan resizes
    whatever it gets, so for it the size is only cost, and it is capped at the
    screen like everything else.
    """
    try:
        asked = max(int(v) for v in resolution)
    except (TypeError, ValueError):
        return 0
    return max(1, min(asked, _screen_side))


def install(js_camera, screen_side=320):
    """
    Point SeedSigner's camera and QR decode at the page.

    `js_camera` is the worker's bridge object. Patching the methods rather than
    the class keeps Camera's own singleton and its settings handling, which read
    camera rotation and device index and work fine as they are. `screen_side`
    is the screen's longer side, the largest preview worth publishing.
    """
    global _js, _screen_side
    _js = js_camera
    _screen_side = int(screen_side)

    Camera.start_video_stream_mode = _start_video_stream_mode
    Camera.read_video_stream = _read_video_stream
    Camera.stop_video_stream_mode = _stop_video_stream_mode

    # The still half. The image-entropy flow and the QR brightness setting are
    # the callers.
    Camera.start_single_frame_mode = _start_single_frame_mode
    Camera.capture_frame = _capture_frame
    Camera.stop_single_frame_mode = _stop_single_frame_mode

    DecodeQR.extract_qr_data = staticmethod(_extract_qr_data)

    # Without this ScanView bails to "QR Scanner Unavailable" before it ever opens
    # the camera, because it probes for zbar and OpenCV and this build has neither.
    DecodeQR.is_qr_scanner_available = staticmethod(lambda: True)

