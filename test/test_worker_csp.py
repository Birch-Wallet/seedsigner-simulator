"""
The worker cannot talk to anywhere but this origin.

The firmware runs in a Web Worker. The page's Content-Security-Policy is a
<meta> tag, and a <meta> policy does not reach a dedicated worker: a worker is
governed only by headers sent with its own script. So without a header on
worker.js, firmware code -- a release, or an unreviewed pull request -- could
fetch() any server that answers CORS, whatever the page's policy says.

Two checks:

  - worker.js is served with a policy whose connect-src is this origin alone;
  - that policy bites. A probe worker is served under the name worker.js, with
    whatever headers the server gives that name, from a second server in front
    of the real roots. It tries a fetch to another origin and reports whether
    the browser raised a securitypolicyviolation for it. The other origin is a
    closed port on this machine, so the answer never depends on the network:
    without the policy the fetch simply fails to connect, and no violation is
    raised.
"""

import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness
from harness import check, report

from playwright.sync_api import sync_playwright

PROBE_WORKER = """
self.addEventListener("securitypolicyviolation", (event) => {
  postMessage({ violated: event.violatedDirective, blocked: event.blockedURI });
});
fetch("http://127.0.0.1:9/").then(
  () => postMessage({ fetched: true }),
  () => setTimeout(() => postMessage({ failed: true }), 200));
"""

PROBE_PAGE = """<!doctype html><meta charset="utf-8"><title>probe</title>
<script>
window.results = [];
const worker = new Worker("worker.js");
worker.onmessage = (event) => window.results.push(event.data);
</script>"""


def serve(root, port):
    server = subprocess.Popen(
        [sys.executable, os.path.join(harness.REPO, "test", "serve.py"),
         "--port", str(port), root] + [r for r in harness.WEB_ROOTS if os.path.isdir(r)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.time() + 15
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), 0.5):
                return server
        except OSError:
            time.sleep(0.25)
    server.kill()
    raise AssertionError(f"the probe server never came up on port {port}")


def main() -> int:
    with urllib.request.urlopen(f"{harness.BASE_URL}/worker.js") as response:
        policy = response.headers.get("Content-Security-Policy") or ""
    directives = {part.split()[0]: part.split()[1:]
                  for part in (d.strip() for d in policy.split(";")) if part}
    check("worker.js is served with its own Content-Security-Policy", bool(policy), policy)
    check("which lets it connect to this origin and nowhere else",
          directives.get("connect-src") == ["'self'"], policy)

    root = tempfile.mkdtemp(prefix="sim-csp-")
    with open(os.path.join(root, "worker.js"), "w") as handle:
        handle.write(PROBE_WORKER)
    with open(os.path.join(root, "probe.html"), "w") as handle:
        handle.write(PROBE_PAGE)
    server = serve(root, harness.PORT + 2)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page()
            page.goto(f"http://127.0.0.1:{harness.PORT + 2}/probe.html")
            page.wait_for_function("() => window.results.some(r => r.failed || r.fetched)",
                                   timeout=15000)
            results = page.evaluate("() => window.results")
            violations = [r for r in results if "violated" in r]
            check("a worker under that policy is refused another origin",
                  any(v["violated"].startswith("connect-src") for v in violations)
                  and not any(r.get("fetched") for r in results),
                  str(results))
            browser.close()
    finally:
        server.terminate()
        server.wait(timeout=10)
        shutil.rmtree(root, ignore_errors=True)

    return report()


if __name__ == "__main__":
    sys.exit(main())
