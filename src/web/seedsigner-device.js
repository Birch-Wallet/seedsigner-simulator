/*
 * Procedural SeedSigner device art, in the two builds the firmware has a panel for.
 *
 * Both are one shell, taken off a photograph of the orange anodised case: a
 * stadium with a silver rim, the screen sunk in a rounded recess, and eight
 * round aluminium keys on one pitch -- a five-key D-pad on the left and three
 * stacked on the right.
 *
 * The SeedSigner Plus (320x240) is the case in the photograph. The original
 * Waveshare 1.3" hat (240x240) is the same case shortened by the difference in
 * screen width, which moves nothing else.
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

  // What a key looks like held down, shared by the live page and a snapshot.
  // It has to read in a recording at a glance, so it is not subtle: the cap
  // drops straight into its hole, losing the side wall it stood on, shrinks
  // with the distance, is shaded by the lip of the hole, and a warm ring of
  // light comes up round it.
  var PRESSED = [
    [".ssd-cap", "transform:translate(var(--ssd-px,0),var(--ssd-py,2px)) scale(.86)"],
    [".ssd-press", "opacity:1"],
    [".ssd-glow", "opacity:1"],
    [".ssd-hover", "opacity:.08"],
    [".ssd-shadow", "opacity:0"],
    [".ssd-wall", "opacity:0"],
    [".ssd-gloss", "opacity:.35"],
  ];

  // How a key moves, in milliseconds, all eased out: the cap goes down and
  // comes back up in `cap`, the ring comes up in `glowIn` and dies away in
  // `glowOut`, so it outlives the press a little. Published so that a recording
  // can play the same motion frame by frame.
  var MOTION = { cap: 60, glowIn: 30, glowOut: 400 };

  function secs(ms) { return ms / 1000 + "s"; }

  function pressedRules(scope) {
    return PRESSED.map(function (r) {
      return scope + ".ssd-ctl.ssd-down " + r[0] + "{" + r[1] + "}";
    });
  }

  // Shared by both: the cap shrinks about its own centre.
  var BASE_CSS = [
    ".ssd-cap{transform-box:fill-box;transform-origin:center}",
    ".ssd-ctl .ssd-hover,.ssd-ctl .ssd-press,.ssd-ctl .ssd-glow{opacity:0}",
  ];

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
  ].concat(BASE_CSS, [
    // Only a live device reacts; the decorative build stays inert illustration.
    ".ssd-live .ssd-ctl{pointer-events:auto;cursor:pointer}",
    ".ssd-live .ssd-cap{transition:transform " + secs(MOTION.cap) + " ease-out}",
    ".ssd-live .ssd-ctl .ssd-hover{transition:opacity .13s ease}",
    ".ssd-live .ssd-ctl .ssd-glow{transition:opacity " + secs(MOTION.glowOut) + " ease-out}",
    ".ssd-live .ssd-ctl.ssd-down .ssd-glow{transition-duration:" + secs(MOTION.glowIn) + "}",
    // Hover only where there is a pointer that can hover. A touch that lands on
    // a key would otherwise leave it lit until something else was touched.
    "@media (hover:hover){.ssd-live .ssd-ctl:hover .ssd-hover{opacity:.2}}",
    // Pressed is a class rather than :active, because :active under touch is
    // whatever the browser feels like: Safari does not apply it at all without a
    // touch handler, and every engine drops it the moment a finger drifts. The
    // class goes on when the key is pressed and stays long enough to be seen.
  ], pressedRules(".ssd-live "), [
    "@media (prefers-reduced-motion:reduce){.ssd-live .ssd-cap,",
    ".ssd-live .ssd-ctl .ssd-hover,.ssd-live .ssd-ctl .ssd-glow{transition:none}}",
  ]).join("\n");

  // The pressed look alone, for a snapshot: the same rules as above without the
  // .ssd-live gate, and without any :hover, because a picture of the device has
  // no pointer over it and must not show where one happened to be.
  var SNAPSHOT_CSS = BASE_CSS.concat(pressedRules("")).join("\n");

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

  // The case's colours, shared by both builds. Everything that lights it (the
  // chamfer, the sheen, the key light) is drawn in white and black over these.
  var PALETTE = {
    body: ["#f48a3c", "#e2732a", "#d0611f", "#b75116"],   // anodised orange
    outline: "#141518", band: "#b9bdc2",                  // a silver rim
    key: ["#f4f5f6", "#d5d8db", "#aaaeb4", "#7d828a"],    // turned aluminium
    wall: ["#50545a", "#71757b", "#969aa0"],
  };

  function defs(id, L, P) {
    var u = L.u;
    var space = 'gradientUnits="userSpaceOnUse"';
    var bodyBox = ' x1="' + n(L.bodyX) + '" y1="' + n(L.bodyY) + '" x2="' +
      n(L.bodyX + L.bodyW) + '" y2="' + n(L.bodyY + L.bodyH) + '"';
    return [
      "<defs>",
      // Shell top face: key light upper-left, falling away to the lower right.
      // Flatter than a glossy consumer shell: the real one is matte anodising.
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
      // Aluminium key caps, gently domed: lit off centre towards the light and
      // rolling off to the edge all the way round.
      '<radialGradient id="', id, '-key" cx=".4" cy=".34" r=".72">',
      '<stop offset="0" stop-color="', P.key[0], '"/>',
      '<stop offset=".5" stop-color="', P.key[1], '"/>',
      '<stop offset=".86" stop-color="', P.key[2], '"/>',
      '<stop offset="1" stop-color="', P.key[3], '"/>',
      "</radialGradient>",
      // Turned aluminium: fine concentric rings from the lathe.
      '<radialGradient id="', id, '-turned" cx=".5" cy=".5" r=".5" spreadMethod="repeat"',
      ' gradientTransform="translate(.5 .5) scale(.035) translate(-.5 -.5)">',
      '<stop offset="0" stop-color="#ffffff" stop-opacity="0"/>',
      '<stop offset=".5" stop-color="#ffffff" stop-opacity=".07"/>',
      '<stop offset="1" stop-color="#000000" stop-opacity=".03"/>',
      "</radialGradient>",
      // The window reflected in the dome.
      '<radialGradient id="', id, '-spec" cx=".36" cy=".28" r=".3">',
      '<stop offset="0" stop-color="#ffffff" stop-opacity=".85"/>',
      '<stop offset=".45" stop-color="#ffffff" stop-opacity=".25"/>',
      '<stop offset="1" stop-color="#ffffff" stop-opacity="0"/>',
      "</radialGradient>",
      // A cap pushed in is shaded by the lip of its hole, heavily at the top.
      '<radialGradient id="', id, '-pressShade" cx=".5" cy=".62" r=".62">',
      '<stop offset="0" stop-color="#000000" stop-opacity=".24"/>',
      '<stop offset=".7" stop-color="#000000" stop-opacity=".42"/>',
      '<stop offset="1" stop-color="#000000" stop-opacity=".72"/>',
      "</radialGradient>",
      '<radialGradient id="', id, '-hole" cx=".5" cy=".5" r=".5">',
      '<stop offset=".8" stop-color="#0c0603" stop-opacity=".9"/>',
      '<stop offset=".93" stop-color="#1c0d05" stop-opacity=".75"/>',
      '<stop offset="1" stop-color="#1c0d05" stop-opacity="0"/>',
      "</radialGradient>",
      // The case's side, seen below the top face: brushed silver, brightest
      // where it turns under the rim.
      '<linearGradient id="', id, '-side" ', space, ' x1="0" y1="', n(L.bodyY + L.bodyH * 0.5),
      '" x2="0" y2="', n(L.bodyY + L.bodyH + L.depth), '">',
      '<stop offset="0" stop-color="#e9ebed"/>',
      '<stop offset=".82" stop-color="#c9cdd1"/>',
      '<stop offset=".9" stop-color="#eef0f2"/>',
      '<stop offset="1" stop-color="#8b9096"/>',
      "</linearGradient>",
      // The face's own edge, rounded over into the rim: catching the light
      // along the top and turning away from it along the bottom.
      '<linearGradient id="', id, '-faceEdge" x1="0" y1="0" x2=".25" y2="1">',
      '<stop offset="0" stop-color="#ffffff" stop-opacity=".55"/>',
      '<stop offset=".35" stop-color="#ffffff" stop-opacity=".08"/>',
      '<stop offset=".65" stop-color="#000000" stop-opacity=".06"/>',
      '<stop offset="1" stop-color="#000000" stop-opacity=".35"/>',
      "</linearGradient>",
      '<linearGradient id="', id, '-sideH" ', space, bodyBox, ">",
      '<stop offset="0" stop-color="#ffffff" stop-opacity=".18"/>',
      '<stop offset=".5" stop-color="#ffffff" stop-opacity="0"/>',
      '<stop offset="1" stop-color="#000000" stop-opacity=".22"/>',
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
      '<linearGradient id="', id, '-recess" x1="0" y1="0" x2="0" y2="1">',
      '<stop offset="0" stop-color="#000000" stop-opacity=".32"/>',
      '<stop offset=".5" stop-color="#000000" stop-opacity=".06"/>',
      '<stop offset="1" stop-color="#ffffff" stop-opacity=".3"/>',
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
      '<filter id="', id, '-glowBlur" x="-60%" y="-60%" width="220%" height="220%">',
      '<feGaussianBlur stdDeviation="', n(6.5 * u), '"/>',
      '<feComponentTransfer><feFuncA type="linear" slope="3.2"/></feComponentTransfer>',
      "</filter>",
      // Brushed: noise stretched along one axis.
      '<filter id="', id, '-brush" x="0" y="0" width="100%" height="100%">',
      '<feTurbulence type="fractalNoise" baseFrequency=".004 .9" numOctaves="2" stitchTiles="stitch"/>',
      '<feColorMatrix type="saturate" values="0"/>',
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
    // The top face and the silver side under it, as a camera a little above
    // the table sees them: the same stadium carried down by the case's depth.
    var solid = roundRectPath(x, y, w, h + L.depth, L.radius);
    var band = ' d="' + outer + inner + '" fill-rule="evenodd"';
    var out = [];

    out.push('<ellipse cx="', n(x + w / 2), '" cy="', n(y + h + L.depth + 3 * u),
      '" rx="', n(w * 0.45), '" ry="', n(10 * u),
      '" fill="#000000" opacity=".75" filter="url(#', id, '-contact)"/>');

    out.push('<path class="ssd-drop" d="', solid, '" fill="', P.outline,
      '" filter="url(#', id, '-drop)"/>');
    out.push('<path d="', solid, '" fill="url(#', id, '-side)"/>');
    out.push('<path d="', solid, '" fill="url(#', id, '-sideH)"/>');
    out.push('<clipPath id="', id, '-solid"><path d="', solid, '"/></clipPath>');
    out.push('<g clip-path="url(#', id, '-solid)"><rect x="', n(x), '" y="', n(y + h * 0.5),
      '" width="', n(w), '" height="', n(h * 0.5 + L.depth), '" filter="url(#', id,
      '-brush)" opacity=".12" style="mix-blend-mode:overlay"/></g>');
    // The seam where the face's edge turns down into the side.
    out.push('<path d="', outer, '" fill="none" stroke="#000000" stroke-opacity=".22"',
      ' stroke-width="', n(1.2 * u), '"/>');
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
      '-grain)" opacity=".09" style="mix-blend-mode:overlay"/></g>');
    out.push('<g clip-path="url(#', id, '-face)"><path d="', inner, '" fill="none" stroke="url(#', id,
      '-faceEdge)" stroke-width="', n(7 * u), '"/></g>');
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
    var u = L.u, r = L.keyD / 2, rim = 0.8 * u;
    var off = parallax(L, spec.cx, spec.cy);
    var cx = spec.cx, cy = spec.cy;
    function disc(x, y, radius, attrs) {
      return '<circle cx="' + n(x) + '" cy="' + n(y) + '" r="' + n(radius) + '" ' + attrs + "/>";
    }
    // The base sits on the plate; the cap floats outwards off it, and the sliver
    // of base left showing on the inward side is the wall. A press puts the cap
    // back over its base, a little down, into the hole.
    var kx = cx + off.x, ky = cy + off.y;
    return [
      '<g class="ssd-ctl" data-ssd-channel="', spec.channel, '" data-ssd-control="', spec.name,
      '" style="--ssd-px:', n(-off.x), 'px;--ssd-py:', n(-off.y + 1.6 * u), 'px" role="button">',
      live ? "<title>" + spec.label + "</title>" : "",
      // The keys are drawn at the photograph's size, which on a phone is a
      // little under a thumb; this unpainted disc takes the target out to most
      // of the pitch, still leaving clear space between neighbours.
      disc(cx, cy, L.hit / 2, 'fill="transparent"'),
      // The hole in the case the key comes up through.
      disc(cx, cy, r + 4 * u, 'fill="url(#' + id + '-hole)"'),
      // Lit on a press. Its geometry stays inside the target disc, so the key
      // measures the same up or down; only the blur spills past it.
      '<g class="ssd-glow">',
      '<g filter="url(#' + id + '-glowBlur)">',
      disc(cx, cy, r + 2 * u, 'fill="none" stroke="#ffe9b8" stroke-width="' + n(4 * u) + '"'),
      disc(cx, cy, r + 2 * u, 'fill="none" stroke="#ffffff" stroke-width="' + n(4 * u) + '"'),
      "</g>",
      disc(cx, cy, r + 2 * u, 'fill="none" stroke="#fff7e6" stroke-opacity=".95" stroke-width="' +
        n(2 * u) + '"'),
      "</g>",
      '<g class="ssd-shadow" opacity=".6" transform="translate(', n(off.x * 0.6), " ", n(3.8 * u), ')">',
      disc(cx, cy, r + 1.5 * u, 'fill="#000000" filter="url(#' + id + '-btnShadow)"'),
      "</g>",
      disc(cx, cy, r, 'class="ssd-wall" fill="url(#' + id + '-wall)"'),
      '<g class="ssd-cap">',
      disc(kx, ky, r, 'fill="url(#' + id + '-key)"'),
      disc(kx, ky, r, 'fill="url(#' + id + '-turned)"'),
      disc(kx, ky, r, 'class="ssd-gloss" fill="url(#' + id + '-spec)"'),
      disc(kx, ky, r, 'fill="url(#' + id + '-scene)"'),
      // The chamfer round the cap's edge: bright where it faces the light.
      disc(kx, ky, r - rim / 2, 'fill="none" stroke="url(#' + id + '-keyRim)" stroke-width="' +
        n(rim) + '"'),
      disc(kx, ky, r, 'class="ssd-hover" fill="#f7931a"'),
      disc(kx, ky, r, 'class="ssd-press" fill="url(#' + id + '-pressShade)"'),
      "</g>",
      "</g>",
    ].join("");
  }

  // Five round keys in a plus, one pitch apart in both directions. The real
  // device has no printed glyphs on them, so neither does this; the accessible
  // name carries the meaning.
  function padArt(id, L, live) {
    var cx = L.padCx, cy = L.cy, p = L.pitch;
    var out = [];

    // No well and no faceplate: on the real device these five caps stand
    // straight out of the flat top plate.
    var keys = [
      ["up", CHANNEL.up, "Up", cx, cy - p],
      ["down", CHANNEL.down, "Down", cx, cy + p],
      ["left", CHANNEL.left, "Left", cx - p, cy],
      ["right", CHANNEL.right, "Right", cx + p, cy],
      ["select", CHANNEL.select, "Select", cx, cy],
    ];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      out.push(control(id, L, {
        name: k[0], channel: k[1], label: k[2], cx: k[3], cy: k[4],
      }, live));
    }
    return out.join("");
  }

  /*
   * The case, off a photograph of the Plus, in units of the glass's height (the
   * photograph's verticals are corrected for its slightly raised camera). The
   * controls sit a fifth of the way in from each end, leaving the end caps
   * empty, and the screen sits centred between them. A narrower screen shortens
   * the shell by exactly its missing width and moves nothing else, which is how
   * the hat's square panel gets the same case.
   */
  function layout(screenW, screenH, scale) {
    var sw = Math.round(screenW * scale);
    var sh = Math.round(screenH * scale);
    var u = sh / 480;                    // one design unit; the art is pure ratio
    var L = { u: u, sw: sw, sh: sh };

    L.edge = 18 * u;                     // the rim
    L.bodyW = 1418 * u + (sw - sh);
    L.bodyH = 641 * u;
    L.radius = L.bodyH / 2;              // a true stadium, not a rounded rect

    // The case's silver side, showing under the top face.
    L.depth = 22 * u;

    L.padX = 12 * u;
    L.padT = 22 * u;
    L.padB = 36 * u + L.depth;
    L.bodyX = L.padX;
    L.bodyY = L.padT;
    L.viewW = L.bodyW + L.padX * 2;
    L.viewH = L.bodyH + L.padT + L.padB;
    L.cx = L.bodyX + L.bodyW / 2;
    L.cy = L.bodyY + L.bodyH / 2;

    // Every key is the same round button, and every neighbour is the same
    // distance away, across the D-pad and down the three on the right.
    L.keyD = 84 * u;                     // a key's visible diameter
    L.pitch = 118 * u;                   // centre to centre
    L.hit = L.pitch - 26 * u;            // what a finger can press
    L.padCx = L.bodyX + 304 * u;         // D-pad centre
    L.keyCx = L.bodyX + L.bodyW - 257 * u;
    // How far a cap's top face is seen displaced from its own base at the far
    // edge of the shell. Scales with the shell, so the effect is the same
    // photograph at any rendered size.
    L.lift = 5.5 * u;

    // The screen sits centred between the two clusters rather than in the
    // shell, so the gap either side of it is the same: from the D-pad's
    // outermost right edge to the right-hand keys' left edge.
    var padRight = L.padCx + L.pitch + L.keyD / 2;
    var keysLeft = L.keyCx - L.keyD / 2;
    // On whole units, so a recording can put every LCD pixel on whole video
    // pixels; the half unit it may move is invisible.
    L.screenX = Math.round((padRight + keysLeft) / 2 - sw / 2);
    L.screenY = Math.round(L.cy - sh / 2);
    return L;
  }

  function screenArt(id, L) {
    var u = L.u, x = L.screenX, y = L.screenY, w = L.sw, h = L.sh;
    var m = 12 * u;                      // the module's black surround
    var out = [];

    // The recess the module sits in: a rounded step down into the face, its
    // upper wall in shade and its lower lip catching the light.
    var lip = 14 * u;
    var recess = roundRectPath(x - m - lip, y - m - lip, w + (m + lip) * 2,
      h + (m + lip) * 2, 26 * u);
    out.push('<path d="', recess, '" fill="#000000" opacity=".1"/>');
    out.push('<path d="', recess, '" fill="none" stroke="url(#', id,
      '-recess)" stroke-width="', n(5 * u), '"/>');

    // The module's black surround, then the glass.
    out.push('<rect x="', n(x - m), '" y="', n(y - m), '" width="', n(w + m * 2),
      '" height="', n(h + m * 2), '" rx="', n(16 * u), '" fill="#0b0c0f"',
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
    var cx = L.keyCx, cy = L.cy, p = L.pitch;
    var out = [];
    var keys = [
      ["key1", CHANNEL.key1, "Key 1", cy - p],
      ["key2", CHANNEL.key2, "Key 2", cy],
      ["key3", CHANNEL.key3, "Key 3", cy + p],
    ];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      out.push(control(id, L, {
        name: k[0], channel: k[1], label: k[2], cx: cx, cy: k[3],
      }, live));
    }
    return out.join("");
  }

  var MODELS = {
    plus: { title: "SeedSigner Plus signing device" },
    hat: { title: "SeedSigner signing device, Waveshare 1.3 inch display hat" },
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
    var P = PALETTE;

    var svg = [
      '<svg class="ssd-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ',
      n(L.viewW), " ", n(L.viewH), '" preserveAspectRatio="xMidYMid meet" role="img"',
      live ? "" : ' aria-hidden="true"', ">",
      "<title>", model.title, "</title>",
      defs(id, L, P),
      bodyArt(id, L, P),
      screenArt(id, L),
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
     *
     * A press is two things that move on different clocks (see MOTION), so a
     * caller animating one can ask for them apart: `options.layer === "cap"` is
     * the shell with the key down but its ring unlit, and "glow" is the ring
     * alone on a transparent picture.
     */
    function snapshot(channel, options) {
      var layer = options && options.layer;
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
      var key = channel ? copy.querySelector('[data-ssd-channel="' + channel + '"]') : null;
      if (key) key.classList.add("ssd-down");
      if (layer === "glow") {
        var ring = key && key.querySelector(".ssd-glow");
        for (var c = copy.lastElementChild; c; ) {
          var prev = c.previousElementSibling;
          if (c.tagName !== "defs") copy.removeChild(c);
          c = prev;
        }
        if (ring) copy.appendChild(ring);
      }
      var style = doc.createElementNS(SVG_NS, "style");
      style.textContent = SNAPSHOT_CSS + (layer === "cap" ? "\n.ssd-glow{display:none}" :
        layer === "glow" ? "\n.ssd-glow{opacity:1}" : "");
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
      bodyRect: { x: n(L.bodyX), y: n(L.bodyY), width: n(L.bodyW), height: n(L.bodyH + L.depth) },
      width: n(L.viewW),
      height: n(L.viewH),
    };
  }

  global.SeedSignerDevice = { render: render, CHANNEL: CHANNEL, MOTION: MOTION };
})(typeof window !== "undefined" ? window : this);
