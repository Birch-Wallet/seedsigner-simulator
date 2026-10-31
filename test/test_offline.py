"""
A Home Screen app: opened once, kept up to date, and started with no network.

An installed copy of the page is the one somebody expects to open on a plane,
and the one least likely to be loaded afresh: a phone resumes it rather than
loading it again, for days. This drives that life in one browser profile, from
a server of its own that it can switch off, and that sends Last-Modified with no
Cache-Control -- the server that was never told to, on which a browser treats
every file as fresh for a tenth of its age without asking.

  - One online launch is enough. The firmware waits for the service worker to
    take the page over before it starts, so Pyodide and the zip go through it
    and are kept; and, being an installed app, the page then fetches every other
    firmware firmwares.json lists, so it has them too.
  - A deploy is noticed. With the page still open, a new commit in deploy.json
    lights the update button as soon as the page is looked at again, and the
    same commit does not. The next launch shows the new page, despite a browser
    cache that thinks the old one fresh, and its Reload button reloads.
  - With the server gone, the app starts: plainly, on the other panel, and on
    another firmware -- each a URL with a query string never opened online.
"""

import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlencode

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness
from harness import check, report

from playwright.sync_api import sync_playwright

PORT = harness.PORT + 3
BASE = f"http://127.0.0.1:{PORT}"
DAY = 24 * 60 * 60

# What makes a profile a Home Screen app as far as the page can tell.
INSTALLED = "Object.defineProperty(navigator, 'standalone', { value: true });"

CACHED = """async () => {
  const paths = [];
  for (const name of await caches.keys()) {
    for (const request of await (await caches.open(name)).keys()) {
      paths.push(new URL(request.url).pathname);
    }
  }
  return paths;
}"""

DEPLOY_MARK = "() => (document.querySelector('meta[name=sim-test-deploy]') || {}).content || null"


def url(**params):
    """A URL on this test's own server, built as harness.sim_url builds one."""
    params.setdefault("debug", "1")
    if harness.FIRMWARE != harness.DEFAULT_FIRMWARE:
        params.setdefault("firmware", harness.FIRMWARE)
    return f"{BASE}/index.html?{urlencode(params)}"


