"""
Run the whole suite: one command, from a fresh clone.

    python3 test/run.py                 everything
    python3 test/run.py scan            only the tests whose name contains "scan"

It builds what is missing, generates the QR videos, starts the server, runs the
tests against it, and stops the server whether they passed or not.

Prerequisites, and nothing else:
  - Python 3.9+
  - pip install playwright && playwright install chromium
  - build/fetch-assets.sh and build/build-firmware-zip.sh able to run once, which
    needs network access. Their outputs are not committed: the Pyodide runtime is
    26MB of someone else's release, and the firmware zip is built from a pinned
    upstream SeedSigner commit so that what is tested is provably that commit.

Order is deliberate. The checks that need nothing run first and finish in
seconds, so a broken checkout says so before anything spends two minutes booting
CPython in WebAssembly.
"""

import os
import socket
import subprocess
import sys
import time
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import harness

PY = sys.executable

# (name, argv relative to test/, does it need the server)
SUITE = [
    ("leak_scan", ["leak_scan.py"], False),
    ("device", ["test_device.py"], True),
    ("record", ["test_record.py"], True),
    ("threads", ["test_threads.py"], True),
    ("toasts", ["test_toasts.py"], False),
    ("build_info", ["test_build_info.py"], True),
    ("settings", ["test_settings.py"], True),
    ("scan_seedqr", ["test_scan.py"], True),
    ("scan_compact", ["test_scan.py"], True),
    ("scan_native", ["test_scan_native.py"], True),
    ("camera_stall", ["test_camera_stall.py"], True),
    ("passphrase", ["test_passphrase.py"], True),
    ("image_entropy", ["test_image_entropy.py"], True),
    ("mainnet", ["test_mainnet.py"], True),
]

# The same file scanned twice, once per QR encoding. Both must end on the same
# fingerprint; same_seed() below checks that they do.
EXTRA_ENV = {
    "scan_seedqr": {"QR_KIND": "qr"},
    "scan_compact": {"QR_KIND": "qr-compact"},
}


def ensure_assets() -> bool:
    """The firmware zip and the Pyodide runtime, built on demand."""
    wanted = [
        (harness.FIRMWARE_ZIP, ["build/build-firmware-zip.sh"]),
        (os.path.join("pyodide-e24b45d3", "pyodide.js"),
         ["build/fetch-assets.sh"]),
    ]
    for name, argv in wanted:
        if harness.find_asset(name):
            continue
        script = argv[0]
        path = os.path.join(harness.REPO, script)
        if not os.path.exists(path):
            print(f"missing {name}, and {script} is not there to build it", file=sys.stderr)
            return False
        print(f"--- {' '.join(argv)} (for {name})", flush=True)
        try:
            code = subprocess.call([path] + argv[1:], cwd=harness.REPO)
        except OSError as exc:
            # Almost always a lost executable bit or a noexec filesystem, which
            # is worth saying rather than showing a traceback about.
            print(f"cannot run {script}: {exc}", file=sys.stderr)
            return False
        if code != 0:
            print(f"{' '.join(argv)} failed", file=sys.stderr)
            return False
        if not harness.find_asset(name):
            print(f"{' '.join(argv)} ran but produced no {name}", file=sys.stderr)
            return False
    return True


def start_server():
    roots = [r for r in harness.WEB_ROOTS if os.path.isdir(r)]
    server = subprocess.Popen(
        [PY, os.path.join(HERE, "serve.py"), "--port", str(harness.PORT)] + roots)

    deadline = time.time() + 15
    while time.time() < deadline:
        if server.poll() is not None:
            raise SystemExit(f"server exited immediately: is port {harness.PORT} taken?")
        try:
            with socket.create_connection(("127.0.0.1", harness.PORT), 0.5):
                return server
        except OSError:
            time.sleep(0.25)
    server.kill()
    raise SystemExit(f"server never came up on port {harness.PORT}")


