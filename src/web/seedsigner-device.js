/*
 * Procedural SeedSigner device art, in the two builds the firmware has a panel for.
 *
 * Both are one shell, taken off the orange anodised case the original Waveshare
 * 1.3" hat (240x240) is usually built into: a stadium with a rim, the screen in
 * a pocket milled across the face, a five-key D-pad with a round select on the
 * left and three pills stacked on the right, large and spread for a thumb.
 *
 * The SeedSigner Plus (320x240) is that shell lengthened by the extra width of
 * its screen, in its own colours: matte grey with cream keys, where the hat is
 * orange with a silver rim and aluminium keys.
 *
 * Which one is drawn follows the screen: a square screen is the hat.
 *
 * Standalone on purpose: nothing here touches SharedArrayBuffer, a worker or a
 * camera, so the same file can dress the live simulator and a marketing page
 * that has none of that. The only way out is the onKey callback.
 *
 * Everything is drawn rather than loaded because the pages using this send a CSP
 * with no external image, font or script origins.
 *
 * Lighting is one key from the upper left plus a soft fill. Anything shaded by a
 * gradient of its own would light itself in isolation and break that, so the
 * scene-wide paints below are userSpaceOnUse: a key near the bottom right is
 * darker than the same key near the top left because it samples a different
 * part of the same light.
 *
 * The screen cutout is published as a percentage of the viewBox, never as pixels,
 * so the live canvas keeps registration with the art at any rendered width.
 */
