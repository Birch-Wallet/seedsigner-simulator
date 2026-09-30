# Tests

The simulator runs stock SeedSigner firmware under Pyodide, its files unmodified,
with its hardware seams faked at runtime from outside them. These tests exist to check the seams,
because that is where a browser port can quietly start lying: a camera that
reports a QR nobody held up, a key that never arrives.

Everything here reads the firmware's own log as its oracle. The firmware narrates
every screen it puts up (`display() enter: SeedFinalizeScreen`) and the camera
says which decoder it chose. Asserting on those lines is a statement about what
the firmware actually did; a screenshot is not. That narration only happens when
the page is loaded with `?debug=1`, which is why every URL the tests build
carries it.

## Running them

Prerequisites:

    pip install playwright
    playwright install chromium

Then, from a fresh clone:

    python3 test/run.py

That builds what is missing, generates the QR videos, starts a server, runs
everything against it, and stops the server afterwards. The first run also
downloads the Pyodide runtime and builds the firmware zip from its pinned upstream
commit, which takes a few minutes; later runs reuse all of it.

A subset, by substring on the step name -- the names are `leak_scan`, `worker_csp`, `device`, `record`, `threads`, `toasts`,
`build_info`, `firmware_choice`, `settings`, `persistent_settings`, `languages`, `scan_seedqr`, `scan_compact`, `scan_jsqr`, `scan_native`,
`camera_stall`, `passphrase`, `image_entropy`, `mainnet`:

    python3 test/run.py scan          # everything with "scan" in the name
    python3 test/run.py leak          # just the leak scanner

The whole suite runs against the release unless told otherwise; any other
firmware `UPSTREAM` pins gets the same suite with

    SIM_FIRMWARE=dev python3 test/run.py
    SIM_FIRMWARE=pr-995 python3 test/run.py build_info firmware_choice settings scan_seedqr mainnet

CI runs every section: the full suite for stock and dev, and for each pinned pull
request a smoke run that is allowed to fail, since a pull request breaking here
is news about the pull request. `build_info` and `firmware_choice` look at every
firmware in `build/out/firmwares.json` either way, so they want the zips built
(`./build/build-firmware-zip.sh <name>` for each).

Individual files run on their own too, against a server you start yourself:

    python3 test/serve.py --port 8770 src/web src/shims build/out &
    python3 test/make_qr_y4m.py
    python3 test/test_scan.py

Screenshots land in `test/artifacts/`. Most are taken only when something
fails. The QR videos land there too. `run.py` deletes them afterwards because
they are large and regenerate in seconds; set `SIM_KEEP_VIDEOS=1` to keep them.

| variable | default | what it does |
| --- | --- | --- |
| `SIM_PORT` | `8770` | port the test server listens on |
| `SIM_URL` | `http://127.0.0.1:$SIM_PORT` | where the tests look for the simulator |
| `SIM_ARTIFACT_DIR` | `test/artifacts` | screenshots and videos |
| `SIM_ASSETS` | `build/out`, `src/web` | where the firmware zips and the Pyodide runtime are |
| `SIM_FIRMWARE` | `stock` | which firmware the suite runs: `stock`, the release; `dev`, the development-branch pin; or `pr-<N>`, a pinned pull request. Anything but stock adds `?firmware=<name>` to every page the tests open |
| `QR_KIND` | `qr` | which QR `test_scan.py` holds up: `qr` or `qr-compact` |
| `SCAN_DECODER` | `zxing-wasm` | which decoder `test_scan.py` requires the page to pick: `zxing-wasm`, or `jsQR`, for which every request for zxing-wasm is refused and `BarcodeDetector` removed |

`SIM_URL` is the useful one: point it at a deployed copy and the same tests prove
the page that is actually serving people decodes a QR, rather than that its files
return 200.

## What each test proves

**`leak_scan.py`**: no tracked file names the author's infrastructure: no
private or CGNAT address, no absolute home directory, no hostname that resolves
only on one LAN. A public repository should not publish its author's server
layout, and a human checking that once does not scale to every future commit.
Public URLs are deliberately untouched. The allowlist is at the top of the file
and every entry says why it is there.