# The three screens that must be the same screen. One seed, encoded three ways
# and read down two different decoder paths, so if the firmware is honest all three
# runs end on the same rendered fingerprint. Comparing the images turns a claim
# somebody had to check by eye into something CI can fail on.
#
# What is compared is the device's own canvas -- the 320x240 SeedSigner's
# renderer drew, read back out of it by the scan tests -- and not the page
# screenshots sitting next to it in the same directory. A screenshot of the page
# also holds the title, the amber warning box, the tray labels and the hint line,
# every one of them drawn with the fonts the machine happens to have and not one
# of them anything the firmware zip can influence. Comparing those went red on innocent
# hosts: once on a font difference across the whole header, once on five pixels
# differing by one channel value at an antialiased corner of the warning box,
# while the device area was byte-identical both times. A check that fails for
# reasons nobody caused is one people learn to skim past, and that is how a real
# regression eventually gets waved through.
#
BASELINE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "baseline", "screen-b2269592.png")

SAME_SEED_SCREENS = ("scan-screen-qr.png", "scan-screen-qr-compact.png",
                     "scan-screen-native-compact.png")


def png_pixels(path):
    """The decoded pixels of an 8-bit, non-interlaced PNG, as bytes.

    Pixels rather than file bytes, because what is being compared is what the
    firmware drew, and two browsers can encode the same canvas into different PNG
    files: a newer Chromium compresses differently and every byte moves while
    not one pixel does. Standard library only, like the rest of this runner.
    """
    with open(path, "rb") as handle:
        data = handle.read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{path} is not a PNG")
    pos, idat = 8, b""
    width = height = channels = 0
    while pos < len(data):
        length = int.from_bytes(data[pos:pos + 4], "big")
        kind, body = data[pos + 4:pos + 8], data[pos + 8:pos + 8 + length]
        if kind == b"IHDR":
            width, height = int.from_bytes(body[0:4], "big"), int.from_bytes(body[4:8], "big")
            depth, colour, interlace = body[8], body[9], body[12]
            channels = {0: 1, 2: 3, 4: 2, 6: 4}.get(colour)
            if depth != 8 or channels is None or interlace:
                raise ValueError(f"{path}: only 8-bit non-interlaced PNGs are handled")
        elif kind == b"IDAT":
            idat += body
        pos += 12 + length
    raw, stride = zlib.decompress(idat), width * channels
    out, previous = bytearray(), bytearray(stride)
    for row in range(height):
        start = row * (stride + 1)
        kind, line = raw[start], bytearray(raw[start + 1:start + 1 + stride])
        for i in range(stride):
            left = line[i - channels] if i >= channels else 0
            up, corner = previous[i], previous[i - channels] if i >= channels else 0
            if kind == 1:
                line[i] = (line[i] + left) & 0xFF
            elif kind == 2:
                line[i] = (line[i] + up) & 0xFF
            elif kind == 3:
                line[i] = (line[i] + (left + up) // 2) & 0xFF
            elif kind == 4:
                guess = left + up - corner
                pa, pb, pc = abs(guess - left), abs(guess - up), abs(guess - corner)
                pick = left if pa <= pb and pa <= pc else (up if pb <= pc else corner)
                line[i] = (line[i] + pick) & 0xFF
        out += line
        previous = line
    return (width, height, channels, bytes(out))


def same_seed() -> int:
    print("\n=== same_seed " + "=" * 54, flush=True)
    names = SAME_SEED_SCREENS

    paths = [os.path.join(harness.ARTIFACT_DIR, n) for n in names]
    missing = [n for n, p in zip(names, paths) if not os.path.exists(p)]
    if missing:
        print(f"  FAIL no captured screen from {missing}")
        return 1
    for other in paths[1:]:
        if png_pixels(paths[0]) != png_pixels(other):
            print(f"  FAIL {os.path.basename(other)} is a different screen from "
                  f"{os.path.basename(paths[0])}; the scan-proof-*.png "
                  "screenshots beside them show what each run was displaying")
            return 1

    # Agreeing with each other is not enough. Three runs of firmware that derived
    # the seed wrongly would agree perfectly and still be wrong, and the mnemonic
    # to seed path here runs on a substituted PBKDF2 (hashlib has no OpenSSL under
    # Pyodide), so "all three match" has to be anchored to a known answer.
    #
    # That anchor is BASELINE, and moving the comparison to the canvas does not
    # weaken it: the baseline is the same capture of the same screen, taken from
    # a run whose decoded seed was checked, and it is 320x240 of the firmware's own
    # output with nothing of the host in it. It is a picture rather than a digest
    # so that the anchor can be audited by opening it: it is SeedFinalizeScreen
    # reading "fingerprint b2269592", which is the BIP39 test vector "army van
    # defense ..." and nothing else. Any of the three captures that differs from
    # it by one pixel fails here.
    if not os.path.exists(BASELINE):
        print(f"  FAIL no baseline at {BASELINE}")
        return 1
    if png_pixels(paths[0]) != png_pixels(BASELINE):
        print("  FAIL the decoded seed does not match the known-good baseline "
              f"({os.path.basename(BASELINE)}); the firmware decoded or derived "
              "something other than the test vector")
        return 1
    print("  ok   all three encodings end on the same screen, and it is the "
          "expected seed (fingerprint b2269592)")
    return 0


def run(name, argv, env):
    print(f"\n=== {name} " + "=" * (60 - len(name)), flush=True)
    started = time.time()
    code = subprocess.call([PY, os.path.join(HERE, argv[0])] + argv[1:], env=env)
    print(f"--- {name}: {'pass' if code == 0 else 'FAIL'} in {time.time() - started:.0f}s",
          flush=True)
    return code


def main(argv) -> int:
    wanted = argv[1:]
    suite = [s for s in SUITE if not wanted or any(w in s[0] for w in wanted)]
    if not suite:
        print(f"nothing matches {wanted}; names are {[s[0] for s in SUITE]}", file=sys.stderr)
        return 2

    needs_browser = any(needs_server for _, _, needs_server in suite)
    if needs_browser and not ensure_assets():
        return 2

    env = dict(os.environ)
    env["SIM_ARTIFACT_DIR"] = harness.ARTIFACT_DIR
    env["SIM_PORT"] = str(harness.PORT)

    if needs_browser:
        print("--- generating the QR videos", flush=True)
        if subprocess.call([PY, os.path.join(HERE, "make_qr_y4m.py")], env=env) != 0:
            return 2

    server = start_server() if needs_browser else None
    results = {}
    try:
        for name, args, _ in suite:
            results[name] = run(name, args, {**env, **EXTRA_ENV.get(name, {})})
    finally:
        if server:
            server.terminate()
            server.wait(timeout=10)
        # The videos are ~115MB and regenerate in seconds; the screenshots are
        # the part worth keeping. SIM_KEEP_VIDEOS=1 to leave them behind.
        if not os.environ.get("SIM_KEEP_VIDEOS"):
            for name in ("qr.y4m", "qr-compact.y4m", "qr-blank.y4m",
                         "mainnet-camera.y4m"):
                path = os.path.join(harness.ARTIFACT_DIR, name)
                if os.path.exists(path):
                    os.remove(path)

    # Only meaningful when every scan test ran and passed: comparing a fresh
    # capture against a stale one would prove nothing.
    if all(results.get(name) == 0 for name in ("scan_seedqr", "scan_compact", "scan_native")):
        results["same_seed"] = same_seed()

    print("\n" + "=" * 68)
    for name, code in results.items():
        print(f"  {'pass' if code == 0 else 'FAIL'}  {name}")
    print(f"artifacts in {harness.ARTIFACT_DIR}")
    return 0 if all(code == 0 for code in results.values()) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
