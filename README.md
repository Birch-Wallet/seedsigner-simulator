# SeedSigner Web Simulator

Real [SeedSigner](https://seedsigner.com) firmware, the actual Python off the
device, running in a browser tab. The screen is a canvas, the buttons are your
keyboard, the camera is your webcam.

It runs stock SeedSigner **0.8.7**, exactly as the SeedSigner project publishes
it, and nothing else. Or, if you choose it, one pinned commit of SeedSigner's
**development branch**: what the project has merged since that release.

Forked from [bitsagarob/seedsigner-simulator](https://github.com/bitsagarob/seedsigner-simulator),
cut down to stock SeedSigner alone, and extended:

- **Two firmwares.** The 0.8.7 release by default, or the development branch
  pinned at one commit (`dev-cfaf443`), chosen from the device panel or with
  `?firmware=dev`. Each is its own reproducible zip with published hashes.
- **Two devices.** The SeedSigner Plus at 320×240, or the original Waveshare
  1.3" hat at 240×240, switchable from the page.
- **Animation.** The firmware's own animation threads run: the spinner, pulsing
  warning edges, scrolling labels, the PSBT overview, animated QRs and the camera
  preview. Toast threads are supported too, though stock firmware only raises
  microSD toasts, which never appear here.
- **Every language.** All 21 of SeedSigner's translations, from Settings >
  Language, with the fonts Chinese, Japanese, Korean, Arabic and Thai need
  fetched the first time they are drawn.
- **Persistent Settings.** The firmware's own setting: on, your settings are
  kept in this browser across reloads; off, the saved copy is erased.
- **Recording.** An MP4 of the session, the screen alone or the whole device
  centred on a dark or light background, made in the browser.
- **Mobile first.** One control bar under the device, landscape on phones with a
  prompt to turn when held upright, and fullscreen for thumb-sized keys.
- **Fixes.** QR brightness now works on the QR screens, and every QR is drawn
  sharp, as on the device.
- **Hosted** at [seedsigner.birchwallet.app](https://seedsigner.birchwallet.app),
  with a link preview for sharing.

> ### Insecure by design
>
> **Never type in a seed phrase you rely on.** Use a published test seed.
>
> Nothing makes this safe: not running it offline, not a private window, not a
> clean laptop. See [below](#why-it-cannot-be-made-safe).

![The simulator running the firmware's home screen](docs/img/device.png)

![The same home screen on the original 240×240 build](docs/img/device-240x240.png)

## Why it cannot be made safe

A SeedSigner is a signing device because of what surrounds the software. None of
that is here. Only the software is.

| A real SeedSigner | This page |
| --- | --- |
| No wifi, no bluetooth, no port | A computer that has all three |
| Runs one program and nothing else | Runs beside extensions, other tabs, devtools, every process on the machine |
| Loses everything at power-off | A JavaScript heap, copied by the garbage collector into swap and hibernation files |
| A screen only you see | A canvas any script or screen recorder can read |

**Offline does not help.** It changes one row and leaves the rest. The seed is
still typed into a general-purpose computer with an OS, a clipboard, a swap file
and a network connection it will use again later.

**Mainnet works, which is the dangerous part.** The page boots on Testnet, but
Mainnet is still in Settings, deriving real keys and signing real transactions
(`test/test_mainnet.py` checks them against BIP32, BIP143 and ECDSA). Treat
everything it shows you as public: seeds, passphrases, xpubs, descriptors,
signatures.

**If you already entered a real seed here**, treat it as compromised and move the
funds to a new seed generated on a device you trust. The simulator transmits
nothing and stores nothing, except your settings in this browser if you turn on
Persistent Settings (never a seed: the firmware's settings file holds none). But
it ran in a browser on a networked machine, alongside every extension and every
other tab. Do not weigh the odds; just move.

Good for learning the menus, rehearsing a flow, or testing screens. Anything
involving money belongs on hardware.

## Try it

```sh
git clone https://github.com/newtonick/seedsigner-simulator.git
cd seedsigner-simulator
./build/fetch-assets.sh          # Pyodide and zxing-wasm, pinned and hash-checked (~27 MB, once)
./build/build-firmware-zip.sh      # seedsigner-stock.zip, from the pinned release
./build/build-firmware-zip.sh dev  # seedsigner-dev.zip, from the pinned dev commit (optional)
python3 test/serve.py --port 8770 src/web src/shims build/out
```

Then open <http://127.0.0.1:8770/>. Use `test/serve.py`, not
`python3 -m http.server`: without the two isolation headers it sends, the firmware
never starts. Nothing fetched is committed, so what you run is provably the
pinned commit, and both steps verify what they download.

Arrow keys move, Enter selects, `1` `2` `3` are the side buttons, and the drawn
buttons work too. The screen is not one of them: a SeedSigner has no touchscreen.

The development branch is pinned too, at one commit in the `[dev]` section of
[`UPSTREAM`](UPSTREAM), so its zip can be rebuilt and checked like the
release's. To move it to the branch's current tip:

```sh
./build/bump-dev.sh
```

That checks dev's dependencies against the build's table first (and stops if
they have changed), then moves the pin, builds it twice, and publishes the new
hashes in `UPSTREAM`. Run the tests against it (`SIM_FIRMWARE=dev python3
test/run.py`) and commit.

To run your own fork of SeedSigner, override the pin for one build:

```sh
SS_REPO=https://github.com/you/seedsigner.git SS_COMMIT=my-branch ./build/build-firmware-zip.sh
```

Either variable works on its own. The resulting zip will not hash to the
published one, correctly: the build says `THIS IS NOT THE PUBLISHED BUILD`, and
the page's **i** panel reports that the loaded zip is not the published build. If
your fork changed its dependencies, the table in `build/build-firmware-zip.sh`
needs editing too.

## What you can verify

- **It is the firmware, not a re-creation.** `seedsigner-stock.zip` (and `seedsigner-dev.zip`) holds SeedSigner's
  upstream Python tree and its own `Controller.start()` runs it. Menus, seed
  handling, PSBT parsing, QR encoders, translations: all theirs, the translations
  at the commit upstream's own tree pins for them.
- **SeedSigner's own files are unmodified.** Everything this port changes happens
  at runtime, in [`worker.js`](src/web/worker.js), [`src/shims/`](src/shims) and
  [`src/fakes/`](src/fakes). That code runs with full access to the firmware and
  to any seed you enter. Testnet-at-boot is a value in the `settings.json` the
  device reads, not a code change.
- **Pinned to a release tag, not a branch tip** ([`UPSTREAM`](UPSTREAM)). The
  development branch is the exception you choose: pinned to one commit, not
  followed, and moved only on purpose.
- **Rebuild and compare.** `build/build-firmware-zip.sh` (and `... dev`) reproduces
  each zip byte for byte, and CI re-derives both sets of hashes on every push on a
  clean runner.
- **Upstream's own tests run against our pins**
  ([`upstream-tests.yml`](.github/workflows/upstream-tests.yml)).
- **The webcam really is the camera.** Same `DecodeQR`, same SeedQR /
  CompactSeedQR / PSBT / UR parsing; only the decoder is the browser's.
- **One host, no network.** No backend, and the page's CSP allows it to connect
  to nothing but its own origin.

## What works, and what does not

**Works.** The full menu tree, seed loading by QR or by hand, passphrases, xpub
export, PSBT signing, SeedQR backup, settings, every language, every QR
screen. Persistent Settings keeps your settings in this browser, as a device
keeps them on its microSD card, and turning it off erases them. Both screens the
firmware drives: the SeedSigner Plus at 320×240, or the original Waveshare hat at
240×240 (the device button, or `?display=240x240`).
Recording saves an MP4 of the session: the screen alone at twice its own
size, or the whole device centred on a dark or light background
(`?recbg=light`). Either way the LCD is pixel perfect, each of its pixels a
square block of video pixels. It is
composed from the firmware's frames in the browser, so the pointer is never in it.

Every control sits in one bar under the device: device, record, recording
settings, and on a phone, fullscreen. A phone is landscape-first: held upright,
it shows a prompt to turn it sideways while the firmware starts up behind it;
fullscreen gives the device the whole screen for the biggest keys.

The firmware's own animation threads run too: the spinner, pulsing warning
edges, scrolling labels, the PSBT overview's animation, animated QRs and the
camera preview, each taking turns with the firmware on a single thread. Toast
threads run the same way and close on a key press, though stock firmware only
raises the microSD toasts, so none appear here.

**Does not.** No microSD beyond the settings above, so firmware update is gone
and no toast is ever shown. The spinner holds still through a single long computation, such as
the PBKDF2 that turns a mnemonic into a seed, then carries on. No timing, so no wipe timer,
screensaver or battery reading.

## How it works

The firmware's Python runs under [Pyodide](https://pyodide.org) (CPython on
WebAssembly) in a Web Worker. Three hardware seams are replaced.

| Seam | Replaced by | Why |
| --- | --- | --- |
| Display | [`browser_display.py`](src/shims/browser_display.py) | Swaps the panel driver under SeedSigner's unmodified `Renderer`; RGB frames go to a canvas. |
| Buttons | [`worker.js`](src/web/worker.js) | The worker is blocked in the firmware's main loop and can never answer a `postMessage`, so keys cross on a `SharedArrayBuffer`. |
| Camera + QR | [`browser_camera.py`](src/shims/browser_camera.py) + [`camera.js`](src/web/camera.js) | pyzbar has no WebAssembly build, so the browser decodes and hands bytes to the unmodified decoder. |

A fourth, [`browser_threads.py`](src/shims/browser_threads.py), runs SeedSigner's
animation threads, which this single-threaded environment cannot run as threads:
each one's `run()` is rewritten in memory into a generator that pauses where the
thread already sleeps, and they take turns with the firmware.

That one constraint, a permanently blocked worker, explains most of the
architecture. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) is the long version,
including why `BarcodeDetector` is never trusted with a payload.

## Self-hosting

Static files, with two requirements that trip up every first attempt
([docs/SELF-HOSTING.md](docs/SELF-HOSTING.md)):

1. `Cross-Origin-Opener-Policy: same-origin` and
   `Cross-Origin-Embedder-Policy: require-corp` are mandatory, or
   `SharedArrayBuffer` does not exist and the firmware never starts.
2. The page must be a secure context: `https`, or `localhost`. Browsers ignore
   those headers on plain `http` to any other address (a LAN or Tailscale IP, for
   instance), so the firmware cannot start there, and there is no camera either.

## Development

`python3 test/run.py` builds what is missing and runs everything in a real
browser (it needs `pip install playwright && playwright install chromium`).
[test/README.md](test/README.md) says what each test proves, and `?debug=1` traces
every screen, thread and keypress to the console.

Two rules keep the "it is the real firmware" claim true:

- **Do not edit the firmware's files.** `seedsigner-stock.zip` and
  `seedsigner-dev.zip` are the upstream tree at their pinned commits. If SeedSigner reaches for something a browser does not
  have, replace it at runtime, in a shim under `src/shims/` or the worker, with a
  comment saying what it stands in for. That is still code with full access to the
  firmware, so keep it small and easy to read: it is what a reviewer has to read.
  To move the release to a newer SeedSigner, change `[stock]` in `UPSTREAM` and
  rebuild; to move the development branch, run `./build/bump-dev.sh`.
- **Keep the manifest in step.** `build/checksums.txt` hashes every file that is
  served or packaged as it stands. Change one and run `./build/update-checksums.sh`,
  then commit the manifest with it. `git config core.hooksPath build/hooks`
  installs a hook that refuses a commit where the two disagree.

## Licence and credits

MIT, see [LICENSE](LICENSE). Almost none of this code was written here: the
firmware is upstream [SeedSigner](https://github.com/SeedSigner/seedsigner) (MIT,
Copyright (c) 2021 SeedSigner), and the browser side rests on
[Pyodide](https://pyodide.org), [jsQR](https://github.com/cozmo/jsQR),
[zxing-wasm](https://github.com/Sec-ant/zxing-wasm) and
[mp4-muxer](https://github.com/Vanilagy/mp4-muxer).
[THIRD-PARTY.md](THIRD-PARTY.md) lists every dependency and how to check it.

Independent project, not affiliated with or endorsed by SeedSigner. Running it
proves nothing about a real device.
