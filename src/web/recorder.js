/*
 * Record the simulator to an MP4, in the browser, with nothing uploaded.
 *
 * Every frame is composed here, on a canvas nobody sees, from things the page
 * already has: the firmware's own 320x240 canvas and, for a device recording,
 * pictures of the drawn shell. Nothing is captured off the screen, so there is
 * no cursor to leave out and no hover glow to catch, no permission prompt, and a
 * tab in the background records the same as one in front.
 *
 * Encoding is WebCodecs H.264 and the container is mp4-muxer (vendored, see
 * THIRD-PARTY.md), which is what makes it an MP4 in every browser rather than a
 * WebM in some of them.
 *
 * The LCD is pixel perfect in both framings: every one of its pixels is a
 * square of whole video pixels, all one colour, starting on an even row and
 * column. Even, because H.264 keeps colour at half resolution in 2x2 blocks;
 * lined up that way, each block is exactly one LCD pixel and no colour bleeds
 * from one into the next.
 *
 * Frames are timestamped when they happen rather than on a fixed clock: the
 * firmware paints a few times a second at most, and a still screen is one frame
 * held, not thirty a second of the same thing. A heartbeat still adds one a
 * second so a player has something to seek to.
 */
(function (global) {
  "use strict";

  // Constrained Baseline, Baseline, Main, High, all at level 4.0, which is the
  // lowest that takes either shell: the Plus films at 1684x770, the hat at
  // 1524x770. Baseline first, everywhere: Safari's encoder, asked for Main or
  // High, holds every frame back for reordering and never hands one out, so
  // flush() never settles and Stop never saves. Firefox's OpenH264 only does
  // Baseline anyway, every player plays it, and for footage of a still UI it
  // costs next to nothing. Main and High stay as a last resort.
  var CODECS = ["avc1.42e028", "avc1.420028", "avc1.4d0028", "avc1.640028"];

  // How long Stop may wait for the encoder to hand back its last frames. It
  // takes well under a second; this is only so an encoder that has stopped
  // answering is reported, not waited on for ever.
  var FLUSH_TIMEOUT_MS = 15000;

  var HEARTBEAT_MS = 1000;
  var KEYFRAME_US = 2e6;
  // The last frame has no next one to measure its duration against.
  var FRAME_US = 33333;
  // Behind the shell in a device recording: the page's own near-black, or white.
  var BACKDROPS = { dark: "#0b0c0e", light: "#ffffff" };
  // Padding around the shell in a device recording, as a share of its height:
  // the same on every side, and enough for the contact shadow under it.
  var MARGIN = 0.08;
  // Video pixels per LCD pixel in a screen recording: the smallest that is
  // even, for the colour blocks. 640x480 for the Plus, 480x480 for the hat,
  // the same LCD size as a device recording.
  var SCREEN_SCALE = 2;
  // While a key is moving, frames come at this rate rather than only on change.
  var ANIMATE_MS = 1000 / 30;

  // CSS's ease-out, cubic-bezier(0, 0, .58, 1): the curve the page's keys move
  // on, so that a key on film moves as it does on the page.
  function easeOut(x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    var lo = 0, hi = 1, t = x;
    for (var i = 0; i < 24; i++) {
      t = (lo + hi) / 2;
      var bx = 3 * (1 - t) * t * t * 0.58 + t * t * t;
      if (bx < x) lo = t; else hi = t;
    }
    return 3 * (1 - t) * t * t + t * t * t;
  }

  /*
   * One key's motion, as the page's CSS transitions play it: when the key goes
   * down or up, its cap and its ring each set off from wherever they are
   * towards the new state, over MOTION's durations. amount() is 0 for up and
   * 1 for down.
   */
  function Motion(ms, down, now) {
    this.down = down;
    this.from = { cap: 0, glow: 0 };
    this.at = now;
    this.ms = ms;
  }
  Motion.prototype.amount = function (part, now) {
    var ms = part === "cap" ? this.ms.cap : this.down ? this.ms.glowIn : this.ms.glowOut;
    var to = this.down ? 1 : 0;
    var p = ms > 0 ? easeOut((now - this.at) / ms) : 1;
    return this.from[part] + (to - this.from[part]) * p;
  };
  Motion.prototype.turn = function (down, now) {
    this.from = { cap: this.amount("cap", now), glow: this.amount("glow", now) };
    this.down = down;
    this.at = now;
  };
  Motion.prototype.settled = function (now) {
    return now - this.at >= (this.down ? Math.max(this.ms.cap, this.ms.glowIn)
                                       : Math.max(this.ms.cap, this.ms.glowOut));
  };

  function even(v) { return Math.ceil(v / 2) * 2; }

  /**
   * The size of a device recording, and where the art goes in it: the shell
   * centred, with even padding round it. The art's own viewBox is padded
   * unevenly -- room for the drop shadow below -- so filming it as it stands
   * leaves the shell sitting high in the frame.
   */
  function frameSize(shell) {
    var body = shell.bodyRect, lcd = shell.screenRect;
    var margin = Math.round(body.height * MARGIN);
    var width = even(body.width + 2 * margin);
    var height = even(body.height + 2 * margin);
    var x = Math.round((width - body.width) / 2 - body.x);
    var y = Math.round((height - body.height) / 2 - body.y);
    // A pixel off centre at most, so the LCD starts on an even column and row.
    return {
      width: width,
      height: height,
      x: x + ((x + lcd.x) & 1),
      y: y + ((y + lcd.y) & 1),
    };
  }

  function encoderAvailable() {
    return typeof global.VideoEncoder === "function"
        && typeof global.VideoFrame === "function"
        && typeof global.Mp4Muxer === "object";
  }

  function pickCodec(width, height, bitrate) {
    if (!encoderAvailable()) return Promise.resolve(null);
    var i = 0;
    function next() {
      if (i >= CODECS.length) return Promise.resolve(null);
      var config = {
        codec: CODECS[i++], width: width, height: height, bitrate: bitrate,
        latencyMode: "quality", avc: { format: "avc" },
      };
      return global.VideoEncoder.isConfigSupported(config).then(function (answer) {
        return answer.supported ? answer.config : next();
      }, next);
    }
    return next();
  }

  // Whether this browser can film a device recording of this size (see
  // frameSize); the screen alone is smaller and comes with it.
  function supported(width, height) {
    return pickCodec(even(width), even(height), 5e6)
      .then(function (config) { return !!config; });
  }

  /**
   * Start recording. `mode` is "screen" or "device". `screen` is the firmware's
   * canvas; `device` returns the shell on the page, which is read once: the page
   * only mounts a new one when the firmware reports a new screen size, and that
   * is over before the first frame, which is before recording is offered.
   * `background` is "dark" or "light", for device recordings. `onError` hears
   * about an encoder that gave up.
   *
   * Resolves to a recording with frame() and stop().
   */
  function start(options) {
    var mode = options.mode === "screen" ? "screen" : "device";
    var screen = options.screen;
    var onError = options.onError || function () {};
    var shell = options.device();

    var backdrop = BACKDROPS[options.background] || BACKDROPS.dark;
    var width, height, place = { x: 0, y: 0 }, art = null;
    if (mode === "screen") {
      width = screen.width * SCREEN_SCALE; height = screen.height * SCREEN_SCALE;
    } else {
      place = frameSize(shell);
      width = place.width; height = place.height;
    }
    var bitrate = mode === "screen" ? 1e6 : 5e6;

    // Every look the shell can have, drawn before the first frame so that
    // composing one never waits: no key down, and each key's press in layers.
    var looks = mode === "device" ? prepareArt(shell) : Promise.resolve(null);

    return Promise.all([pickCodec(width, height, bitrate), looks]).then(function (got) {
      var config = got[0];
      art = got[1];
      if (!config) throw new Error("this browser cannot encode H.264 at " + width + "x" + height);
      return begin(config);
    });

    function begin(config) {
      var canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      var ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = false;

      var target = new global.Mp4Muxer.ArrayBufferTarget();
      var muxer = new global.Mp4Muxer.Muxer({
        target: target,
        video: { codec: "avc", width: width, height: height },
        fastStart: "in-memory",
        firstTimestampBehavior: "offset",
      });

      var failed = null;
      var encoder = new global.VideoEncoder({
        output: function (chunk, meta) { muxer.addVideoChunk(chunk, meta); },
        error: function (error) {
          if (failed) return;
          failed = error;
          halt();
          onError(error.message || String(error));
        },
      });
      encoder.configure(config);

      var startedAt = performance.now();
      var lastUs = -1, lastKeyUs = -Infinity;
      var retry = 0, stopped = false;
      // The LCD and the glass over it, put together at the LCD's own
      // resolution and only then scaled up, so each LCD pixel comes out one
      // colour: the glass's sheen, drawn at the shell's resolution, would
      // otherwise shade one LCD pixel differently across its width.
      var lcd = null, lcdCtx = null, glass = null;
      if (mode === "device") {
        var r0 = shell.screenRect;
        lcd = document.createElement("canvas");
        lcd.width = screen.width; lcd.height = screen.height;
        lcdCtx = lcd.getContext("2d");
        glass = document.createElement("canvas");
        glass.width = screen.width; glass.height = screen.height;
        var glassCtx = glass.getContext("2d");
        glassCtx.imageSmoothingQuality = "high";
        glassCtx.drawImage(art.over, r0.x, r0.y, r0.width, r0.height,
                           0, 0, glass.width, glass.height);
      }
      // Each key that is down or still moving, by channel.
      var moving = {}, tick = 0;
      var reduce = global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches;
      var ms = reduce ? { cap: 0, glowIn: 0, glowOut: 0 } : global.SeedSignerDevice.MOTION;

      // The keys go down and up by class on the page; follow them.
      function follow() {
        var now = performance.now(), down = {};
        var held = shell.svg.querySelectorAll(".ssd-down");
        for (var i = 0; i < held.length; i++) down[held[i].getAttribute("data-ssd-channel")] = true;
        for (var c in down) {
          if (!moving[c]) moving[c] = new Motion(ms, true, now);
          else if (!moving[c].down) moving[c].turn(true, now);
        }
        for (c in moving) if (moving[c].down && !down[c]) moving[c].turn(false, now);
        frame();
      }

      function compose() {
        if (mode === "screen") {
          ctx.drawImage(screen, 0, 0, width, height);
          return;
        }
        var r = shell.screenRect, now = performance.now(), busy = false;
        ctx.fillStyle = backdrop;
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(art.under, place.x, place.y);
        // Each key moving or down, as the page shows it at this moment: the
        // cap sunk by as much as it has travelled, the ring as bright as it
        // has come up or not yet died away.
        for (var c in moving) {
          var m = moving[c], cap = m.amount("cap", now), glow = m.amount("glow", now);
          if (cap > 0 && art.cap[c]) {
            // Only round the key, so two keys moving at once both show.
            var k = art.area[c];
            ctx.globalAlpha = cap;
            ctx.drawImage(art.cap[c], k.x, k.y, k.w, k.h, place.x + k.x, place.y + k.y, k.w, k.h);
          }
          if (glow > 0 && art.glow[c]) {
            ctx.globalAlpha = glow;
            ctx.drawImage(art.glow[c], place.x, place.y);
          }
          ctx.globalAlpha = 1;
          if (!m.settled(now)) busy = true;
          else if (!m.down) delete moving[c];
        }
        lcdCtx.clearRect(0, 0, lcd.width, lcd.height);
        lcdCtx.drawImage(screen, 0, 0);
        lcdCtx.drawImage(glass, 0, 0);
        ctx.drawImage(lcd, place.x + r.x, place.y + r.y, r.width, r.height);
        // A key in motion keeps asking for frames until it comes to rest.
        if (busy && !tick) tick = setTimeout(function () { tick = 0; frame(); }, ANIMATE_MS);
      }

      function encode(durationUs) {
        // Strictly increasing, or the muxer refuses the chunk.
        var us = Math.max(Math.round((performance.now() - startedAt) * 1000), lastUs + 1);
        compose();
        var frame = new global.VideoFrame(canvas, { timestamp: us, duration: durationUs });
        var key = us - lastKeyUs >= KEYFRAME_US;
        encoder.encode(frame, { keyFrame: key });
        frame.close();
        lastUs = us;
        if (key) lastKeyUs = us;
      }

      // Asked for whenever something visible changed: a firmware frame, a key
      // going down or coming up. A backed-up encoder gets one retry shortly,
      // rather than a queue of stale frames or a dropped change.
      function frame() {
        if (stopped || failed) return;
        if (encoder.encodeQueueSize > 4) {
          if (!retry) retry = setTimeout(function () { retry = 0; frame(); }, 30);
          return;
        }
        try {
          encode(FRAME_US);
        } catch (error) {
          failed = error;
          halt();
          onError(error.message || String(error));
        }
      }

      var heartbeat = setInterval(frame, HEARTBEAT_MS);
      var watcher = null;
      if (mode === "device") {
        // The keys are only ever pressed by class, so a class change is a press.
        watcher = new MutationObserver(follow);
        watcher.observe(shell.svg, { subtree: true, attributes: true, attributeFilter: ["class"] });
      }

      function halt() {
        stopped = true;
        clearInterval(heartbeat);
        clearTimeout(retry);
        clearTimeout(tick);
        if (watcher) watcher.disconnect();
      }

      function stop() {
        if (failed) return Promise.reject(failed);
        if (stopped) return Promise.reject(new Error("already stopped"));
        // The screen that was up when Stop was pressed, held until then.
        encode(FRAME_US);
        halt();
        var stuck = new Promise(function (_, reject) {
          setTimeout(function () {
            reject(new Error("the browser's video encoder stopped responding"));
          }, FLUSH_TIMEOUT_MS);
        });
        return Promise.race([encoder.flush(), stuck]).then(function () {
          muxer.finalize();
          encoder.close();
          return new Blob([target.buffer], { type: "video/mp4" });
        }, function (error) {
          try { encoder.close(); } catch (ignored) { /* already closed */ }
          throw error;
        });
      }

      frame();
      return { frame: frame, stop: stop, mode: mode, width: width, height: height };
    }
  }

  // The shell with no key down, and for each key its sunk cap and its ring as
  // layers to go over that, which compose() blends in as far as each has moved.
  function prepareArt(shell) {
    var channels = [];
    for (var name in global.SeedSignerDevice.CHANNEL) {
      channels.push(String(global.SeedSignerDevice.CHANNEL[name]));
    }
    // Where each key's press changes the picture: the key and the shadow it
    // stops casting when it goes down, in the viewBox units a snapshot is in.
    var area = {};
    channels.forEach(function (c) {
      var box = shell.svg.querySelector('[data-ssd-channel="' + c + '"]').getBBox();
      var pad = box.width * 0.25;
      area[c] = { x: box.x - pad, y: box.y - pad, w: box.width + pad * 2, h: box.height + pad * 2 };
    });
    var shots = [shell.snapshot("", { shadow: false })];
    channels.forEach(function (c) {
      shots.push(shell.snapshot(c, { shadow: false, layer: "cap" }));
      shots.push(shell.snapshot(c, { shadow: false, layer: "glow" }));
    });
    return Promise.all(shots).then(function (got) {
      var art = { under: got[0].under, over: got[0].over, cap: {}, glow: {}, area: area };
      for (var i = 0; i < channels.length; i++) {
        art.cap[channels[i]] = got[1 + i * 2].under;
        art.glow[channels[i]] = got[2 + i * 2].under;
      }
      return art;
    });
  }

  global.SimRecorder = { supported: supported, start: start, frameSize: frameSize };
})(typeof window !== "undefined" ? window : this);
