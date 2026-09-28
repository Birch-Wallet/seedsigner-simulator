# Tests

The simulator runs unmodified stock SeedSigner firmware under Pyodide, with its
hardware seams faked from outside it. These tests exist to check the seams,
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

A subset, by substring on the step name -- the names are `leak_scan`, `device`, `record`,
`build_info`, `settings`, `scan_seedqr`, `scan_compact`, `scan_native`,
`camera_stall`, `passphrase`, `image_entropy`, `mainnet`:

    python3 test/run.py scan          # everything with "scan" in the name
    python3 test/run.py leak          # just the leak scanner

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
| `SIM_ASSETS` | `build/out`, `src/web` | where `seedsigner-stock.zip` and the Pyodide runtime are |
| `QR_KIND` | `qr` | which QR `test_scan.py` holds up: `qr` or `qr-compact` |

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

**`test_device.py`**: the device art as a control, on a phone. Two claims, and
neither of them needs the firmware, so this file costs seconds.

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

Then the size of those keys. A landscape shell fitted to a 360 pixel phone draws
them 21 pixels across, which is not a thumb target, so the page offers the device
the whole viewport and lays it along the phone's long side: upright it is turned
across the screen, sideways it is height-bound, and the keys are about 46 pixels
either way. Both orientations are checked and photographed, along with the
firmware's own screen staying 4:3 and unstretched in both, since what the scan
tests compare is that canvas.

**`test_build_info.py`**: the **i** panel, and the one check the page
makes about itself. The panel is where a visitor is told what is running, so
every value in it is compared here against something that is not the panel's own
source: the tag, the commit and both hashes against `UPSTREAM`, the Pyodide
version against `build/fetch-assets.sh`, and the dependency list against the
licences manifest inside the built zip. The sha256 the panel shows for the zip
the page received is the worker's hash of the bytes it fetched, so it is compared
against the zip on disk.

Then the part that makes it a check rather than a decoration: a copy of the zip
with one byte appended is served from a second server, in front of the real one,
and the panel has to say the two hashes differ and show the altered file's own
hash. `build/out` is never touched, so there is nothing to put back if this fails
halfway. The limitation line is asserted too, because a page that quietly stopped
saying the self-check is not proof would be claiming more than it can.

**`test_settings.py`**: a setting changed through the firmware's own menus, and the
network indicator that follows it. Changing a setting once died on a System
Error and nothing noticed, so this drives Settings > Advanced > Bitcoin network
to Mainnet and requires the firmware to accept it and keep drawing. It also pins
the starting network down: a fresh page comes up on **Testnet**, which is
`settings.json` and not a patch, and going to Mainnet is what makes the page's
warning grow its mainnet half. The **i** panel is opened too, and must name no
outside origin the page talks to, because there is none.

**`test_scan.py`**: the whole scan path against Chromium's fake camera, run
twice. `qr.y4m` is the digit-based SeedQR; `qr-compact.y4m` is the raw-bytes
CompactSeedQR, which is the case that breaks first if any layer decides a payload
is text. Both encode the same seed, so both must reach `SeedFinalizeScreen` on
the same fingerprint. Both videos open on blank frames, and the test asserts
nothing is decoded during them.

**`test_scan_native.py`**: the `BarcodeDetector` branch, which the plain scan
test never reaches because desktop Chromium ships no Shape Detection API. A stub
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
back, and requires that nothing raised on the way.

**`run.py`'s `same_seed` step**: after the scan tests, the screen each of the
three scan runs ended on is compared with the other two, and then with a
committed baseline. One seed, encoded three ways and read down two different
decoder paths, must end on one rendered fingerprint.

What is compared is `scan-screen-*.png`: the 320x240 canvas SeedSigner's own
renderer drew, read back out of the canvas rather than photographed, and it is
compared as decoded pixels rather than as file bytes, because a newer Chromium
can encode the same canvas into a different PNG. The whole-page
`scan-proof-*.png` screenshots are still written and are the thing to look at
when this fails, but they are not what is asserted on: they also hold the page
around the device, drawn with whatever fonts the machine has.

Agreeing with each other is not enough; three runs of firmware that derived the
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
  `seedsigner-stock.zip`, so the QR under test is drawn by the library SeedSigner
  draws one with. The seed is the standard BIP39 test vector "army van defense
  …". Nothing about it is secret and nothing should ever hold value.
- `run.py`: the runner described above.