**`test_device.py`**: the device art as a control, and the page laid out for a
phone. None of it needs the firmware, so this file costs seconds.

The screen is not a button. It used to be the select key, on the grounds that it
is the biggest target on the shell, and on a phone that meant a tap anywhere on
the home menu opened the camera. A SeedSigner has no touchscreen, so neither has
this. The proof is a second device rendered on the page with an `onKey` that only
counts, driven by real touch events through the DevTools protocol: a tap on the
screen counts nothing, a tap on a key counts exactly one -- not two, which is
what a device answering both the pointer event and the mouse event the browser
synthesises afterwards would count -- a finger held for two seconds still counts
one, because a hardware button does not repeat, and two fingers landing together
count one.

The 240x240 hat gets the same treatment: the same eight keys, each tap exactly
one press of its own key, and its square screen no control either.

Then the page on a phone, which is landscape-first. Held upright, the simulator
is hidden behind a prompt to turn the phone, and the prompt still carries the
never-enter-a-real-seed warning. Turned sideways, the prompt goes, turning is not
taken as a request for fullscreen, the title and the warning are put away so the
device gets the height, the i floats in the top right corner clear of the device
and still opens and warns, device and control bar fit on one screen without
scrolling, the bar's buttons are 44 pixels, and a tap on a drawn key lands on
that key. Quick taps
are presses, never a zoom: three fast taps on a key are three presses, and every
touch on a key -- or a quick second touch anywhere else that is not a control --
is cancelled for the browser, which is what keeps iOS Safari from reading it as
a double- or triple-tap zoom; the whole page is `touch-action: manipulation`
too. Fullscreen
gives the device the whole page for the biggest keys, over 44 pixels for both
devices, with room between neighbouring keys; held upright in fullscreen it still
asks to be turned. The firmware's own screen stays 4:3 and unstretched
throughout, since what the scan tests compare is that canvas.

**`test_build_info.py`**: the **i** panel, and the one check the page
makes about itself, for each firmware `firmwares.json` lists -- the release by its
tag, the dev pin by its branch, a pull request by its number, title and link, with
its half of the warning up. The panel is where a visitor is told what is running, so
every value in it is compared here against something that is not the panel's own
source: the tag, the commit and both hashes against `UPSTREAM`, and the Pyodide
version against `build/fetch-assets.sh`. The translations row is compared against
the commit, languages and font hashes the build recorded. The sha256 the panel shows for the zip
the page received is the worker's hash of the bytes it fetched, so it is compared
against the zip on disk. When the two match, the panel says nothing more: the
hashes sit side by side for anyone to compare.

Then the part that makes it a check rather than a decoration: a copy of the zip
with one byte appended is served from a second server, in front of the real one,
and the panel has to say, in red, that the two hashes differ, and show the
altered file's own hash. `build/out` is never touched, so there is nothing to put
back if this fails halfway.

**`test_firmware_choice.py`**: the firmwares on offer and the page's choice
between them. A plain URL runs the release, from `seedsigner-stock.zip`; the
device panel lists exactly what `firmwares.json` does, in its order and under its
groups, the release by its tag, dev by branch and short commit, each pull request
by number and title; the filter keeps the release and dev and narrows the pull
requests. Choosing dev asks first, reloads with `?firmware=dev`, fetches
`seedsigner-dev.zip` and boots it, and its version helper, handed the checkout's
`.git` files, names its branch, commit and commit date on its own Version screen.
The first pinned pull request, if there is one, is switched to the same way, and
names itself `pr-<N>`.

**`test_worker_csp.py`**: the worker's network. The firmware runs in a worker,
and a worker is governed only by the policy sent with its own script, not by the
page's `<meta>` one. So `worker.js` has to arrive with a `connect-src 'self'`
policy, and a probe worker served under that name from a second server has to
be refused a fetch to another origin -- a closed port on this machine, so the
answer never depends on the network.

