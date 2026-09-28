# Third-party components

Almost none of the code that runs in this simulator was written for it. The
firmware is upstream SeedSigner, unmodified. The Python interpreter is Pyodide.
The QR decoder is jsQR. Everything the firmware imports is somebody else's
library, pinned to a version and fetched from its own upstream.

This file lists all of it: what it is, which version or commit, where it comes
from, and under what licence. Anything not listed here was written for this
repository and is covered by this repository's own licence.

Third-party code reaches the browser by exactly three routes, and each one is
checkable in a different way:

| Route | What it is | How to check it |
| --- | --- | --- |
| Committed to this repository | `src/web/jsQR.js`, and nothing else | `sha256sum -c build/checksums.txt` |
| Fetched at deploy time | The Pyodide runtime and the compiled wheels it loads | `./build/fetch-assets.sh --check` |
| Built into `seedsigner-stock.zip` | SeedSigner and its pure-Python dependencies | `./build/build-firmware-zip.sh`, then compare the sha256 |

The third route is the one that matters most, because `seedsigner-stock.zip` is the
code that touches your seed. It is not committed. Build it yourself and compare
the hash to the one being served; if they match, the served file is what this
document says it is.

---

## 1. Committed to this repository

### jsQR 1.4.0, Apache-2.0

* File: `src/web/jsQR.js`
* Source: npm `jsqr@1.4.0`, the file published as `package/dist/jsQR.js`
* sha256: `bc40c8a15196236b2314db0856f72ca0b49980cd5413b8c852a7349f5fee0859`
* Upstream: https://github.com/cozmo/jsQR

Unmodified. Confirm it independently, rather than just against
`build/checksums.txt`:

```
curl -sL https://registry.npmjs.org/jsqr/-/jsqr-1.4.0.tgz \
  | tar xzO package/dist/jsQR.js | sha256sum
```

This is the camera seam. Upstream SeedSigner decodes QR codes with `pyzbar`,
which binds the C library libzbar and therefore cannot exist in this
environment; jsQR does the decoding in JavaScript instead and hands the result
to the firmware through `src/shims/browser_camera.py`.

---

## 2. Fetched by `build/fetch-assets.sh`

### Pyodide 0.26.4, MPL-2.0

* Upstream: https://github.com/pyodide/pyodide
* Artifact: `pyodide-core-0.26.4.tar.bz2` from the 0.26.4 GitHub release
* sha256: `70dba93432f3653155998cc9001f9c200182343c2f95165a2f9e9e4673fa35e8`
* CPython 3.12.1, emscripten 3.1.58, Pyodide ABI `2024_0`

About 26 MB of prebuilt WebAssembly, deliberately not committed.
`fetch-assets.sh` re-reads the `info.version` field of the unpacked
`pyodide-lock.json` and refuses to continue if it disagrees with its pin.

### The packages Pyodide loads at boot

`src/web/worker.js` calls `loadPackage(["Pillow", "pycryptodome"])`. Both
are compiled extensions: they cannot be vendored into the firmware zip, because only
Pyodide can build a CPython extension for emscripten. `fetch-assets.sh` resolves
their dependencies out of `pyodide-lock.json` rather than hardcoding them (at
0.26.4 there are none), and verifies each file against the sha256 recorded there.

| Package | Version | Licence |
| --- | --- | --- |
| Pillow | 10.2.0 | HPND |
| pycryptodome | 3.20.0 | BSD-2-Clause, with parts in the public domain |

pycryptodome is not something SeedSigner asks for. Pyodide's `hashlib` has no
OpenSSL under it and so no `pbkdf2_hmac`, which is the mnemonic-to-seed step;
the worker borrows pycryptodome's PBKDF2 to fill that one hole.

---

## 3. Built into `seedsigner-stock.zip` by `build/build-firmware-zip.sh`

Everything in this section is pure Python and is redistributed inside the firmware
zip. Each one's licence text travels with it, in `licenses/` at the top level of
the zip, alongside a `licenses/MANIFEST.txt` that repeats the table below. The
build script's own dependency table carries the URL and sha256 of every artifact
it fetches.

### The firmware

**SeedSigner, MIT**

* Repository: https://github.com/SeedSigner/seedsigner
* Commit: `e0a80d4b33b8eb7fb1e9fd14a27b7cd11c7d2cd6` (tag `0.8.7`)
* In the zip as: `seedsigner/`, `main.py`, `LICENSE.md`

Verbatim, byte for byte, from `src/seedsigner` and `src/main.py` at that commit.
Nothing in this repository patches it. The pin lives in `UPSTREAM`; the build
script reads it from there and aborts if the checkout lands anywhere else.

To check the copy in a built zip against upstream directly:

```
git clone https://github.com/SeedSigner/seedsigner.git upstream
git -C upstream checkout e0a80d4b33b8eb7fb1e9fd14a27b7cd11c7d2cd6
mkdir extracted && cd extracted && unzip -q ../build/out/seedsigner-stock.zip && cd ..
diff -rq upstream/src/seedsigner extracted/seedsigner
```

### The dependencies

Versions follow upstream's `requirements.txt` at the pinned commit.

| Module in the zip | Distribution | Version | Licence |
| --- | --- | --- | --- |
| `embit` | embit | 0.8.0 | MIT |
| `qrcode` | qrcode | 7.3.1 | BSD-3-Clause |
| `urtypes` | urtypes | 1.0.1 | MIT |

`qrcode`'s licence file is BSD-3-Clause for the package and additionally carries
the MIT notice of `pyqrnative`, which parts of it were forked from.

### Not dependencies: the import stand-ins

The zip also contains `RPi/` and `pyzbar/`, which are `src/fakes/` from this
repository. They are not third-party and they are not RPi.GPIO or pyzbar: they
are empty shapes of those modules, so that SeedSigner's unguarded imports succeed.
Nothing in them is ever called; `src/fakes/README.md` says why.

---

## 4. Pinned by upstream, deliberately not shipped

| Upstream pin | Why it is not in the firmware zip |
| --- | --- |
| `Pillow` | Compiled. Pyodide's build is loaded at boot instead. |
| `pyzbar` | Binds libzbar, which has no WebAssembly build. `src/fakes/pyzbar` lets the import succeed, and jsQR does the decoding. |

Pillow is met at a different version than upstream asks for, because Pyodide
decides: 10.2.0 rather than 10.3.0. There is no way to satisfy that pin in this
environment without building Pyodide from source.

---

## 5. Licence obligations

Everything redistributed is under a permissive licence (MIT, BSD-3-Clause,
Apache-2.0, HPND) except **Pyodide** (MPL-2.0). Under MPL-2.0 the obligation
attaches to the covered files themselves, and those files are shipped verbatim
and unmodified.
