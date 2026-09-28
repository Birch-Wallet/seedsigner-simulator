# Third-party components

Almost none of the code that runs in this simulator was written for it. The
firmware is upstream SeedSigner, its files unmodified. The Python interpreter is
Pyodide. The QR decoder is zxing-wasm, with jsQR as its fallback, and recordings are packed
into MP4 by mp4-muxer. Everything the firmware imports is somebody else's library, pinned to
a version and fetched from its own upstream.

This file lists all of it: what it is, which version or commit, where it comes
from, and under what licence. Anything not listed here was written for this
repository and is covered by this repository's own licence.

The licence texts themselves are in `src/web/licenses/`, which is served next
to the page and linked from its **i** panel, with `NOTICES.txt` as the index.
That directory is for the visitor, who is the one receiving these files; this
document is for someone reading the repository. See section 5.

Third-party code reaches the browser by exactly three routes, and each one is
checkable in a different way:

| Route | What it is | How to check it |
| --- | --- | --- |
| Committed to this repository | `src/web/jsQR.js` and `src/web/mp4-muxer.js`, and nothing else (plus the licence texts in `src/web/licenses/`) | `sha256sum -c build/checksums.txt` |
| Fetched at deploy time | The Pyodide runtime and the compiled wheels it loads, and zxing-wasm | `./build/fetch-assets.sh --check` |
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

This is the camera seam's fallback. Upstream SeedSigner decodes QR codes with
`pyzbar`, which binds the C library libzbar and therefore cannot exist in this
environment; zxing-wasm (section 2) does the decoding in the page instead, and
jsQR does it when zxing-wasm cannot be loaded. Either hands the result to the
firmware through `src/shims/browser_camera.py`.

### mp4-muxer 5.2.2, MIT

* File: `src/web/mp4-muxer.js`
* Source: npm `mp4-muxer@5.2.2`, the file published as `package/build/mp4-muxer.js`
* sha256: `cc4d30bd20b9ffe0b15f59cf0de3e1930626ccd46a5146e36e4d619d7fecf63d`
* Upstream: https://github.com/Vanilagy/mp4-muxer

Unmodified. Confirm it independently, rather than just against
`build/checksums.txt`:

```
curl -sL https://registry.npmjs.org/mp4-muxer/-/mp4-muxer-5.2.2.tgz \
  | tar xzO package/build/mp4-muxer.js | sha256sum
```

Used only by the Record button. The browser encodes H.264 with WebCodecs, and
this writes the encoded frames into an MP4 container, which no browser API does
everywhere (MediaRecorder writes WebM in Firefox). It never sees the firmware or
a key press, only the pixels of frames already on the page.

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

MPL-2.0 is Pyodide's own licence, not the licence of everything in the
runtime. CPython 3.12.1 is compiled into it and `python_stdlib.zip` is
CPython's standard library, both under the **PSF-2.0** licence.

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

Pyodide's Pillow wheel is not only Pillow. Its extension modules have C
libraries compiled into them, per Pyodide's build recipe
(`packages/Pillow/meta.yaml` at 0.26.4) and the emscripten 3.1.58 ports it
uses. The wheel's own `LICENSE` covers Pillow alone:

| Compiled into Pillow | Version | Licence |
| --- | --- | --- |
| libjpeg (IJG) | 9c | IJG licence, which asks binary distributions to credit the Independent JPEG Group |
| libtiff | 4.4.0 | libtiff licence |
| libwebp | 1.2.2 | BSD-3-Clause, plus a patent grant |
| FreeType | emscripten port | FreeType License (FTL), which asks for credit in the documentation |
| zlib | emscripten port | zlib licence |

pycryptodome is not something SeedSigner asks for. Pyodide's `hashlib` has no
OpenSSL under it and so no `pbkdf2_hmac`, which is the mnemonic-to-seed step;
the worker borrows pycryptodome's PBKDF2 to fill that one hole.

### zxing-wasm 3.1.4, MIT, with zxing-cpp under Apache-2.0

* Upstream: https://github.com/Sec-ant/zxing-wasm
* Artifact: npm `zxing-wasm@3.1.4`
  (`https://registry.npmjs.org/zxing-wasm/-/zxing-wasm-3.1.4.tgz`)
* sha256: `2416232a155533bdcfa098a22ec9087734b34640ffa2a7add90bc36e145f6da0`
* Files: `package/dist/iife/reader/index.js` and
  `package/dist/reader/zxing_reader.wasm`, served unmodified from
  `src/web/zxing-2416232a/`
* Compiled from zxing-cpp at commit `0b2d9a8fc81f420f369928c24331091ff0525976`

The page's QR decoder, in every browser. jsQR is what it falls back to if this
is missing, with the browser's own `BarcodeDetector` pointing it at the QR where
there is one. About 1 MB, so fetched rather than committed, for the same reason
as Pyodide. `fetch-assets.sh` checks the tarball before reading anything out of
it, and each of the two files against its own pinned hash afterwards. Confirm
the tarball independently:

```
curl -sL https://registry.npmjs.org/zxing-wasm/-/zxing-wasm-3.1.4.tgz | sha256sum
```

zxing-wasm's JavaScript is MIT. The `.wasm` is zxing-cpp plus zxing-wasm's own
C++ bindings, both **Apache-2.0**, and neither has a `NOTICE` file. The reader
build does not include zint, which only the writer build uses.