**`test_record.py`**: the record button hands back an MP4, framed as asked, on
both devices. The screen alone has to come out at exactly twice the firmware's
own size, 640x480 or 480x480. The LCD has to be pixel perfect in a device
recording too: scaled by a whole, even factor and placed on an even column and
row, so that each of its pixels lines up with H.264's 2x2 colour blocks and no
colour bleeds from one into the next. The whole device, on a dark and on a light background,
has to come out centred, with the same padding across as down -- a little of it,
between 4 and 12 percent of the shell's height, not the art's own uneven room for
a drop shadow -- at an even size, since H.264 will not take an odd one. Sizes are
read out of the file's own track header, and the shell's size out of a second
device the test draws, never out of what the recorder says. Lengths are checked
loosely against how long the recording ran. The mouse is left over a key the
whole time: the video is composed from the firmware's canvas and a snapshot of
the drawn shell, so no pointer or hover glow can reach it. The 240x240 pass ends
on switching devices, which restarts the firmware and so asks first, in the
device panel: Cancel keeps the session, Switch reloads at the other size. A
Chromium without an H.264 encoder cannot make any of these; there the check is
that recording is never offered, and the file checks are skipped, not failed.

**`test_threads.py`**: SeedSigner's own animation threads, running as green
threads, and the firmware still answering while they do. The camera preview is
`LivePreviewThread` and keeps up; a warning pulses with nobody touching anything;
an animated QR advances by itself on a screen that only waits for a key, and
Down and Up make its background darker and brighter (which also proves the
`qrencode` stand-in honours `--background`); the spinner starts as a green thread
when an xpub is derived; every thread ends when its screen closes; none failed
to be rewritten. Every key press in the flow has to reach the screen within 1.5
seconds, because a thread taking its turns must never keep the firmware from the
lock it needs to draw. Timings are taken inside the page, from when each frame
was painted, not from this process's polling of the log.

**`test_toasts.py`**: toasts, which stock firmware only raises for a microSD card
the simulator does not have, so no toast ever appears in the page and there is
no way into a running worker to raise one. So this runs outside the browser, in
plain Python: the firmware's own `BaseToastOverlayManagerThread.run()`, lifted
out of the built zip as it stands, rewritten and scheduled by
`browser_threads.py` exactly as the worker would, around a stand-in screen and
buttons. A key closes a toast promptly, putting the screen back first; with no
key it goes when its time is up; a key during its delay cancels it before it is
drawn. Seconds, and no server.

**`test_settings.py`**: a setting changed through the firmware's own menus, and the
network indicator that follows it. Changing a setting once died on a System
Error and nothing noticed, so this drives Settings > Advanced > Bitcoin network
to Mainnet and requires the firmware to accept it and keep drawing. It also pins
the starting network down: a fresh page comes up on **Testnet**, which is
`settings.json` and not a patch, and going to Mainnet is what makes the page's
warning grow its mainnet half. The **i** panel is opened too, and must name no
outside origin the page talks to, because there is none.

**`test_persistent_settings.py`**: the firmware's Persistent Settings, kept by
this browser the way a device keeps them on its microSD card. Turned on through
the firmware's own menus, a change survives a reload and the page's storage
holds the firmware's own settings file; the panel the URL asks for and a network
the URL names still win over what was saved; turned off, the saved copy is erased
and the next reload is back on the defaults.

**`test_languages.py`**: every translation, through Settings > Language. The
menu offers them, which it only does when their `.mo` files are in the zip;
choosing Español and then 简体中文 each change the home screen the firmware
draws; the Chinese font is fetched from `fonts-<hash>/` and verified against the
hash the zip names; each font is fetched once however often it is drawn; nothing
raises.

