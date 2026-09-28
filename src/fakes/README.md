# src/fakes

Two packages that exist so an `import` can succeed. Nothing in either of them is
ever called.

Stock SeedSigner reaches for two native libraries at module scope, with no
`try`/`except` around either:

- `seedsigner/hardware/buttons.py` does a bare `import RPi.GPIO as GPIO` and
  then evaluates `GPIO.RPI_INFO['P1_REVISION']` while the module is still being
  imported, to decide between the 26-pin and 40-pin numbering.
- `seedsigner/models/decode_qr.py` does `from pyzbar import pyzbar`. zbar is a C
  library and there is no WebAssembly build of it.

There is no GPIO and no zbar in a browser, and this repository does not patch
the firmware, so the imports have to find something. `/firmware` is first on
`sys.path`, so a package of the right name at the top level of the zip is what
they find.

## Only stand-ins

These are shaped exactly like the module the importer expects and no further,
and if either one is ever reached at runtime, something is wrong:
`browser_display.py` and the worker have replaced every button and panel path
before `RPi.GPIO` could matter, and `browser_camera.py` replaces
`DecodeQR.extract_qr_data`, which is the only function that would have called
`pyzbar.decode`. Both are staged into the firmware zip by the `STAGE_PACKAGES`
rows in `build/build-firmware-zip.sh`.
