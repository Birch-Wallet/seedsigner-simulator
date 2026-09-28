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
 * Frames are timestamped when they happen rather than on a fixed clock: the
 * firmware paints a few times a second at most, and a still screen is one frame
 * held, not thirty a second of the same thing. A heartbeat still adds one a
 * second so a player has something to seek to.
 */
(function (global) {
  "use strict";

  // Constrained Baseline, Baseline, Main, High, all at level 4.0, which is the
  // lowest that takes either shell: the Plus films at 2096x846, the hat at
  // 1936x846. Baseline first, everywhere: Safari's encoder, asked for Main or
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

  function even(v) { return Math.ceil(v / 2) * 2; }

  /**
   * The size of a device recording, and where the art goes in it: the shell
   * centred, with even padding round it. The art's own viewBox is padded
   * unevenly -- room for the drop shadow below -- so filming it as it stands
   * leaves the shell sitting high in the frame.
   */
  function frameSize(shell) {
    var body = shell.bodyRect;
    var margin = Math.round(body.height * MARGIN);
    var width = even(body.width + 2 * margin);
    var height = even(body.height + 2 * margin);
    return {
      width: width,
      height: height,
      x: Math.round((width - body.width) / 2 - body.x),
      y: Math.round((height - body.height) / 2 - body.y),
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
      width = screen.width; height = screen.height;
    } else {
      place = frameSize(shell);
      width = place.width; height = place.height;
    }
    var bitrate = mode === "screen" ? 1e6 : 5e6;

    // Every look the shell can have, drawn before the first frame so that
    // composing one never waits: no key down, and each of the eight down.
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

      function compose() {
        if (mode === "screen") {
          ctx.drawImage(screen, 0, 0, width, height);
          return;
        }
        var svg = shell.svg;
        var down = svg && svg.querySelector(".ssd-down");
        var channel = down ? down.getAttribute("data-ssd-channel") : "";
        var r = shell.screenRect;
        ctx.fillStyle = backdrop;
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(art.under[channel] || art.under[""], place.x, place.y);
        ctx.drawImage(screen, place.x + r.x, place.y + r.y, r.width, r.height);
        ctx.drawImage(art.over, place.x, place.y);
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
        watcher = new MutationObserver(frame);
        watcher.observe(shell.svg, { subtree: true, attributes: true, attributeFilter: ["class"] });
      }

      function halt() {
        stopped = true;
        clearInterval(heartbeat);
        clearTimeout(retry);
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

  function prepareArt(shell) {
    var channels = [""];
    for (var name in global.SeedSignerDevice.CHANNEL) {
      channels.push(String(global.SeedSignerDevice.CHANNEL[name]));
    }
    return Promise.all(channels.map(function (c) { return shell.snapshot(c, { shadow: false }); }))
      .then(function (shots) {
        var under = {};
        for (var i = 0; i < channels.length; i++) under[channels[i]] = shots[i].under;
        return { under: under, over: shots[0].over };
      });
  }

  global.SimRecorder = { supported: supported, start: start, frameSize: frameSize };
})(typeof window !== "undefined" ? window : this);
