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

  // High, Main, Constrained Baseline, Baseline, all at level 4.0, which is the
  // lowest that takes either shell: the Plus films at 2004x810, the hat at
  // 1844x810. Firefox's encoder is OpenH264 and only does baseline, so the
  // list has to reach that far.
  var CODECS = ["avc1.640028", "avc1.4d0028", "avc1.42e028", "avc1.420028"];

  var HEARTBEAT_MS = 1000;
  var KEYFRAME_US = 2e6;
  // The last frame has no next one to measure its duration against.
  var FRAME_US = 33333;
  // The page's own background, under the shell's shadow and the spare even row.
  var BACKDROP = "#0b0c0e";

  function even(v) { return Math.ceil(v / 2) * 2; }

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

  // Whether this browser can film a device of this size; the screen alone is
  // smaller and comes with it.
  function supported(width, height) {
    return pickCodec(even(width), even(height), 5e6)
      .then(function (config) { return !!config; });
  }

  /**
   * Start recording. `mode` is "screen" or "device". `screen` is the firmware's
   * canvas; `device` returns the shell on the page, which is read once: the page
   * only mounts a new one when the firmware reports a new screen size, and that
   * is over before the first frame, which is before recording is offered. `onError` hears about an encoder that gave up.
   *
   * Resolves to a recording with frame() and stop().
   */
  function start(options) {
    var mode = options.mode === "screen" ? "screen" : "device";
    var screen = options.screen;
    var onError = options.onError || function () {};
    var shell = options.device();

    var width, height, art = null;
    if (mode === "screen") {
      width = screen.width; height = screen.height;
    } else {
      width = even(shell.width); height = even(shell.height);
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
        ctx.fillStyle = BACKDROP;
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(art.under[channel] || art.under[""], 0, 0);
        ctx.drawImage(screen, r.x, r.y, r.width, r.height);
        ctx.drawImage(art.over, 0, 0);
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
        return encoder.flush().then(function () {
          muxer.finalize();
          encoder.close();
          return new Blob([target.buffer], { type: "video/mp4" });
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
    return Promise.all(channels.map(function (c) { return shell.snapshot(c); }))
      .then(function (shots) {
        var under = {};
        for (var i = 0; i < channels.length; i++) under[channels[i]] = shots[i].under;
        return { under: under, over: shots[0].over };
      });
  }

  global.SimRecorder = { supported: supported, start: start };
})(typeof window !== "undefined" ? window : this);
