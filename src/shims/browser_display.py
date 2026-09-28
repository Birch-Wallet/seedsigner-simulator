"""
A SeedSigner display driver that draws to a browser canvas.

Hands raw RGB bytes to JavaScript instead of pushing them to a panel over SPI. Everything above it,
the Renderer and every screen, is unmodified SeedSigner.
"""

import time
from dataclasses import dataclass

from PIL import Image

from seedsigner.hardware.displays.display_driver import BaseDisplayDriver


@dataclass
class BrowserDisplay(BaseDisplayDriver):
    """
    `_width` and `_height` come from BaseDisplayDriver and describe the emulated
    panel. `sink` is a callback supplied by the worker that forwards a frame to
    the page.
    """

    sink: object = None

    # Minimum time a frame stays up: roughly a Pi Zero's render plus SPI transfer.
    MIN_FRAME_SECONDS = 0.08

    def __post_init__(self):
        self.buffer = Image.new("RGB", (self.width, self.height))
        self.inverted = False
        self._last_frame_at = 0.0

    def invert(self, enabled: bool = True):
        # The real panel inverts in hardware; there is nothing to do here, and
        # the colours already arrive the right way round.
        self.inverted = enabled

    def show_image(self, image: Image.Image, x_start: int = 0, y_start: int = 0):
        if image.size != (self.width, self.height):
            image = image.resize((self.width, self.height))
        if image.mode != "RGB":
            image = image.convert("RGB")

        self.buffer = image
        if self.sink is not None:
            # Hold the previous frame until the panel could have drawn the next.
            wait = self._last_frame_at + self.MIN_FRAME_SECONDS - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            self.sink(image.tobytes())
            self._last_frame_at = time.monotonic()

    def ShowImage(self, image, x_start: int = 0, y_start: int = 0):
        """Some drivers in this codebase use the capitalised spelling."""
        self.show_image(image, x_start, y_start)

    def clear(self):
        self.show_image(Image.new("RGB", (self.width, self.height)))

    def cleanup(self):
        pass


def install(sink, width: int, height: int) -> None:
    """
    Make the factory hand back a BrowserDisplay whatever the configured display
    type is, so the firmware's own settings do not have to be touched.
    """
    from seedsigner.hardware.displays import display_driver

    def instantiate(cls, display_type=None, width=width, height=height):
        return BrowserDisplay(_width=width, _height=height, sink=sink)

    display_driver.DisplayDriverFactory.instantiate_display_driver = classmethod(instantiate)