def serve(roots):
    server = subprocess.Popen(
        [sys.executable, os.path.join(harness.REPO, "test", "serve.py"),
         "--port", str(PORT), "--cache-control", ""] + roots,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.time() + 15
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", PORT), 0.5):
                return server
        except OSError:
            time.sleep(0.25)
    server.kill()
    raise AssertionError(f"the test's own server never came up on port {PORT}")


def deploy(root, number, age_days=0):
    """Publish deploy <number>: a page that says which it is, and its commit."""
    with open(os.path.join(harness.REPO, "src", "web", "index.html"), encoding="utf-8") as handle:
        page = handle.read()
    page = page.replace("<head>", f'<head>\n<meta name="sim-test-deploy" content="{number}">', 1)
    stamp = time.time() - age_days * DAY
    for name, text in (("index.html", page), ("deploy.json", json.dumps({"commit": f"{number:040d}"}))):
        path = os.path.join(root, name)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.utime(path, (stamp, stamp))


def launch(p, profile):
    context = p.chromium.launch_persistent_context(profile, viewport={"width": 1000, "height": 900})
    context.add_init_script(INSTALLED)
    page = context.pages[0] if context.pages else context.new_page()
    return context, page


def boot(page, address, what):
    log = harness.Log(page)
    page.goto(address)
    log.wait("MainMenuScreen", 240, what)
    return log


def looked_at_again(page):
    """What a phone does when the app comes back to the front."""
    page.evaluate("() => document.dispatchEvent(new Event('visibilitychange'))")


def offered(page, wait_ms):
    try:
        page.wait_for_selector("#controls.update-offered", timeout=wait_ms)
        return True
    except Exception:
        return False


def main() -> int:
    index_path = harness.find_asset("firmwares.json")
    others = []
    if index_path:
        with open(index_path, encoding="utf-8") as handle:
            others = [entry["name"] for entry in json.load(handle).get("firmwares", [])
                      if entry["name"] != harness.FIRMWARE
                      and harness.find_asset(f"seedsigner-{entry['name']}.zip")]
    other = others[0] if others else None

    root = tempfile.mkdtemp(prefix="sim-offline-")
    profile = tempfile.mkdtemp(prefix="sim-offline-profile-")
    # Deployed long enough ago that the browser would happily keep it a day.
    deploy(root, 1, age_days=10)
    server = serve([root] + [r for r in harness.WEB_ROOTS if os.path.isdir(r)])
    try:
        with sync_playwright() as p:
            # --- one online launch ------------------------------------------------
            context, page = launch(p, profile)
            log = boot(page, url(), "the first launch to boot")
            check("the first launch is controlled by the service worker",
                  page.evaluate("() => !!navigator.serviceWorker.controller"))
            cached = page.evaluate(CACHED)
            for name in ("pyodide.asm.wasm", "python_stdlib.zip", f"seedsigner-{harness.FIRMWARE}.zip"):
                check(f"after one launch, {name} is kept",
                      any(path.endswith("/" + name) for path in cached))
            if other:
                deadline = time.time() + 60
                while time.time() < deadline:
                    cached = page.evaluate(CACHED)
                    if f"/seedsigner-{other}.zip" in cached:
                        break
                    page.wait_for_timeout(500)
                check(f"and so is {other}, a firmware it has not run",
                      f"/seedsigner-{other}.zip" in cached
                      and f"/seedsigner-{other}.build-info.json" in cached, str(sorted(cached)))

            # --- a deploy, while it is open ------------------------------------------
            looked_at_again(page)
            check("looked at again with nothing new deployed, it offers nothing",
                  not offered(page, 2000))
            deploy(root, 2)
            looked_at_again(page)
            check("looked at again after a deploy, it offers the update", offered(page, 10000))
            check("without reloading on its own", page.evaluate(DEPLOY_MARK) == "1",
                  str(page.evaluate(DEPLOY_MARK)))
            context.close()

            # --- the next launch -----------------------------------------------------
            context, page = launch(p, profile)
            log = boot(page, url(), "the second launch to boot")
            check("the next launch shows the new deploy, though the browser's cache "
                  "would call the old one fresh", page.evaluate(DEPLOY_MARK) == "2",
                  str(page.evaluate(DEPLOY_MARK)))
            looked_at_again(page)
            check("and, being it, offers nothing", not offered(page, 2000))
            deploy(root, 3)
            looked_at_again(page)
            third = offered(page, 10000)
            check("a third deploy is offered", third)
            if third:
                page.click("#ctl-update")
                page.wait_for_selector("#update-panel:not([hidden])", timeout=5000)
                with page.expect_navigation(timeout=30000):
                    page.click("#update-reload")
                harness.Log(page).wait("MainMenuScreen", 240, "the reloaded page to boot")
                check("Reload loads the new page", page.evaluate(DEPLOY_MARK) == "3",
                      str(page.evaluate(DEPLOY_MARK)))
            context.close()

            # --- no network ------------------------------------------------------------
            server.terminate()
            server.wait(timeout=10)
            server = None
            context, page = launch(p, profile)
            for name, address, what in (
                    ("plainly", url(), "an offline launch to boot"),
                    ("on the 240x240 hat", url(display="240x240"), "the hat to boot offline"),
            ):
                try:
                    log = boot(page, address, what)
                    check(f"with no network it starts, {name}", True)
                except Exception as error:
                    check(f"with no network it starts, {name}", False, str(error).splitlines()[0])
            try:
                size = page.evaluate("() => [document.getElementById('screen').width,"
                                     " document.getElementById('screen').height]")
            except Exception as error:
                size = str(error).splitlines()[0]
            check("and the hat is the hat", size == [240, 240], str(size))
            if other:
                try:
                    log = boot(page, url(firmware=other), f"{other} to boot offline")
                    with open(harness.find_asset(f"seedsigner-{other}.zip"), "rb") as handle:
                        want = hashlib.sha256(handle.read()).hexdigest()
                    # The i panel's hash of the zip the worker actually unpacked.
                    arrived = page.text_content("#build-computed").strip()
                    check(f"with no network it starts {other}, a firmware it never ran online",
                          arrived == want, f"ran {arrived[:12]}, {other} is {want[:12]}")
                except Exception as error:
                    check(f"with no network it starts {other}, a firmware it never ran online",
                          False, str(error).splitlines()[0])
            check("nothing raised", not log.seen(r"View\.run RAISED|UnhandledException|Traceback"))
            context.close()
    finally:
        if server:
            server.terminate()
            server.wait(timeout=10)
        shutil.rmtree(root, ignore_errors=True)
        shutil.rmtree(profile, ignore_errors=True)

    return report()


if __name__ == "__main__":
    sys.exit(main())