**`test_scan.py`**: the whole scan path against Chromium's fake camera, run
three times. `qr.y4m` is the digit-based SeedQR; `qr-compact.y4m` is the
raw-bytes CompactSeedQR, which is the case that breaks first if any layer decides
a payload is text. Both are read with zxing-wasm, the default, with
`test_scan_native.py`'s lying `BarcodeDetector` installed, which must never be
asked. The CompactSeedQR is read once more with jsQR (`scan_jsqr`), with
zxing-wasm refused and no `BarcodeDetector`: a copy served without zxing-wasm,
in Safari or Chrome on Windows and Linux. All encode the same seed, so all must
reach `SeedFinalizeScreen` on the same fingerprint. Both videos open on blank
frames, and the test asserts nothing is decoded during them.

**`test_scan_native.py`**: the `BarcodeDetector` branch, the fallback when
zxing-wasm cannot be loaded in a browser that has a native detector. zxing-wasm
is refused, and a stub
detector is installed before any page script runs, and it always claims a QR and
always returns rubbish for `rawValue`, which is not artificial, since a real
`BarcodeDetector` handed a CompactSeedQR returns mojibake either way.

Two phases, and the first is the point of the file: **camera pointed at a blank
wall, native claiming a QR on every frame, and the firmware must load nothing at
all.** An earlier version fell back to `rawValue` here and reached a real-looking
fingerprint, `17d9884b`, from pure garbage: a seed that was never in front of
the camera. If that phase ever passes by reporting a seed, the simulator is
inventing keys, which is the worst thing a bitcoin-adjacent tool can do. The
second phase then holds up a real CompactSeedQR and requires the correct seed
anyway, because jsQR re-reads the frame for its actual bytes.

**`test_camera_stall.py`**: a camera that goes quiet mid-scan, and whether the
page admits it. ScanScreen only polls its buttons after it reads a frame, so a
scan screen that stops receiving frames is also one nobody can leave, and it
looks exactly like the firmware has hung. The test stalls the frame loop, requires
the page to say so under the device, and presses a key to prove the device
really does ignore it.

**`test_image_entropy.py`**: new seed from a photo, the camera's other mode. The
single-frame path was once never shimmed and fell through to the real
`picamera` import; this drives the flow far enough to take a still and show it
back, and requires that nothing raised on the way. On the way it checks that the
preview fills the 320x240 screen: the left and right thirds of it must agree,
which they did not when the page published a smaller square than the firmware
asked for and the firmware drew a strip of it down the left. Newer firmware
ignores Select until it has a full pool of distinct preview frames, so Select is
pressed again until the picture is taken.

**`run.py`'s `same_seed` step**: after the scan tests, the screen each of the
four scan runs ended on is compared with the others, and then with a committed
baseline. One seed, in both encodings and read down three different decoder
paths, must end on one rendered fingerprint.

What is compared is `scan-screen-*.png`: the 320x240 canvas SeedSigner's own
renderer drew, read back out of the canvas rather than photographed, and it is
compared as decoded pixels rather than as file bytes, because a newer Chromium
can encode the same canvas into a different PNG. The whole-page
`scan-proof-*.png` screenshots are still written and are the thing to look at
when this fails, but they are not what is asserted on: they also hold the page
around the device, drawn with whatever fonts the machine has.

Agreeing with each other is not enough; four runs of firmware that derived the
seed wrongly would agree perfectly. The anchor is a committed capture of
`SeedFinalizeScreen` showing the BIP39 test vector's master fingerprint
`b2269592`, committed as a picture rather than a digest so that it can be
audited by opening it. Regenerate it only when the firmware is meant to draw
something different:

    python3 test/run.py scan
    cp test/artifacts/scan-screen-qr.png test/baseline/screen-b2269592.png

and look at the file before committing it. A baseline nobody read anchors
nothing.

**`test_passphrase.py`**: the BIP39 passphrase changes the key, not just the
screen. The published test mnemonic goes in by camera twice, in fresh browser
contexts: once with no passphrase, once with `abc` entered through the firmware's
own Type Passphrase keyboard. The firmware's log has to announce the keyboard,
return exactly the typed passphrase, reach the review screen and then finalize
the seed. Both runs export a single-sig native Segwit account at `m/84'/1'/0'`,
on the simulator's default Testnet, through the firmware's own Export Xpub screens.