---

## 3. Built into `seedsigner-stock.zip` by `build/build-firmware-zip.sh`

Everything in this section is redistributed inside the firmware zip. It is
Python, plus fonts, images and a few native binaries that come with it (below).
Each package's licence text travels with it, in `licenses/` at the top level of
the zip, alongside a `licenses/MANIFEST.txt` that repeats the table below. The
build script's own dependency table carries the URL and sha256 of every artifact
it fetches.

### The firmware

**SeedSigner, MIT**

* Repository: https://github.com/SeedSigner/seedsigner
* Commit: `e0a80d4b33b8eb7fb1e9fd14a27b7cd11c7d2cd6` (tag `0.8.7`)
* In the zip as: `seedsigner/`, `main.py`, `LICENSE.md`

Verbatim, byte for byte, from `src/seedsigner` and `src/main.py` at that commit.
Nothing in this repository edits these files; this repository's changes are made
at runtime, from `src/web/worker.js`, `src/shims/` and `src/fakes/`. The deepest
of these is `src/shims/browser_threads.py`, which recompiles the `run()` method
of SeedSigner's animation threads into generators, in memory, so that they can
run without real threads. The files on disk stay as they are, but that code
does not run exactly as written. The pin lives in `UPSTREAM`; the build script
reads it from there and aborts if the checkout lands anywhere else.

SeedSigner's tree is not all under SeedSigner's own MIT licence:

| In the tree | Licence | Licence text |
| --- | --- | --- |
| `seedsigner/helpers/ur2/` | BSD-2-Clause-Patent (Foundation Devices, Inc.) | `seedsigner/helpers/ur2/LICENSE`, in the zip |
| `resources/fonts/Inconsolata-*.ttf` | OFL-1.1 | licence named in the font's metadata only; text in `src/web/licenses/OFL-1.1.txt` |
| `resources/fonts/NotoSansDevanagari-Regular.ttf` | OFL-1.1 | as above |
| `resources/fonts/Font_Awesome_6_Free-Solid-900.otf` | OFL-1.1 (Font Awesome Free's licence for its font files) | none in the font or the zip; `src/web/licenses/OFL-1.1.txt` and `FontAwesome.txt` |
| `resources/fonts/OpenSans-*.ttf` | Apache-2.0 | named in the font's metadata; text in `src/web/licenses/Apache-2.0.txt` |
| `resources/fonts/seedsigner-icons.otf` | SeedSigner's own | SeedSigner's `LICENSE.md` |

The fonts' licence texts are served from `src/web/licenses/` rather than added
to the zip, because the zip holds the upstream tree verbatim and adding a file
would change its published hash.

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
`urtypes/cbor/` carries its own MIT notice, `urtypes/cbor/COPYING`, with its
own copyright holders.

`embit` 0.8.0 as published includes `embit/util/prebuilt/`: seven native
builds of libsecp256k1 (from the secp256k1-zkp fork, MIT), for desktop and
Raspberry Pi platforms. A browser cannot load them, so embit falls back to its
pure-Python implementation. They are in the zip only because the build unpacks
embit's sources as published and removes nothing. Their licence is not in
embit's `LICENSE`; it is served as `src/web/licenses/secp256k1-zkp.txt`.

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
| `pyzbar` | Binds libzbar, which has no WebAssembly build. `src/fakes/pyzbar` lets the import succeed, and zxing-wasm, or jsQR as its fallback, does the decoding. |

Pillow is met at a different version than upstream asks for, because Pyodide
decides: 10.2.0 rather than 10.3.0. There is no way to satisfy that pin in this
environment without building Pyodide from source.

---

## 5. Licence obligations

Everything redistributed is under a permissive licence (MIT, BSD-2-Clause,
BSD-2-Clause-Patent, BSD-3-Clause, Apache-2.0, HPND, PSF-2.0, OFL-1.1, and the
IJG, libtiff, FreeType and zlib licences) except **Pyodide** (MPL-2.0), which
is a weak copyleft licence that applies file by file.

Almost all of these licences have the same condition: whoever receives a copy
gets the copyright notice and the licence text with it. For a website, the
person receiving the files is the visitor, not someone reading this
repository. So the texts are served from `src/web/licenses/` next to the page,
with `NOTICES.txt` as the index, and the page's **i** panel links to it. Three
cases matter most:

* **jsQR** (Apache-2.0 §4(a)), **zxing-wasm** (MIT, with zxing-cpp under
  Apache-2.0 inside its `.wasm`) and **mp4-muxer** (MIT) are minified files
  or compiled binaries with no licence header, so the served licence texts
  are the only notice they have.
* **Pyodide** (MPL-2.0 §3.2) is served in Executable Form. That is allowed as
  long as the recipient is told where to get the Source Code Form, and
  `NOTICES.txt` says where. The files are unmodified, so no source of our own
  has to be published.
* **FreeType** and **libjpeg** ask for credit in the documentation of anything
  that ships them in binary form; `NOTICES.txt` gives it.

Anyone self-hosting the simulator needs to serve `licenses/` along with the
rest of `src/web/`; `docs/SELF-HOSTING.md` says so. When a component changes,
update its text there, not just the tables in this file.
