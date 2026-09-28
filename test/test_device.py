"""
The device art as a control: what a thumb can press, and how big it gets.

Everything here is about the shell in front of the firmware rather than about the
firmware, so nothing waits for Python: the art is drawn before the worker has
finished fetching anything, and this file is seconds rather than minutes. The
keyboard is left to the rest of the suite, which drives the firmware through it
and would notice at once if it stopped working.

Two things are being pinned down.

**The screen is not a control.** It used to be the select key, on the grounds
that it is the biggest target on the shell, and on a phone that meant a tap
anywhere on the home menu opened the camera. A SeedSigner has no touchscreen,
so neither has this: only the drawn keys answer. The proof is a second device
rendered on the page with a counting onKey, driven by real touch events through
the DevTools protocol -- a tap on the screen has to count nothing, a tap on a
key has to count exactly one, and a finger held on a key has to keep counting
one, because a hardware button does not repeat either.

**Landscape, always, on a phone.** A landscape device fitted to a portrait
phone's width draws keys about 23 pixels across, which is not a thumb target.
So a phone held upright gets the whole page drawn turned a quarter, reading
right with the phone on its side, and on its side it is simply the page, with
title, warning, device and control bar on one screen. Checked in both
orientations: which way the page lies, that nothing is off the screen, how big
the keys and the bar's buttons come out, and that a tap on a drawn key still
lands on that key through the rotation.

**The shell can have the screen.** Fullscreen gives the device the whole page
for the biggest keys. This checks it in both orientations, and that the
firmware's own 320x240 screen keeps its shape throughout, since the tests that
compare it are comparing pixels.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness
from harness import check, report

from playwright.sync_api import sync_playwright

PHONE = {"width": 360, "height": 780}
PHONE_SIDEWAYS = {"width": 780, "height": 360}
DESKTOP = {"width": 1200, "height": 900}

# A second device, rendered by the same call index.html makes, with an onKey
# that only counts. Nothing is sent to the firmware, so what a press does is not
# in the way of asking whether a press happened.
PROBE = """
() => {
  const box = document.createElement("div");
  box.id = "probe";
  box.style.cssText = "position:fixed;left:0;bottom:0;width:340px;z-index:99";
  document.body.appendChild(box);
  window.__presses = [];
  window.SeedSignerDevice.render(box, {
    screenWidth: 320, screenHeight: 240, interactive: true,
    onKey: (channel) => window.__presses.push(channel),
  });
}
"""


def rotated(page):
    return page.evaluate("() => document.body.classList.contains('rotated')")


def on_page(page, selector):
    """A box in the page's own coordinates, top to bottom, whether or not the
    page is drawn turned. Turned, the page's top edge runs down the screen's
    right-hand side, so its "down" is the screen's leftward."""
    box = page.locator(selector).bounding_box()
    if not rotated(page):
        return {"top": box["y"], "bottom": box["y"] + box["height"]}
    width = page.evaluate("() => document.documentElement.clientWidth")
    return {"top": width - (box["x"] + box["width"]), "bottom": width - box["x"]}


# As on iOS, which has no fullscreen API: what is checked here is the page's
# own fullscreen, and a window the browser has made fullscreen cannot be
# resized to turn the phone round.
NO_BROWSER_FULLSCREEN = """
Element.prototype.requestFullscreen = () => Promise.reject(new Error("no fullscreen here"));
"""


# Which keys go down, as the page's own art shows them.
WATCH_DOWNS = """
() => {
  window.__downs = [];
  new MutationObserver((changes) => {
    for (const change of changes) {
      if (change.target.classList.contains("ssd-down")) {
        window.__downs.push(change.target.dataset.ssdControl);
      }
    }
  }).observe(document.querySelector("#device .ssd-svg"),
             { subtree: true, attributes: true, attributeFilter: ["class"] });
}
"""


def centre(page, selector):
    box = page.locator(selector).bounding_box()
    return box["x"] + box["width"] / 2, box["y"] + box["height"] / 2