Screen names prove the route, not the key. The static QR the firmware draws is read
back and compared, origin and every character of the `vpub`, against
`mainnet_reference.py`, which derives both answers independently with and without
the passphrase. Both fingerprints must match their respective reference roots
and differ from each other; the account keys must differ too, not just the origin
labels. Firmware that silently ignores the passphrase cannot pass by reaching a
convincing-looking review screen.

One ASCII passphrase and one account path. This does not
check Unicode normalization, every keyboard layout, editing or discarding a
passphrase, scanning one, or signing with the resulting
key. Nothing here makes a browser safe for real seeds; this mnemonic and
passphrase are public test inputs and nothing derived from them should hold value.

**`test_mainnet.py`** -- mainnet, on purpose. The simulator ships on Testnet and
the page shouts when anybody moves it to Mainnet, because a seed typed into a
browser tab has no secure element. That warning is only honest if mainnet
actually works here, so this is the file that checks it, and it costs nothing: no
coins, no network, nothing broadcast.

The device is taken to Mainnet through Settings > Advanced, the published test
seed goes in by camera, and an account key comes back out through the firmware's
own Export Xpub screens at both standard mainnet paths: `m/48'/0'/0'/2'` for
multisig and `m/84'/0'/0'` for single sig. What the firmware drew is read out of the
QR on its screen and compared, fingerprint and all 111 characters of the key,
against a key derived in `mainnet_reference.py`. The firmware does all of its work
with embit; that file never imports embit and never opens a firmware zip, so
agreement is two implementations that share no code arriving at the same key
rather than one library agreeing with itself. Firmware still deriving under coin
type `1'` would fail here on the origin alone.

Then a mainnet transaction the test fabricates: an invented UTXO on a transaction
that does not exist, spent to an address nobody holds the key to. It goes in as a
base64 PSBT by camera, the firmware is driven through its own review and approve
screens, and the signed PSBT is read back off the animated QR it displays. The
signature is then checked offline against a BIP143 sighash computed from the
transaction the test built: under the key at `m/84'/0'/0'/0/0` and no other,
committed to SIGHASH_ALL, low-S, and over the transaction that went in byte for
byte. Two of the checks are the verifier proving it can say no -- the same
signature with one bit changed, and the same signature against the sighash of a
transaction paying a different amount -- because a verifier that says yes to
everything would have passed the line above them.

The reel in front of the camera is changed between the seed scan and the PSBT
scan. Chromium reopens the y4m file when a stream starts, which was measured
rather than assumed, so replacing it between two scans is what holding up a
different QR looks like from the firmware's side.

## Supporting files

- `harness.py`: where to point the tests, the log reader they share, and the
  key-pressing helpers.
- `mainnet_reference.py`: the other side of every comparison `test_mainnet.py`
  makes. BIP39, BIP32, SLIP-132, BIP143 and ECDSA verification written out from
  the specifications, plus RIPEMD-160, which OpenSSL 3 hides behind its legacy
  provider and so cannot be relied on from `hashlib`. Runnable on its own
  (`python3 test/mainnet_reference.py`), which prints the published vectors it is
  anchored to: BIP32's test vector 1, one of BIP39's, and RIPEMD-160's own.
- `serve.py`: a static server that sends COOP and COEP. Without cross-origin
  isolation `SharedArrayBuffer` is not constructible and the firmware hangs before
  it draws anything, so `python3 -m http.server` cannot serve this page at all.
  It overlays several directories so a checkout is served without being copied
  anywhere first.
- `make_qr_y4m.py`: writes the `.y4m` videos Chromium's fake camera plays,
  using the firmware's own vendored `qrcode` and embit's BIP39 wordlist out of
  the firmware zip under test (`seedsigner-stock.zip`, or `seedsigner-dev.zip`
  with `SIM_FIRMWARE=dev`), so the QR under test is drawn by the library SeedSigner
  draws one with. The seed is the standard BIP39 test vector "army van defense
  …". Nothing about it is secret and nothing should ever hold value.
- `run.py`: the runner described above.