(function (global) {
  "use strict";

  var doc = global.document;
  if (!doc) return;

  var STYLE_ID = "ssd-style";
  var instances = 0;

  // Index into the firmware's BUTTON_NAMES. Mirrored rather than imported so this
  // file keeps no firmware dependency.
  var CHANNEL = {
    up: 1, down: 2, left: 3, right: 4, select: 5, key1: 6, key2: 7, key3: 8,
  };

  var CSS = [
    // No tap highlight and no selection: a thumb on a key must not paint a blue
    // box over it or start selecting the shell.
    ".ssd-root{position:relative;display:inline-block;line-height:0;max-width:100%;",
    "touch-action:manipulation;-webkit-tap-highlight-color:transparent;",
    "-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}",
    ".ssd-svg{display:block;width:100%;height:auto}",
    // Percentage geometry, so the cutout tracks the art through any resize.
    ".ssd-screen-slot{position:absolute;z-index:2;overflow:hidden;background:#000}",
    ".ssd-screen-slot>canvas{display:block;width:100%;height:100%}",
    ".ssd-glass{position:absolute;z-index:3;pointer-events:none}",
    ".ssd-ctl{pointer-events:none}",
    ".ssd-ctl .ssd-hover,.ssd-ctl .ssd-press{opacity:0}",
    // Only a live device reacts; the decorative build stays inert illustration.
    ".ssd-live .ssd-ctl{pointer-events:auto;cursor:pointer}",
    ".ssd-live .ssd-cap{transition:transform .05s ease-out}",
    ".ssd-live .ssd-ctl .ssd-hover{transition:opacity .13s ease}",
    // Hover only where there is a pointer that can hover. A touch that lands on
    // a key would otherwise leave it lit until something else was touched.
    "@media (hover:hover){.ssd-live .ssd-ctl:hover .ssd-hover{opacity:.2}}",
    // Pressed is a class rather than :active, because :active under touch is
    // whatever the browser feels like: Safari does not apply it at all without a
    // touch handler, and every engine drops it the moment a finger drifts. The
    // class goes on when the key is pressed and stays long enough to be seen.
    // The cap sinks, not the whole key: it goes down into its own side wall, so
    // the wall shortens under a press the way a real one does.
    ".ssd-live .ssd-ctl.ssd-down .ssd-cap{transform:translateY(var(--ssd-sink,2px))}",
    ".ssd-live .ssd-ctl.ssd-down .ssd-press{opacity:.42}",
    ".ssd-live .ssd-ctl.ssd-down .ssd-hover{opacity:.1}",
    ".ssd-live .ssd-ctl.ssd-down .ssd-shadow{opacity:.12}",
    ".ssd-live .ssd-ctl.ssd-down .ssd-gloss{opacity:.2}",
    "@media (prefers-reduced-motion:reduce){.ssd-live .ssd-ctl,",
    ".ssd-live .ssd-ctl .ssd-hover{transition:none}}",
  ].join("\n");

  // The pressed look alone, for a snapshot: the same rules as above without the
  // .ssd-live gate, and without any :hover, because a picture of the device has
  // no pointer over it and must not show where one happened to be.
  var SNAPSHOT_CSS = [
    ".ssd-ctl .ssd-hover,.ssd-ctl .ssd-press{opacity:0}",
    ".ssd-ctl.ssd-down .ssd-cap{transform:translateY(var(--ssd-sink,2px))}",
    ".ssd-ctl.ssd-down .ssd-press{opacity:.42}",
    ".ssd-ctl.ssd-down .ssd-hover{opacity:.1}",
    ".ssd-ctl.ssd-down .ssd-shadow{opacity:.12}",
    ".ssd-ctl.ssd-down .ssd-gloss{opacity:.2}",
  ].join("\n");

  var SVG_NS = "http://www.w3.org/2000/svg";

  // How long a key stays visibly down. A tap can be over in 40 milliseconds,
  // which is not long enough to see, so the state is held to this floor.
  var PRESSED_MS = 130;
  // A shade longer than a finger's, because a driven press has no finger to lift
  // and the eye has to catch it between one screen and the next. Not much
  // longer: at 220 the key was still sinking while the screen it caused had
  // already changed, which reads as lag rather than as a press.
  var FLASH_MS = 130;

  /**
   * One press per finger, from a drawn key and nowhere else.
   *
   * pointerdown rather than click: a key has to answer where a thumb lands,
   * and click arrives up to 300ms later on a phone. Nothing listens for mouse
   * events alongside it either, because a touch synthesises a mousedown of its
   * own afterwards and a device that answered both would send every key twice;
   * preventDefault here stops that synthesis, and with it the long-press menu
   * and the text selection, none of which a hardware button has.
   *
   * The pointer is remembered until it lifts, so a finger held on a key is one
   * press and no repeat -- the real device does not auto-repeat either -- and a
   * second finger arriving while the first is down is not a second press.
   */
  function bindControls(svgEl, onKey) {
    var pointer = null;    // the pointer holding a key down, if any
    var key = null;        // and the key it is holding
    var since = 0;

    function release() {
      if (!key) return;
      var released = key, waited = Date.now() - since;
      key = null;
      pointer = null;
      if (waited >= PRESSED_MS) released.classList.remove("ssd-down");
      else setTimeout(function () { released.classList.remove("ssd-down"); },
                      PRESSED_MS - waited);
    }

    function begin(event) {
      if (event.isPrimary === false) return;
      var hit = event.target.closest && event.target.closest("[data-ssd-channel]");
      if (!hit) return;
      event.preventDefault();
      // Any press still open ends here rather than wedging the device shut if
      // its pointerup was never delivered.
      release();
      key = hit;
      pointer = event.pointerId;
      since = Date.now();
      hit.classList.add("ssd-down");
      onKey(parseInt(hit.getAttribute("data-ssd-channel"), 10));
    }

    if (global.PointerEvent) {
      svgEl.addEventListener("pointerdown", begin);
      // On the window: a finger that slides off the key before it lifts still
      // ends the press, and so does the browser taking the gesture away.
      var end = function (event) { if (pointer === event.pointerId) release(); };
      global.addEventListener("pointerup", end);
      global.addEventListener("pointercancel", end);
    } else {
      svgEl.addEventListener("mousedown", begin);
      global.addEventListener("mouseup", release);
    }

    // A touch on a key is finished with once it has pressed the key. iOS
    // Safari does not reliably honour touch-action inside an SVG, so quick taps
    // on one key -- three Downs to walk a list -- read as a double- or
    // triple-tap and zoom the page. Cancelling the touch's end is what tells it
    // the tap was handled; the press itself already happened on pointerdown.
    svgEl.addEventListener("touchend", function (event) {
      var hit = event.target.closest && event.target.closest("[data-ssd-channel]");
      if (hit && event.cancelable) event.preventDefault();
    }, { passive: false });
  }

  function injectStyle() {
    if (doc.getElementById(STYLE_ID)) return;
    var el = doc.createElement("style");
    el.id = STYLE_ID;
    el.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(el);
  }

  function n(v) { return Math.round(v * 100) / 100; }
  function pct(a, b) { return n(a / b * 100) + "%"; }

  function roundRectPath(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    return "M" + n(x + r) + " " + n(y) + "H" + n(x + w - r) +
      "a" + n(r) + " " + n(r) + " 0 0 1 " + n(r) + " " + n(r) +
      "V" + n(y + h - r) +
      "a" + n(r) + " " + n(r) + " 0 0 1 " + n(-r) + " " + n(r) +
      "H" + n(x + r) +
      "a" + n(r) + " " + n(r) + " 0 0 1 " + n(-r) + " " + n(-r) +
      "V" + n(y + r) +
      "a" + n(r) + " " + n(r) + " 0 0 1 " + n(r) + " " + n(-r) + "Z";
  }

  // Every key on the real device is a fully radiused tic-tac, so the pill is the
  // only control shape here; a "circle" is just a pill as wide as it is tall.
  function pillPath(cx, cy, w, h) {
    return roundRectPath(cx - w / 2, cy - h / 2, w, h, h / 2);
  }

  // Stroking a path with its own paint rounds off sharp corners, which is how a
  // key gets a moulded edge instead of a die-cut one.
  function paint(shape, fill, grow, cls) {
    var grown = grow > 0
      ? ' stroke="' + fill + '" stroke-width="' + n(grow * 2) + '" stroke-linejoin="round"'
      : "";
    return '<path' + (cls ? ' class="' + cls + '"' : "") +
      ' d="' + shape + '" fill="' + fill + '"' + grown + "/>";
  }

  // What differs in colour between the two builds. Everything that lights them
  // (the chamfer, the sheen, the key light) is shared and drawn in white and
  // black over these.
  var PALETTES = {
    plus: {
      body: ["#55585c", "#45484c", "#383b3f", "#2e3134"],   // matte grey
      outline: "#23262b", band: "#42464d",
      key: ["#f4f1ea", "#e2ded4", "#bdb9ae"],               // cream caps
      wall: ["#4f4d47", "#6f6b64", "#948e84"],
      pocket: "#8a8e94",                                    // the milled floor
    },
    hat: {
      body: ["#f28a2e", "#e97a1d", "#da6c14", "#c15c0e"],   // anodised orange
      outline: "#141518", band: "#aeb2b7",                  // a silver rim
      key: ["#f3f4f5", "#cfd2d6", "#9a9ea4"],               // turned aluminium
      wall: ["#50545a", "#71757b", "#969aa0"],
      pocket: "#f7a655",
    },
  };

  function defs(id, L, P) {
    var u = L.u;
    var space = 'gradientUnits="userSpaceOnUse"';
    var bodyBox = ' x1="' + n(L.bodyX) + '" y1="' + n(L.bodyY) + '" x2="' +
      n(L.bodyX + L.bodyW) + '" y2="' + n(L.bodyY + L.bodyH) + '"';
    return [
      "<defs>",
      // Shell top face: key light upper-left, falling away to the lower right.
      // Flatter than a glossy consumer shell: the real one is a matte grey.
      '<linearGradient id="', id, '-body" ', space, bodyBox, ">",
      '<stop offset="0" stop-color="', P.body[0], '"/>',
      '<stop offset=".40" stop-color="', P.body[1], '"/>',
      '<stop offset=".75" stop-color="', P.body[2], '"/>',
      '<stop offset="1" stop-color="', P.body[3], '"/>',
      "</linearGradient>",
      // A chamfer facet is lit by its own orientation, not by where it sits, so
      // the bevel is shaded per edge: these run across the whole ring and
      // brighten the up-facing and left-facing facets along their full length.
      '<linearGradient id="', id, '-chamV" x1="0" y1="0" x2="0" y2="1">',
      '<stop offset="0" stop-color="#ffffff" stop-opacity=".6"/>',
      '<stop offset="', n(L.edge / L.bodyH * 0.85), '" stop-color="#ffffff" stop-opacity=".46"/>',
      '<stop offset="', n(L.edge / L.bodyH * 2.2), '" stop-color="#ffffff" stop-opacity=".08"/>',
      '<stop offset=".12" stop-color="#ffffff" stop-opacity="0"/>',
      '<stop offset=".88" stop-color="#000000" stop-opacity="0"/>',
      '<stop offset="', n(1 - L.edge / L.bodyH * 1.1), '" stop-color="#000000" stop-opacity=".2"/>',
      '<stop offset="1" stop-color="#000000" stop-opacity=".46"/>',
      "</linearGradient>",
      '<linearGradient id="', id, '-chamH" x1="0" y1="0" x2="1" y2="0">',
      '<stop offset="0" stop-color="#ffffff" stop-opacity=".34"/>',
      '<stop offset="', n(L.edge / L.bodyW * 0.85), '" stop-color="#ffffff" stop-opacity=".26"/>',
      '<stop offset="', n(L.edge / L.bodyW * 2.2), '" stop-color="#ffffff" stop-opacity=".05"/>',
      '<stop offset=".12" stop-color="#ffffff" stop-opacity="0"/>',
      '<stop offset=".88" stop-color="#000000" stop-opacity="0"/>',
      '<stop offset="', n(1 - L.edge / L.bodyW * 1.1), '" stop-color="#000000" stop-opacity=".18"/>',
      '<stop offset="1" stop-color="#000000" stop-opacity=".4"/>',
      "</linearGradient>",
      '<linearGradient id="', id, '-chamD" x1="0" y1="0" x2="1" y2="1">',
      '<stop offset="0" stop-color="#ffffff" stop-opacity=".13"/>',
      '<stop offset=".32" stop-color="#ffffff" stop-opacity="0"/>',
      '<stop offset=".45" stop-color="#000000" stop-opacity="0"/>',
      '<stop offset="1" stop-color="#000000" stop-opacity=".13"/>',
      "</linearGradient>",
      // A broad soft source skimming the face, which is most of what separates a
      // photographed shell from a filled rectangle.
      '<linearGradient id="', id, '-sheen" ', space,
      ' x1="', n(L.bodyX), '" y1="', n(L.bodyY), '" x2="',
      n(L.bodyX + L.bodyW * 0.78), '" y2="', n(L.bodyY + L.bodyH), '">',
      '<stop offset="0" stop-color="#ffffff" stop-opacity="0"/>',
      '<stop offset=".14" stop-color="#ffffff" stop-opacity=".045"/>',
      '<stop offset=".26" stop-color="#ffffff" stop-opacity=".012"/>',
      '<stop offset=".44" stop-color="#ffffff" stop-opacity="0"/>',
      "</linearGradient>",
      '<radialGradient id="', id, '-keylight" ', space,
      ' cx="', n(L.bodyX + L.bodyW * 0.2), '" cy="', n(L.bodyY + L.bodyH * 0.05),
      '" r="', n(L.bodyW * 0.95), '">',
      '<stop offset="0" stop-color="#ffffff" stop-opacity=".09"/>',
      '<stop offset=".55" stop-color="#ffffff" stop-opacity=".016"/>',
      '<stop offset="1" stop-color="#ffffff" stop-opacity="0"/>',
      "</radialGradient>",
      // The one light every raised part is graded against.
      '<linearGradient id="', id, '-scene" ', space, bodyBox, ">",
      '<stop offset="0" stop-color="#ffffff" stop-opacity=".07"/>',
      '<stop offset=".42" stop-color="#ffffff" stop-opacity="0"/>',
      '<stop offset=".52" stop-color="#000000" stop-opacity="0"/>',
      '<stop offset="1" stop-color="#000000" stop-opacity=".09"/>',
      "</linearGradient>",
      // Cream key caps. Off-white and slightly warm, not paper white.
      '<linearGradient id="', id, '-key" x1=".18" y1="0" x2=".8" y2="1">',
      '<stop offset="0" stop-color="', P.key[0], '"/>',
      '<stop offset=".45" stop-color="', P.key[1], '"/>',
      '<stop offset="1" stop-color="', P.key[2], '"/>',
      "</linearGradient>",
      // The side wall of a cap. Which wall of a key is on show is decided by
      // where the key sits (see parallax below), and a wall is lit by which way
      // it faces: the inward wall of a key on the left of the shell turns right,
      // away from the light, and the inward wall of one on the right turns back
      // into it. A single scene-wide ramp therefore shades every wall correctly,
      // because position and facing are the same fact here.
      '<linearGradient id="', id, '-wall" ', space, bodyBox, ">",
      '<stop offset="0" stop-color="', P.wall[0], '"/>',
      '<stop offset=".5" stop-color="', P.wall[1], '"/>',
      '<stop offset="1" stop-color="', P.wall[2], '"/>',
      "</linearGradient>",
      '<linearGradient id="', id, '-keyRim" x1=".2" y1="0" x2=".8" y2="1">',
      '<stop offset="0" stop-color="#ffffff" stop-opacity=".4"/>',
      '<stop offset=".4" stop-color="#8d8a82" stop-opacity=".22"/>',
      '<stop offset="1" stop-color="#000000" stop-opacity=".4"/>',
      "</linearGradient>",
      // Barely there: the caps are matte moulded plastic, not gel.
      '<linearGradient id="', id, '-gloss" x1=".3" y1="0" x2=".6" y2="1">',
      '<stop offset="0" stop-color="#ffffff" stop-opacity=".16"/>',
      '<stop offset=".5" stop-color="#ffffff" stop-opacity=".015"/>',
      '<stop offset="1" stop-color="#ffffff" stop-opacity="0"/>',
      "</linearGradient>",
      '<linearGradient id="', id, '-wellTop" x1="0" y1="0" x2="0" y2="1">',
      '<stop offset="0" stop-color="#000000" stop-opacity=".85"/>',
      '<stop offset="1" stop-color="#000000" stop-opacity="0"/>',
      "</linearGradient>",
      '<linearGradient id="', id, '-slot" x1="0" y1="0" x2="0" y2="1">',
      '<stop offset="0" stop-color="#04060a"/>',
      '<stop offset=".62" stop-color="#0c0f13"/>',
      '<stop offset="1" stop-color="#454b55"/>',
      "</linearGradient>",
      // Two shadows: a tight contact patch, and a wide ambient one that lifts the
      // device off a page nearly as dark as the shadow itself.
      '<filter id="', id, '-drop" x="-40%" y="-40%" width="180%" height="200%">',
      '<feDropShadow dx="0" dy="', n(26 * u), '" stdDeviation="', n(32 * u),
      '" flood-color="#000000" flood-opacity=".55"/>',
      "</filter>",
      '<filter id="', id, '-contact" x="-40%" y="-200%" width="180%" height="500%">',
      '<feGaussianBlur stdDeviation="', n(9 * u), '"/>',
      "</filter>",
      '<filter id="', id, '-btnShadow" x="-70%" y="-70%" width="240%" height="260%">',
      '<feGaussianBlur stdDeviation="', n(4.5 * u), '"/>',
      "</filter>",
      // Matte plastic: without a little grain the gradients read as vector fills.
      '<filter id="', id, '-grain" x="0" y="0" width="100%" height="100%">',
      '<feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" stitchTiles="stitch"/>',
      '<feColorMatrix type="saturate" values="0"/>',
      "</filter>",
      "</defs>",
    ].join("");
  }

  function bodyArt(id, L, P) {
    var u = L.u, x = L.bodyX, y = L.bodyY, w = L.bodyW, h = L.bodyH;
    var ix = x + L.edge, iy = y + L.edge;
    var iw = w - L.edge * 2, ih = h - L.edge * 2;
    var outer = roundRectPath(x, y, w, h, L.radius);
    var inner = roundRectPath(ix, iy, iw, ih, ih / 2);
    var band = ' d="' + outer + inner + '" fill-rule="evenodd"';
    var out = [];

    out.push('<ellipse cx="', n(x + w / 2), '" cy="', n(y + h + 5 * u),
      '" rx="', n(w * 0.44), '" ry="', n(11 * u),
      '" fill="#000000" opacity=".7" filter="url(#', id, '-contact)"/>');

    out.push('<path class="ssd-drop" d="', outer, '" fill="', P.outline,
      '" filter="url(#', id, '-drop)"/>');
    out.push('<path', band, ' fill="', P.band, '"/>');
    out.push('<path', band, ' fill="url(#', id, '-chamV)"/>');
    out.push('<path', band, ' fill="url(#', id, '-chamH)"/>');
    out.push('<path', band, ' fill="url(#', id, '-chamD)"/>');
    // Fill light on the shadow side, so the silhouette survives a near-black
    // page. Clipped to the shell: it is a hand-drawn arc rather than the real
    // curve, and where it strays outside the outline it used to leave a bright
    // nub in mid air off the right cap.
    out.push('<clipPath id="', id, '-shell"><path d="', outer, '"/></clipPath>');
    out.push('<g clip-path="url(#', id, '-shell)"><path d="M', n(x + w - 1), ' ', n(y + h * 0.34),
      'a', n(L.radius), ' ', n(L.radius), ' 0 0 1 ', n(-L.radius * 0.62), ' ', n(L.radius * 0.96),
      'H', n(x + w * 0.42), '" fill="none" stroke="#ffffff" stroke-opacity=".11"',
      ' stroke-width="', n(1.8 * u), '"/></g>');

    out.push('<clipPath id="', id, '-face"><path d="', inner, '"/></clipPath>');
    out.push('<path d="', inner, '" fill="url(#', id, '-body)"/>');
    out.push('<path d="', inner, '" fill="url(#', id, '-keylight)"/>');
    out.push('<path d="', inner, '" fill="url(#', id, '-sheen)"/>');
    out.push('<g clip-path="url(#', id, '-face)"><rect x="', n(ix), '" y="', n(iy),
      '" width="', n(iw), '" height="', n(ih), '" filter="url(#', id,
      '-grain)" opacity=".055" style="mix-blend-mode:overlay"/></g>');
    return out.join("");
  }

  /*
   * A key stands proud of the plate and the camera is over the middle of the
   * shell, so a cap's top face is seen displaced outwards from its own base:
   * the keys on the left show the wall on their right, the ones on the right
   * show the wall on their left, and only a key dead centre shows none. It is
   * the same thing that makes a tower at the edge of an aerial photograph lean
   * away from the middle, and it is most of what separates a moulded cap from a
   * sticker. The vertical term falls out much smaller than the horizontal one
   * because it is the same displacement over a shell that is half as tall.
   */
  function parallax(L, cx, cy) {
    var reach = L.bodyW / 2;
    return {
      x: L.lift * (cx - L.cx) / reach,
      y: L.lift * (cy - L.cy) / reach,
    };
  }

  function control(id, L, spec, live) {
    var u = L.u, grow = spec.grow, rim = 0.45 * u;
    var off = parallax(L, spec.cx, spec.cy);
    // The base sits on the plate; the cap floats outwards off it, and the sliver
    // of base left showing on the inward side is the wall.
    var base = pillPath(spec.cx, spec.cy, spec.w, spec.h);
    var cap = pillPath(spec.cx + off.x, spec.cy + off.y, spec.w, spec.h);
    return [
      '<g class="ssd-ctl" data-ssd-channel="', spec.channel, '" data-ssd-control="', spec.name,
      '" style="--ssd-sink:', n(2.8 * u), 'px" role="button">',
      live ? "<title>" + spec.label + "</title>" : "",
      '<g class="ssd-shadow" opacity=".55" transform="translate(0 ', n(3.4 * u), ')">',
      '<path d="', base, '" fill="#000000" stroke="#000000" stroke-width="', n(grow * 2 + 2 * u),
      '" stroke-linejoin="round" filter="url(#', id, '-btnShadow)"/></g>',
      paint(base, "url(#" + id + "-wall)", grow),
      // Only the cap sinks under a press, into the wall it is standing on.
      '<g class="ssd-cap">',
      '<path d="', cap, '" fill="none" stroke="url(#', id,
      '-keyRim)" stroke-width="', n(grow * 2 + rim * 2), '" stroke-linejoin="round"/>',
      paint(cap, "url(#" + id + "-key)", grow),
      paint(cap, "url(#" + id + "-gloss)", grow, "ssd-gloss"),
      paint(cap, "url(#" + id + "-scene)", grow + rim),
      paint(cap, "#f7931a", grow, "ssd-hover"),
      paint(cap, "#000000", grow, "ssd-press"),
      "</g>",
      "</g>",
    ].join("");
  }

  // Five discrete keys in a diamond, and they are not all the same key turned
  // round: up and down are pills lying down, left and right are pills standing
  // up, and select is a true circle between them. The real device has no printed
  // glyphs on them, so neither does this; the accessible name carries the meaning.
  function padArt(id, L, live) {
    var u = L.u, cx = L.padCx, cy = L.cy, P = L.pad;
    var armW = P.armW * u, armH = P.armH * u;     // up and down
    var sideW = P.sideW * u, sideH = P.sideH * u; // left and right
    var mid = P.mid * u;                          // select, as wide as it is tall
    var dx = P.dx * u, dy = P.dy * u;
    var grow = 3 * u;
    var out = [];

    // No well and no faceplate: on the real device these five caps stand
    // straight out of the flat top plate.
    var keys = [
      ["up", CHANNEL.up, "Up", cx, cy - dy, armW, armH],
      ["down", CHANNEL.down, "Down", cx, cy + dy, armW, armH],
      ["left", CHANNEL.left, "Left", cx - dx, cy, sideW, sideH],
      ["right", CHANNEL.right, "Right", cx + dx, cy, sideW, sideH],
      ["select", CHANNEL.select, "Select", cx, cy, mid, mid],
    ];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      out.push(control(id, L, {
        name: k[0], channel: k[1], label: k[2], grow: grow,
        cx: k[3], cy: k[4], w: k[5], h: k[6],
      }, live));
    }
    return out.join("");
  }

  /*
   * The hat's case, off a photograph of it, in units of the glass's height.
   * The controls sit about a quarter of the way in from each end, leaving the
   * end caps empty, and the screen sits centred between them. A wider screen
   * lengthens the shell by exactly its extra width and moves nothing else, which
   * is how the Plus's 4:3 panel gets the same case.
   */
  function layout(screenW, screenH, scale) {
    var sw = Math.round(screenW * scale);
    var sh = Math.round(screenH * scale);
    var u = sh / 480;                    // one design unit; the art is pure ratio
    var L = { u: u, sw: sw, sh: sh };

    L.edge = 20 * u;                     // the rim
    L.bodyW = 1820 * u + (sw - sh);
    L.bodyH = 730 * u;
    L.radius = L.bodyH / 2;              // a true stadium, not a rounded rect

    L.padX = 12 * u;
    L.padT = 22 * u;
    L.padB = 58 * u;
    L.bodyX = L.padX;
    L.bodyY = L.padT;
    L.viewW = L.bodyW + L.padX * 2;
    L.viewH = L.bodyH + L.padT + L.padB;
    L.cx = L.bodyX + L.bodyW / 2;
    L.cy = L.bodyY + L.bodyH / 2;

    // Both clusters are large and open, because a thumb on a phone needs them
    // to be: clear gaps between the D-pad's keys, and the three on the right
    // lying-down pills spread to the shell's height and tall enough to stay a
    // thumb target.
    L.padCx = L.bodyX + 370 * u;         // D-pad centre
    L.pad = { armW: 125, armH: 80, sideW: 86, sideH: 118, mid: 120, dx: 160, dy: 165 };
    L.keyCx = L.bodyX + L.bodyW - 380 * u;
    L.keyW = 180 * u;                    // right-hand pills, and their spacing
    L.keyH = 106 * u;
    L.keyGap = 170 * u;
    // How far a cap's top face is seen displaced from its own base at the far
    // edge of the shell. Scales with the shell, so the effect is the same
    // photograph at any rendered size.
    L.lift = 5.5 * u;

    // The screen sits centred between the two clusters rather than in the
    // shell, so the gap either side of it is the same: from the D-pad's
    // outermost right edge to the pills' left edge.
    var padRight = L.padCx + (L.pad.dx + L.pad.sideW / 2) * u;
    var keysLeft = L.keyCx - L.keyW / 2;
    L.screenX = (padRight + keysLeft) / 2 - sw / 2;
    L.screenY = L.cy - sh / 2;
    // The pocket milled across the face for the display module: this much
    // wider than the glass on each side, and flared at the top.
    L.pocket = 60 * u;
    return L;
  }

  function screenArt(id, L, P) {
    var u = L.u, x = L.screenX, y = L.screenY, w = L.sw, h = L.sh;
    var ix = L.bodyX + L.edge, iy = L.bodyY + L.edge;
    var ih = L.bodyH - L.edge * 2, bottom = iy + ih;
    var pl = x - L.pocket, pr = x + w + L.pocket, flare = 60 * u, shoulder = y - 30 * u;
    var out = [];

    // The pocket: a flatter, paler floor across the face's full height, its
    // walls catching the light on the left and falling into shade on the right.
    var floor = "M" + n(pl - flare) + " " + n(iy) + "H" + n(pr + flare) +
      "L" + n(pr) + " " + n(shoulder) + "V" + n(bottom) + "H" + n(pl) +
      "V" + n(shoulder) + "Z";
    out.push('<g clip-path="url(#', id, '-face)">');
    out.push('<path d="', floor, '" fill="', P.pocket, '" opacity=".3"/>');
    out.push('<path d="', floor, '" fill="url(#', id, '-scene)"/>');
    out.push('<path d="M', n(pl - flare), ' ', n(iy), 'L', n(pl), ' ', n(shoulder), 'V', n(bottom),
      '" fill="none" stroke="#ffffff" stroke-opacity=".32" stroke-width="', n(3 * u), '"/>');
    out.push('<path d="M', n(pr + flare), ' ', n(iy), 'L', n(pr), ' ', n(shoulder), 'V', n(bottom),
      '" fill="none" stroke="#000000" stroke-opacity=".28" stroke-width="', n(3 * u), '"/>');
    out.push("</g>");

    // The module's black surround, then the glass.
    var m = 12 * u;
    out.push('<rect x="', n(x - m), '" y="', n(y - m), '" width="', n(w + m * 2),
      '" height="', n(h + m * 2), '" rx="', n(8 * u), '" fill="#0b0c0f"',
      ' stroke="#000000" stroke-opacity=".6" stroke-width="', n(2 * u), '"/>');
    out.push('<clipPath id="', id, '-well"><rect x="', n(x), '" y="', n(y),
      '" width="', n(w), '" height="', n(h), '" rx="', n(4 * u), '"/></clipPath>');
    out.push('<rect x="', n(x), '" y="', n(y), '" width="', n(w), '" height="', n(h),
      '" rx="', n(4 * u), '" fill="#04060a"/>');
    out.push('<g clip-path="url(#', id, '-well)">',
      '<rect x="', n(x), '" y="', n(y), '" width="', n(w), '" height="', n(26 * u),
      '" fill="url(#', id, '-wellTop)" opacity=".8"/></g>');
    return out.join("");
  }

  function keysArt(id, L, live) {
    var u = L.u, cx = L.keyCx, cy = L.cy;
    var gap = L.keyGap, grow = 3 * u;
    var out = [];
    var keys = [
      ["key1", CHANNEL.key1, "Key 1", cy - gap],
      ["key2", CHANNEL.key2, "Key 2", cy],
      ["key3", CHANNEL.key3, "Key 3", cy + gap],
    ];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      out.push(control(id, L, {
        name: k[0], channel: k[1], label: k[2], grow: grow,
        cx: cx, cy: k[3], w: L.keyW, h: L.keyH,
      }, live));
    }
    return out.join("");
  }

  var MODELS = {
    plus: { title: "SeedSigner Plus signing device", palette: PALETTES.plus },
    hat: {
      title: "SeedSigner signing device, Waveshare 1.3 inch display hat",
      palette: PALETTES.hat,
    },
  };

  function loadSvg(markup) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml" }));
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("the device art would not rasterise"));
      };
      img.src = url;
    });
  }

  /*
   * The glass as an image of its own, the same viewBox as the shell, so that it
   * can go over the screen once the screen has been drawn. Mirrors the CSS the
   * live .ssd-glass div is given: a 115deg sheen, and a soft inset shadow under
   * the top edge and a fainter one over the bottom.
   */
  function glassSvg(L) {
    var x = L.screenX, y = L.screenY, w = L.sw, h = L.sh;
    // A CSS angle gradient runs through the centre, along a line just long
    // enough that its ends touch the far corners.
    var a = 115 * Math.PI / 180, dx = Math.sin(a), dy = -Math.cos(a);
    var half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
    var cx = x + w / 2, cy = y + h / 2;
    var sheen = [[0, .075], [.13, .045], [.22, .012], [.30, 0], [.41, 0], [.47, .055],
                 [.53, .012], [.62, 0]];
    var stops = sheen.map(function (s) {
      return '<stop offset="' + s[0] + '" stop-color="#ffffff" stop-opacity="' + s[1] + '"/>';
    }).join("");
    var rect = ' x="' + n(x) + '" y="' + n(y) + '" width="' + n(w) + '" height="' + n(h) +
      '" rx="' + n(4 * L.u) + '"';
    return [
      '<svg xmlns="', SVG_NS, '" viewBox="0 0 ', n(L.viewW), " ", n(L.viewH),
      '" width="', n(L.viewW), '" height="', n(L.viewH), '">',
      "<defs>",
      '<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="', n(cx - dx * half),
      '" y1="', n(cy - dy * half), '" x2="', n(cx + dx * half), '" y2="', n(cy + dy * half), '">',
      stops, "</linearGradient>",
      '<linearGradient id="t" x1="0" y1="0" x2="0" y2="1">',
      '<stop offset="0" stop-color="#000000" stop-opacity=".5"/>',
      '<stop offset=".04" stop-color="#000000" stop-opacity="0"/>',
      '<stop offset=".97" stop-color="#000000" stop-opacity="0"/>',
      '<stop offset="1" stop-color="#000000" stop-opacity=".3"/>',
      "</linearGradient>",
      "</defs>",
      "<rect", rect, ' fill="url(#g)"/>',
      "<rect", rect, ' fill="url(#t)"/>',
      "</svg>",
    ].join("");
  }

  function render(container, options) {
    if (!container) throw new Error("SeedSignerDevice.render needs a container element");
    var o = options || {};
    var screenW = o.screenWidth > 0 ? o.screenWidth : 320;
    var screenH = o.screenHeight > 0 ? o.screenHeight : 240;
    var scale = o.scale > 0 ? o.scale : 2;
    var live = o.interactive !== false;
    var onKey = typeof o.onKey === "function" ? o.onKey : null;
    var model = MODELS[o.model] || (screenW === screenH ? MODELS.hat : MODELS.plus);

    injectStyle();
    var id = "ssd" + (++instances);   // gradients and filters must not collide
    var L = layout(screenW, screenH, scale);
    var P = model.palette;

    var svg = [
      '<svg class="ssd-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ',
      n(L.viewW), " ", n(L.viewH), '" preserveAspectRatio="xMidYMid meet" role="img"',
      live ? "" : ' aria-hidden="true"', ">",
      "<title>", model.title, "</title>",
      defs(id, L, P),
      bodyArt(id, L, P),
      screenArt(id, L, P),
      padArt(id, L, live),
      keysArt(id, L, live),
      "</svg>",
    ].join("");

    // Percentages, not pixels: the slot has to keep registration with the art no
    // matter what width the page gives us. Pixel offsets were why the canvas
    // walked off the shell on a phone.
    var slotStyle = "left:" + pct(L.screenX, L.viewW) + ";top:" + pct(L.screenY, L.viewH) +
      ";width:" + pct(L.sw, L.viewW) + ";height:" + pct(L.sh, L.viewH) +
      ";border-radius:" + n(4 / L.viewW * 100) + "%";
    // Glass last and inert: it must never eat a click or hide the firmware's pixels.
    var glassStyle = slotStyle +
      ";background:linear-gradient(115deg,rgba(255,255,255,.075) 0%," +
      "rgba(255,255,255,.045) 13%,rgba(255,255,255,.012) 22%,rgba(255,255,255,0) 30%," +
      "rgba(255,255,255,0) 41%,rgba(255,255,255,.055) 47%,rgba(255,255,255,.012) 53%," +
      "rgba(255,255,255,0) 62%)" +
      ";box-shadow:inset 0 .8vw 1.6vw -.6vw rgba(0,0,0,.65)," +
      "inset 0 -.5vw 1.2vw -.8vw rgba(0,0,0,.5)";

    container.innerHTML = svg +
      '<div class="ssd-screen-slot" style="' + slotStyle + '"></div>' +
      '<div class="ssd-glass" style="' + glassStyle + '"></div>';
    container.classList.add("ssd-root");
    container.classList.toggle("ssd-live", live);
    // The natural width has to be a real length: the front page measures this
    // container with width:max-content before scaling it.
    container.style.width = n(L.viewW) + "px";
    // A landscape shell handed a whole desktop viewport is far wider than anyone
    // wants, so callers can cap it; either way it still shrinks to fit a phone.
    container.style.maxWidth = o.maxWidth ? "min(" + o.maxWidth + ",100%)" : "100%";
    // The shell's own proportions, published for a page that wants to fit it to
    // a viewport rather than only to a width.
    container.style.setProperty("--ssd-aspect", n(L.viewW / L.viewH));

    var svgEl = container.querySelector(".ssd-svg");
    var slotEl = container.querySelector(".ssd-screen-slot");
    // The screen is not a control. It used to be the select key, on the grounds
    // that it is the biggest target on the shell, and it surprised everybody who
    // touched it: on the home menu a tap anywhere opened the camera. A
    // SeedSigner has no touchscreen, so only the drawn keys answer here either.
    if (live && onKey) bindControls(svgEl, onKey);

    /**
     * Show a press nobody's finger made.
     *
     * Keyboard presses drive this device through the same channel the firmware
     * reads GPIO on, which is invisible: the screen changed and nothing said
     * which of the eight keys did it. This is the same class a finger puts on,
     * held a little longer because there is no finger to lift off it.
     *
     * A key already down is left alone, so this cannot cut a real press short.
     */
    function flash(channel) {
      var key = svgEl.querySelector('[data-ssd-channel="' + channel + '"]');
      if (!key || key.classList.contains("ssd-down")) return;
      key.classList.add("ssd-down");
      setTimeout(function () { key.classList.remove("ssd-down"); }, FLASH_MS);
    }

    /**
     * The device as pictures rather than as a page, for something that composes
     * its own frames: `under` is the shell with `channel` held down (or none),
     * `over` is the glass that goes over the screen once it is drawn. Both are at
     * the viewBox's own size, which screenRect is measured in.
     *
     * Rasterised from a copy with its own stylesheet, so nothing on the page --
     * a hover, a key somebody is holding right now -- leaks into the picture.
     * `options.shadow === false` leaves out the drop shadow.
     */
    function snapshot(channel, options) {
      var copy = svgEl.cloneNode(true);
      // A recording frames the shell with a little even padding, too little for
      // the drop shadow's soft reach below it. Without the blur the path is
      // wholly covered by the rim and face, so only the shadow goes; the thin
      // contact shadow under the shell stays.
      if (options && options.shadow === false) {
        var drops = copy.querySelectorAll(".ssd-drop");
        for (var d = 0; d < drops.length; d++) drops[d].removeAttribute("filter");
      }
      copy.setAttribute("width", n(L.viewW));
      copy.setAttribute("height", n(L.viewH));
      var held = copy.querySelectorAll(".ssd-down");
      for (var i = 0; i < held.length; i++) held[i].classList.remove("ssd-down");
      if (channel) {
        var key = copy.querySelector('[data-ssd-channel="' + channel + '"]');
        if (key) key.classList.add("ssd-down");
      }
      var style = doc.createElementNS(SVG_NS, "style");
      style.textContent = SNAPSHOT_CSS;
      copy.insertBefore(style, copy.firstChild);
      return Promise.all([
        loadSvg(new XMLSerializer().serializeToString(copy)),
        loadSvg(glassSvg(L)),
      ]).then(function (images) {
        return { under: images[0], over: images[1] };
      });
    }

    return {
      svg: svgEl,
      press: flash,
      snapshot: snapshot,
      screen: slotEl,
      screenRect: { x: n(L.screenX), y: n(L.screenY), width: n(L.sw), height: n(L.sh) },
      // The shell itself, without the viewBox's padding, which is uneven: room
      // for the drop shadow below. What a recording centres.
      bodyRect: { x: n(L.bodyX), y: n(L.bodyY), width: n(L.bodyW), height: n(L.bodyH) },
      width: n(L.viewW),
      height: n(L.viewH),
    };
  }

  global.SeedSignerDevice = { render: render, CHANNEL: CHANNEL };
})(typeof window !== "undefined" ? window : this);