def presses(page):
    return page.evaluate("() => window.__presses")


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context(viewport=PHONE, has_touch=True,
                                      service_workers="block")
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.add_init_script(NO_BROWSER_FULLSCREEN)
        page.goto(harness.sim_url())
        page.wait_for_selector("#device .ssd-svg")

        # --- held upright: the page lies on its side -------------------------
        check("a phone held upright gets the page turned to landscape",
              rotated(page), page.evaluate("document.body.className"))
        title = page.locator("h1").bounding_box()
        check("so the title runs down the screen rather than across it",
              title["height"] > title["width"],
              f"{int(title['width'])}x{int(title['height'])}")

        # --- the order of the page, top to bottom ----------------------------
        # The title, then the warning, then the device, then the controls. Read
        # off the rendered boxes rather than off the source order, because
        # either one can be moved without the other, and in the page's own
        # coordinates, so it holds with the page turned. The warning is the
        # point: a sentence saying not to type a real seed has to be read
        # before the keyboard is.
        def in_order(where):
            title = on_page(page, "h1")
            warn = on_page(page, "p.warn")
            device = on_page(page, "#device")
            bar = on_page(page, "#controls")
            # On a short page the title and the warning share a line, which is
            # still before the device.
            check(f"{where}: the title is not below the simulator warning",
                  title["top"] < warn["bottom"],
                  f"title at {int(title['top'])}, warning at {int(warn['top'])}")
            check(f"{where}: the simulator warning sits above the device",
                  warn["bottom"] <= device["top"],
                  f"warning ends at {int(warn['bottom'])}, device starts at {int(device['top'])}")
            check(f"{where}: and the control bar is under the device",
                  device["bottom"] <= bar["top"],
                  f"device ends at {int(device['bottom'])}, bar starts at {int(bar['top'])}")

        in_order("upright")
        sizes = [min(b["width"], b["height"]) for b in
                 (page.locator(f"#controls {sel}").bounding_box()
                  for sel in ("#ctl-device", "#fullscreen"))]
        check("upright: the bar's buttons are thumb targets", min(sizes) >= 44,
              ", ".join(f"{v:.0f}px" for v in sizes))
        upright_key = min(page.locator("#device [data-ssd-control=select]").bounding_box()[k]
                          for k in ("width", "height"))
        check("upright: the device's keys are near thumb size in the page",
              upright_key >= 36, f"{upright_key:.0f}px")

        # A tap through the rotation lands on the key under the finger.
        page.evaluate(WATCH_DOWNS)
        x, y = centre(page, "#device [data-ssd-control=up]")
        page.touchscreen.tap(x, y)
        page.wait_for_timeout(60)
        check("upright: a tap on a drawn key presses that key",
              page.evaluate("() => window.__downs") == ["up"],
              str(page.evaluate("() => window.__downs")))

        # --- the screen is not a button --------------------------------------
        page.evaluate(PROBE)
        slot = "#probe .ssd-screen-slot"
        check("the screen claims to be no control",
              page.locator(slot).get_attribute("role") is None
              and page.locator(slot).get_attribute("aria-label") is None,
              str(page.locator(slot).get_attribute("role")))

        x, y = centre(page, slot)
        page.touchscreen.tap(x, y)
        page.wait_for_timeout(200)
        check("tapping the screen does nothing at all", presses(page) == [],
              str(presses(page)))
        page.mouse.click(x, y)
        page.wait_for_timeout(200)
        check("and neither does clicking it", presses(page) == [], str(presses(page)))

        # --- and the keys are ------------------------------------------------
        select = "#probe [data-ssd-control=select]"
        x, y = centre(page, select)
        page.touchscreen.tap(x, y)
        page.wait_for_timeout(300)
        # A tap that reached both the pointer handler and the mouse event the
        # browser synthesises afterwards would count two.
        check("one tap on the select key is exactly one press",
              presses(page) == [5], str(presses(page)))

        page.evaluate("() => { window.__presses.length = 0; }")
        page.mouse.click(x, y)
        page.wait_for_timeout(200)
        check("and one click with a mouse is exactly one press",
              presses(page) == [5], str(presses(page)))

        # A finger that lands and stays. Playwright's tap is down and up in one
        # call, so the two halves are dispatched separately here.
        page.evaluate("() => { window.__presses.length = 0; }")
        cdp = context.new_cdp_session(page)
        cdp.send("Input.dispatchTouchEvent", {
            "type": "touchStart",
            "touchPoints": [{"x": x, "y": y, "radiusX": 12, "radiusY": 12}],
        })
        page.wait_for_timeout(2000)
        held = presses(page)
        down = page.locator(select).evaluate("node => node.classList.contains('ssd-down')")
        cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        page.wait_for_timeout(400)
        check("a finger held on a key sends one press and never repeats",
              held == [5], f"{len(held)} presses in two seconds")
        check("and the key is visibly down the whole time it is held", down, str(down))
        check("lifting it sends nothing more", presses(page) == [5], str(presses(page)))
        check("and the key comes back up",
              not page.locator(select).evaluate(
                  "node => node.classList.contains('ssd-down')"))

        # Two fingers at once are one press, not two: the second is ignored
        # rather than answered, because a hardware key cannot be pressed twice.
        page.evaluate("() => { window.__presses.length = 0; }")
        ux, uy = centre(page, "#probe [data-ssd-control=up]")
        cdp.send("Input.dispatchTouchEvent", {
            "type": "touchStart",
            "touchPoints": [{"x": x, "y": y}, {"x": ux, "y": uy}],
        })
        page.wait_for_timeout(300)
        cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        page.wait_for_timeout(200)
        check("two fingers landing together are one press",
              presses(page) == [5], str(presses(page)))
        page.evaluate("() => document.getElementById('probe').remove()")

        # --- the 240x240 hat ------------------------------------------------
        # A square screen is the Waveshare hat's case, with the same eight keys
        # as the Plus. Each has to be exactly one press of its own, and the
        # screen still none.
        page.evaluate(PROBE.replace("screenWidth: 320", "screenWidth: 240")
                           .replace("width:340px", "width:360px"))
        slot = page.locator("#probe .ssd-screen-slot").bounding_box()
        check("the hat's screen is square",
              abs(slot["width"] / slot["height"] - 1) < 0.02,
              f"{slot['width']:.1f}x{slot['height']:.1f}")
        page.touchscreen.tap(slot["x"] + slot["width"] / 2, slot["y"] + slot["height"] / 2)
        page.wait_for_timeout(200)
        check("and a tap on it is nothing", presses(page) == [], str(presses(page)))
        check("the hat has the Plus's eight keys",
              page.locator("#probe [data-ssd-channel]").count() == 8)
        for control, channel in (("select", 5), ("up", 1), ("right", 4), ("down", 2),
                                 ("left", 3), ("key1", 6), ("key2", 7), ("key3", 8)):
            page.evaluate("() => { window.__presses.length = 0; }")
            x, y = centre(page, f"#probe [data-ssd-control={control}]")
            page.touchscreen.tap(x, y)
            page.wait_for_timeout(250)
            check(f"a tap on the hat's {control} is exactly one {control} press",
                  presses(page) == [channel], str(presses(page)))
        page.evaluate("() => document.getElementById('probe').remove()")

        # --- the shell filling the screen -------------------------------------
        def key_size():
            box = page.locator("#device [data-ssd-control=select]").bounding_box()
            return min(box["width"], box["height"])

        # Long side over short side, so this says the same thing whichever way
        # up the shell is: 320x240 is 4:3 laid across a phone as well as along
        # it, and anything that stretched it would not be.
        def screen_shape():
            box = page.locator("#device .ssd-screen-slot").bounding_box()
            return (max(box["width"], box["height"])
                    / min(box["width"], box["height"]))

        in_page = key_size()
        check("the fullscreen control is offered on a phone",
              page.locator("#fullscreen").is_visible())
        page.locator("#fullscreen").click()
        page.wait_for_timeout(400)
        device = page.locator("#device").bounding_box()
        # Laid across the phone, so what it fills upright is the height.
        check("it lays the device along the phone's long side",
              device["height"] >= PHONE["height"] * 0.9
              and device["width"] <= PHONE["width"] + 1,
              f"{int(device['width'])}x{int(device['height'])} in "
              f"{PHONE['width']}x{PHONE['height']}")
        # 44 pixels is the smallest target every accessibility guideline agrees
        # a finger can be asked to hit.
        check("which makes the keys bigger still", key_size() >= 44 and key_size() > in_page,
              f"{key_size():.0f}px, was {in_page:.0f}px in the page")
        check("the firmware's screen keeps its 4:3 shape, unstretched",
              abs(screen_shape() - 4 / 3) < 0.02, f"{screen_shape():.3f}")
        page.screenshot(path=harness.artifact("device-360-fullscreen.png"))

        page.set_viewport_size(PHONE_SIDEWAYS)
        page.wait_for_timeout(400)
        device = page.locator("#device").bounding_box()
        # Upright, and fitted: it fills whichever axis runs out first and
        # overflows neither. Which axis that is belongs to the shell's own
        # proportions rather than to this test -- 780x360 was height bound while
        # the drawn shell was about twice as wide as it was tall, and is width
        # bound now the art matches the hardware and is a little longer.
        check("turned sideways it is upright and fitted to the viewport",
              device["width"] <= PHONE_SIDEWAYS["width"] + 1
              and device["height"] <= PHONE_SIDEWAYS["height"] + 1
              and (device["height"] >= PHONE_SIDEWAYS["height"] - 2
                   or device["width"] >= PHONE_SIDEWAYS["width"] - 2),
              f"{int(device['width'])}x{int(device['height'])} in "
              f"{PHONE_SIDEWAYS['width']}x{PHONE_SIDEWAYS['height']}")
        check("and the keys are the same thumb sized keys", key_size() >= 44,
              f"{key_size():.0f}px")
        check("and the screen is still 4:3", abs(screen_shape() - 4 / 3) < 0.02,
              f"{screen_shape():.3f}")
        page.screenshot(path=harness.artifact("device-sideways-fullscreen.png"))

        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        check("Escape leaves it", not page.evaluate(
            "() => document.body.classList.contains('solo')"))
        page.set_viewport_size(PHONE)
        page.wait_for_timeout(300)
        page.locator("#fullscreen").click()
        page.wait_for_timeout(200)
        page.locator("#fullscreen").click()
        page.wait_for_timeout(300)
        check("and so does the control that opened it",
              not page.evaluate("() => document.body.classList.contains('solo')")
              and page.locator("#fullscreen").get_attribute("aria-pressed") == "false")

        # --- on its side: the page as it is, all of it on screen --------------
        page.set_viewport_size(PHONE_SIDEWAYS)
        page.wait_for_timeout(400)
        check("turned sideways the page is not turned", not rotated(page))
        check("and turning it is not taken as asking for fullscreen",
              not page.evaluate("() => document.body.classList.contains('solo')"))
        in_order("sideways")
        bar = page.locator("#controls").bounding_box()
        fits = page.evaluate("""() => {
          const app = document.getElementById('app');
          return app.scrollHeight <= app.clientHeight + 1
              && document.documentElement.scrollWidth <= innerWidth + 1;
        }""")
        check("sideways: title, warning, device and bar all fit on one screen",
              fits and bar["y"] + bar["height"] <= PHONE_SIDEWAYS["height"] + 1,
              f"bar ends at {int(bar['y'] + bar['height'])} of {PHONE_SIDEWAYS['height']}")
        sideways_key = key_size()
        check("sideways: the device's keys are near thumb size in the page",
              sideways_key >= 36, f"{sideways_key:.0f}px")
        page.screenshot(path=harness.artifact("device-sideways-page.png"))
        page.set_viewport_size(PHONE)
        page.wait_for_timeout(300)
        check("focus went back to the page so the firmware keeps the keyboard",
              page.evaluate("document.activeElement === document.body"),
              page.evaluate("document.activeElement.tagName"))

        page.set_viewport_size(DESKTOP)
        page.wait_for_timeout(300)
        check("nothing about it is offered on a desktop, which has the room",
              not page.locator("#fullscreen").is_visible())
        check("no page errors", not errors, "; ".join(errors[:3]))

        # --- the 240x240 hat filling a sideways phone, in fullscreen ----------
        # The same shell and keys as the Plus's, around a narrower screen, and
        # its keys have to come out as thumb targets with room between them too.
        hat = context.new_page()
        hat.add_init_script(NO_BROWSER_FULLSCREEN)
        hat.set_viewport_size(PHONE_SIDEWAYS)
        hat.goto(harness.sim_url(display="240x240"))
        hat.wait_for_selector("#device .ssd-svg")
        hat.locator("#fullscreen").click()
        hat.wait_for_timeout(600)
        check("fullscreen on a sideways phone gives the hat the whole screen",
              hat.evaluate("() => document.body.classList.contains('solo')"))

        def box(name):
            return hat.locator(f"#device [data-ssd-control={name}]").bounding_box()

        sizes = {name: min(box(name)["width"], box(name)["height"])
                 for name in ("select", "key1", "key2", "key3")}
        check("the hat's select and side keys are thumb sized",
              min(sizes.values()) >= 44,
              ", ".join(f"{k} {v:.0f}px" for k, v in sizes.items()))
        # Room between them, so a thumb on one is not on the next.
        gaps = [box("key2")["y"] - (box("key1")["y"] + box("key1")["height"]),
                box("right")["x"] - (box("select")["x"] + box("select")["width"]),
                box("select")["y"] - (box("up")["y"] + box("up")["height"])]
        check("with clear space between neighbouring keys",
              min(gaps) >= 12, ", ".join(f"{g:.0f}px" for g in gaps))
        hat.screenshot(path=harness.artifact("device-hat-sideways-fullscreen.png"))
        hat.close()

        browser.close()

    return report()


if __name__ == "__main__":
    sys.exit(main())
