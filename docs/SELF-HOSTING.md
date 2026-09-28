# Self-hosting

Everything here is static files. There is no backend, no database and nothing
running at request time, but there are two headers, and without them the page
loads and then does nothing.

## The one thing that breaks every first attempt

The page **must** be served with both of these:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

They are what make the document *cross-origin isolated*, which is what makes
`SharedArrayBuffer` constructible. Every input the firmware has (keypresses and
camera frames) crosses into the worker on shared memory, because the
worker is blocked inside SeedSigner's main loop and can never answer a
`postMessage` (see
[ARCHITECTURE.md](ARCHITECTURE.md#the-constraint-everything-follows-from)).
No shared memory, no SeedSigner.

`index.html` checks for this before it starts the worker and puts a message on the
page rather than failing silently. If you see

> this page needs cross-origin isolation and is not getting it

it is the headers, always. `python3 -m http.server` does not send them, which is
why this repository ships its own server.

The second rule is just as strict: **the page must be a secure context.** That
means `https://`, or `http://localhost` / `http://127.0.0.1`. On plain `http://`
to any other address (a LAN IP, a Tailscale IP, a hostname) the browser ignores
COOP and COEP outright, Chrome says so in the console ("The
Cross-Origin-Opener-Policy header has been ignored, because the URL's origin was
untrustworthy"), there is no `SharedArrayBuffer`, and the firmware cannot start.
There is no camera API there either. The page says

> this page is not a secure context

For access from other machines, put HTTPS in front of it (a reverse proxy with a
certificate, or `tailscale serve` on a tailnet with HTTPS certificates enabled),
or tunnel to localhost (`ssh -L 8770:127.0.0.1:8770 host`). For a quick test in
Chrome only, `chrome://flags/#unsafely-treat-insecure-origin-as-secure` accepts
the http origin as secure on that one browser.

## Getting the pieces

Two of the three pieces are not in the repository, on purpose: a 26 MB WebAssembly
blob and firmware you are being asked to trust are both things better fetched and
verified than committed.

```sh
./build/fetch-assets.sh          # Pyodide 0.26.4 -> src/web/pyodide-e24b45d3/, sha256-checked
./build/build-firmware-zip.sh      # -> build/out/seedsigner-stock.zip, from the pinned commit
```

`fetch-assets.sh --check` re-verifies what is already on disk, and
`sha256sum -c build/checksums.txt` covers everything that is committed and then
served or packaged as it stands: jsQR, the page and its scripts, the icons, the
three shims, and the stand-in packages in `src/fakes/` that the build copies
into the firmware zip. Both scripts explain their trust chain in
their own header comments; they are worth a read before you run them.

That manifest is generated, by the one command that is allowed to write it:

```sh
./build/update-checksums.sh          # rewrite it, when a change to a listed file is deliberate
./build/update-checksums.sh --check  # is it what it would be? writes nothing
```

Nothing else ever rewrites it. The build reads it and refuses to package a file
that changed or that is listed nowhere; it does not refresh it, because a build
that blessed whatever it found would package a modified stand-in and call it
correct. `git config core.hooksPath build/hooks` installs a hook that keeps a commit from
splitting the two, which is worth doing if you are going to change files here.

## Running it locally

`test/serve.py` overlays several directories into one document root, so a checkout
is served without being copied anywhere first:

```sh
python3 test/serve.py --port 8770 src/web src/shims build/out
```

Then open <http://127.0.0.1:8770/>. It binds to `127.0.0.1` by default (`--host` to
change that) and sends exactly what the page needs:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
Cache-Control: no-store
```

It also serves `.wasm` as `application/wasm`, which Pyodide's streaming
instantiation insists on. `127.0.0.1` is a secure context, so the camera works
there without a certificate.

## Deploying it

A real web server has one document root, so flatten the same three sources into one
directory. The page, the worker and the shims all fetch each other by relative
path, so everything sits side by side:

```sh
dest=/srv/seedsigner-simulator
mkdir -p "$dest"
cp -R src/web/. "$dest/"          # the page, its scripts, icons and pyodide-e24b45d3/
cp src/shims/*.py "$dest/"
cp build/out/seedsigner-stock.zip build/out/seedsigner-stock.build-info.json "$dest/"
```

| In the served root | From | Notes |
| --- | --- | --- |
| `index.html` | `src/web/` | the simulator |
| `worker.js`, `camera.js`, `seedsigner-device.js`, `recorder.js` | `src/web/` | |
| `jsQR.js`, `mp4-muxer.js` | `src/web/` | must be same-origin; a CDN is refused by both COEP and the page's CSP. `mp4-muxer.js` is only the Record button, which stays hidden without it |
| `sw.js`, `manifest.json`, `icon-*.png`, `apple-touch-icon.png` | `src/web/` | offline cache and PWA install; optional, the firmware runs without them |
| `pyodide-e24b45d3/` | `fetch-assets.sh` | ~26 MB: the runtime plus the wheels for Pillow and pycryptodome |
| `browser_display.py`, `browser_camera.py`, `browser_qr.py` | `src/shims/` | fetched at boot and written into Pyodide's filesystem |
| `seedsigner-stock.zip` | `build/out/` | the pinned `seedsigner` tree plus its pure-Python dependencies plus this repository's stand-in packages |
| `seedsigner-stock.build-info.json` | `build/out/` | what the build is: pin, tag, published hashes, dependency versions. The page's **i** panel is filled from it, and says it cannot describe the build if it is missing |

The shims sit next to the page rather than inside the firmware zip deliberately: it
keeps the zip exactly what the build script produced, with the seams visibly
outside it.

## nginx

```nginx
server {
    listen 443 ssl;
    server_name sim.example.org;

    root /srv/seedsigner-simulator;
    index index.html;

    # Both are required, on every response -- the worker, the wasm and
    # seedsigner-stock.zip included. Hence `always`.
    add_header Cross-Origin-Opener-Policy   same-origin  always;
    add_header Cross-Origin-Embedder-Policy require-corp always;
    add_header Cross-Origin-Resource-Policy same-origin  always;
}
```

Two nginx-specific traps:

- **`add_header` does not inherit into a nested block that has its own.** If any
  `location` in this server adds a header of its own, it drops every `add_header`
  from the parent (including these two), and the page silently loses isolation.
  Repeat them in that location.
- **`.wasm` must be served as `application/wasm`.** Recent `mime.types` include it;
  older ones do not, and Pyodide's streaming compilation refuses the wrong type.
  Check with `curl -I …/pyodide/pyodide.asm.wasm`.

## Caddy

```caddyfile
sim.example.org {
    root * /srv/seedsigner-simulator
    header {
        Cross-Origin-Opener-Policy   same-origin
        Cross-Origin-Embedder-Policy require-corp
        Cross-Origin-Resource-Policy same-origin
    }
    file_server
}
```

## Somewhere that cannot set headers

Static hosts that do not let you set response headers (GitHub Pages among them)
cannot serve this page as-is. There are service-worker shims that re-inject
COOP/COEP from inside the browser; this repository does not ship one, and its own
`sw.js` is an offline cache rather than a header trick. Use a host you can
configure.

## Checking it worked

From the outside, before you even open a browser:

```sh
curl -sI https://sim.example.org/ | grep -i cross-origin
```

In the page's console:

```js
crossOriginIsolated   // must be true
```

Then on the page itself: the status line under the device clears when the firmware
draws its first frame. Add `?debug=1` to the URL and the console narrates every screen, thread and keypress, plus which QR decoder
the camera settled on.

The test suite can be pointed at a deployment rather than a local checkout, which
is a stronger check than any of the above:

```sh
SIM_URL=https://sim.example.org python3 test/run.py
```

## When it does not work

| What you see | What it is |
| --- | --- |
| "this page is not a secure context…" | plain `http` to an address other than localhost: use https, or localhost |
| "this page needs cross-origin isolation…" | COOP/COEP missing, or dropped by a proxy or a nested `location` |
| Stuck on "loading python…" | `pyodide/` is incomplete or 404ing; check the network tab |
| Stuck on "unpacking firmware…" | `seedsigner-stock.zip` missing or truncated |
| SeedSigner draws, but scanning says "no camera API here" | not a secure context: use https or localhost |
| Camera permission prompt never appears | the firmware only opens the camera when you enter a scan screen; that is intended |
| Old firmware, new page, weird errors | a stale service-worker cache; bump `VERSION` in `sw.js` and reload |

## Verifying what you are serving

The point of the pin is that nobody has to take "it is the real firmware" on trust.
Anyone can rebuild and compare:

```sh
./build/build-firmware-zip.sh
sha256sum build/out/seedsigner-stock.zip
curl -s https://sim.example.org/seedsigner-stock.zip | sha256sum   # must be the same
```

The build is reproducible (fixed timestamps, fixed entry order, nothing about the
build host in the output), so the hashes match or something differs. If they
differ, the script also writes `seedsigner-stock.zip.manifest`, a `(sha256, path)` line per
file in the zip: diffing two manifests says *which* files differ, and rules out the
boring answer of two zlib versions compressing the same bytes differently.

If you host this for other people, keeping `UPSTREAM` and the served `seedsigner-stock.zip`
in step is most of your obligation to them: that, and not quietly editing the
`seedsigner` tree inside the zip, because the seams are outside it precisely so
that nobody has to.

## A note on what you are hosting

It is a simulator. Anyone who lands on it should be able to tell that within a few
seconds; the page says so above the device, and again in its **i** panel. If you re-skin it, keep that. A page that runs real SeedSigner
firmware and *looks* like a real device is exactly the thing worth not shipping.
