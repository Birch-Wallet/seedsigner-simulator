"""
Threads for a port that has none: SeedSigner's animation threads, run as green
threads.

SeedSigner draws everything that moves from a background thread: the spinner
while a PSBT parses, the pulsing edge of a warning, a label too long for its
button scrolling along, an animated QR, the camera preview. Pyodide is one
thread, so for a long time this port dropped every such thread and pumped the
two it could not live without by hand.

**How a thread runs here.** Every one of those threads gives way at points
written directly in its own run(): a time.sleep, the end of a pass of its
`while self.keep_running` loop, a `with renderer.lock`. So its run() is
recompiled, in memory, into a generator that pauses at exactly those points,
and a scheduler takes turns between the generators and the firmware's main
stack. The files under seedsigner/ are left as they are, but this changes what
the firmware runs: the transformed run() exists only in this process, a runtime
substitution like the port's others (wait_for, for one).

The main stack gives the threads their turns wherever it would have blocked on
a device -- waiting for a key, sleeping, waiting on a lock -- and, because the
spinner is always started just before heavy work, on a tick as well: the page
writes SIGINT into Pyodide's interrupt buffer every 80ms while a thread is
live, CPython checks it between bytecodes, and the handler steps whatever is
due. One long C call (PBKDF2) cannot be interrupted, so the spinner holds still
for it and then carries on.
"""

import ast
import inspect
import itertools
import signal
import textwrap
import threading
import time

_real_sleep = time.sleep
_now = time.monotonic

# Supplied by install().
_js = None
_log = lambda message: None

# The fastest a thread that never sleeps is stepped: one pass of its loop per
# frame, the same floor the display driver holds every frame to.
FRAME = 0.08

MAIN = "main"

# What each kind of thread becomes. Anything loop-shaped and not listed here is
# dropped, as it always was.
GREEN = {
    "LoadingScreenThread",          # the spinner
    "ProgressThread",               # address verification's progress
    "WarningEdgesThread",           # the pulsing edge of a warning
    "HorizontalTextScrollThread",   # labels and titles too long to fit
    "TxExplorerAnimationThread",    # the PSBT overview's animation
    "QRDisplayThread",              # every QR the firmware shows
    "LivePreviewThread",            # the camera preview while scanning
}

# One-shots that happen to be BaseThreads, run to completion on start().
#
# The controller blocks waiting for BackgroundImportThread to set up storage, and
# its run() is a one-shot rather than a loop, so it has to run. Without it the
# firmware hangs forever after the splash.
#
# The address verification thread looks like an animation loop -- a while over
# keep_running -- but it is a search that ends: it walks the derivation path for
# one address and stops when it finds it. It never sleeps, so as a green thread
# it would hold the whole worker for its entire walk anyway; inline, it at least
# answers at once for an address that really is the firmware's.
RUN_INLINE_ANYWAY = {
    "BackgroundImportThread",
    "BruteForceAddressVerificationThread",
}

# How far one of those searches may walk before this gives up on it. Upstream has
# no bound on the not-found case because on hardware it is a real thread somebody
# can cancel; here it would be the whole worker, wedged. A device that has just
# exported its own key is being asked about its own first address, so this only
# has to be deep enough to be honest about a miss.
INLINE_SEARCH_LIMIT = 100


# --- scheduler state -----------------------------------------------------------

_current = MAIN          # the green thread running right now, or MAIN
_threads = []            # green threads still alive
_stepping = False        # inside step_due, which must not nest
_guard = 0               # >0 while the main stack is in bookkeeping a tick must not cut into


class _Guard:
    """Keep the tick out while the main stack is mid-way through scheduler state."""

    def __enter__(self):
        global _guard
        _guard += 1

    def __exit__(self, *exc):
        global _guard
        _guard -= 1


_guarded = _Guard()


def _live_changed():
    # The page only ticks while there is a thread to step. A page that ticked for
    # ever would interrupt every bytecode loop the firmware runs for nothing.
    _js.set_live(bool(_threads))


def _step(thread):
    """Run one green thread to its next pause."""
    global _current
    previous, _current = _current, thread
    try:
        pause = next(thread._gen)
    except StopIteration:
        _retire(thread)
    except BaseException as exc:  # noqa: BLE001 -- a thread's failure must not end the firmware
        _log(f"green thread {type(thread).__name__} failed: {type(exc).__name__}: {exc}")
        _retire(thread)
    else:
        wait = FRAME if pause is None else max(0.0, float(pause))
        thread._wake = _now() + wait
    finally:
        _current = previous


def _retire(thread):
    thread._alive = False
    thread._gen = None
    if thread in _threads:
        _threads.remove(thread)
        _log(f"thread end: {type(thread).__name__}")
        _live_changed()


def step_due():
    """Give every thread that is due its turn. Only ever from the main stack."""
    global _stepping
    if _stepping or _current is not MAIN:
        return
    _stepping = True
    try:
        now = _now()
        for thread in list(_threads):
            if thread._alive and thread._wake <= now:
                _step(thread)
    finally:
        _stepping = False


def _idle(done, deadline, wake_on_key):
    """Take turns with the threads until done() or the deadline, whichever first."""
    while True:
        step_due()
        if done():
            return
        now = _now()
        if deadline is not None and now >= deadline:
            return
        wakes = [t._wake for t in _threads if t._alive]
        if deadline is not None:
            wakes.append(deadline)
        if not wakes and not wake_on_key:
            return  # nothing can change while nothing runs
        ms = -1 if not wakes else max(0.0, (min(wakes) - now) * 1000)
        if wake_on_key:
            _js.wait_key(ms)
        else:
            _js.wait_ms(ms if ms >= 0 else 0)


def idle_until(done, deadline=None, wake_on_key=False):
    """Where the main stack waits: for a key, out a sleep, for a lock or a thread."""
    if _current is not MAIN or _stepping:
        return
    _idle(done, deadline, wake_on_key)


def on_main():
    return _current is MAIN


def _tick(signum, frame):
    # The page's interrupt. Anything the main stack was doing is left exactly as
    # it was; this only takes a turn in between two of its bytecodes.
    if _guard or _stepping or _current is not MAIN:
        return
    step_due()


def _sleep(seconds):
    # A sleep on the main stack is a wait like any other. A sleep reached from
    # inside a green thread -- the display driver pacing its frames, say -- is
    # below the generator's own frame and cannot pause it, so it stays a sleep.
    if _current is not MAIN or _stepping:
        return _real_sleep(seconds)
    idle_until(lambda: False, deadline=_now() + max(0.0, seconds))


# --- locks ---------------------------------------------------------------------

class GreenLock:
    """
    threading.Lock and RLock, for threads that take turns.

    Reentrant for its owner, which keeps the property the port has always relied
    on: a thread run inline inside a lock its starter holds does not wait for
    itself. A green thread never blocks in here -- its run() was rewritten to
    wait for the lock before entering -- and the main stack, when it cannot have
    the lock, waits in the scheduler so the thread holding it can finish and let
    go.
    """

    def __init__(self, *args, **kwargs):
        self._owner = None
        self._count = 0

    def _free_for(self, who):
        return self._owner is None or self._owner is who

    def acquire(self, blocking=True, timeout=-1):
        who = _current
        with _guarded:
            if self._free_for(who):
                self._owner, self._count = who, self._count + 1
                return True
        if not blocking:
            return False
        if who is MAIN:
            deadline = None if timeout is None or timeout < 0 else _now() + timeout
            idle_until(lambda: self._free_for(MAIN), deadline=deadline)
            with _guarded:
                if self._free_for(MAIN):
                    self._owner, self._count = MAIN, self._count + 1
                    return True
            return False
        # A green thread blocking below its own run(), on a lock another holder
        # is keeping across a pause. It cannot wait -- nothing else runs until it
        # returns -- so it takes the lock rather than wedge the worker, and says so.
        _log(f"green lock taken over by {type(who).__name__} from {self._owner!r}")
        with _guarded:
            self._owner, self._count = who, 1
        return True

    def release(self):
        with _guarded:
            if self._count <= 0:
                raise RuntimeError("release unlocked lock")
            self._count -= 1
            if self._count == 0:
                self._owner = None

    def locked(self):
        return self._owner is not None

    __enter__ = acquire

    def __exit__(self, *exc):
        self.release()

    # threading.Condition wants these from an RLock, and logging this one.
    def _is_owned(self):
        return self._owner is _current

    def _at_fork_reinit(self):
        self._owner, self._count = None, 0


def _green_can_enter(obj):
    """Whether a rewritten run() may go on into `with obj` or `obj.acquire()`."""
    if isinstance(obj, GreenLock):
        return obj._free_for(_current)
    return True


# --- rewriting run() into a generator -------------------------------------------

_hoisted = itertools.count()


class _Pauses(ast.NodeTransformer):
    """
    Turn the pauses a run() already has into yields.

    - A time.sleep(x) becomes a pause of x.
    - A pass of the `while self.keep_running` loop that has not paused by its
      end, or by a `continue`, pauses for one frame there. Only that loop: an
      inner loop draws the pieces of a single frame -- the five rings of a
      warning's edge -- and pausing inside it would draw each ring a frame apart.
    - `with lock` and a bare `lock.acquire()` wait for the lock by pausing.

    Only the body of run() itself: a nested function, lambda or class is left
    exactly as it was, since a yield there would change what it is.
    """

    def __init__(self, sleeps):
        self.sleeps = sleeps    # expressions that name time.sleep in this module
        self.loops = []         # True for each enclosing keep_running loop

    def visit_FunctionDef(self, node):
        return node

    visit_AsyncFunctionDef = visit_Lambda = visit_ClassDef = visit_FunctionDef

    def _is_sleep(self, node):
        return isinstance(node, ast.Call) and ast.unparse(node.func) in self.sleeps

    def visit_Expr(self, node):
        if self._is_sleep(node.value):
            arg = node.value.args[0] if node.value.args else ast.Constant(0)
            return [ast.copy_location(n, node) for n in
                    (_set_paused(True), ast.Expr(ast.Yield(self.visit(arg))))]
        call = node.value
        if (isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute)
                and call.func.attr == "acquire" and not call.args and not call.keywords):
            # A bare blocking acquire: wait for the lock by pausing, then take it.
            name = f"_green_lock_{next(_hoisted)}"
            hoist = ast.Assign([ast.Name(name, ast.Store())], self.visit(call.func.value))
            call.func.value = ast.Name(name, ast.Load())
            return [ast.copy_location(n, node) for n in (hoist, _wait_for(name), node)]
        return self.generic_visit(node)

    def visit_With(self, node):
        self.generic_visit(node)
        before = []
        for item in node.items:
            # Hoisted so the expression is still evaluated exactly once.
            name = f"_green_ctx_{next(_hoisted)}"
            before.append(ast.Assign([ast.Name(name, ast.Store())], item.context_expr))
            before.append(_wait_for(name))
            item.context_expr = ast.Name(name, ast.Load())
        return [ast.copy_location(n, node) for n in before] + [node]

    def visit_While(self, node):
        frame = "keep_running" in ast.unparse(node.test)
        self.loops.append(frame)
        self.generic_visit(node)
        self.loops.pop()
        if frame:
            node.body.extend(ast.copy_location(n, node) for n in _end_of_pass())
        return node

    def visit_For(self, node):
        self.loops.append(False)
        self.generic_visit(node)
        self.loops.pop()
        return node

    def visit_Continue(self, node):
        if self.loops and self.loops[-1]:
            return [ast.copy_location(n, node) for n in _end_of_pass()] + [node]
        return node


_PAUSED = "_green_paused"


def _set_paused(value):
    return ast.Assign([ast.Name(_PAUSED, ast.Store())], ast.Constant(value))


def _end_of_pass():
    """if not _green_paused: yield  /  _green_paused = False"""
    test = ast.UnaryOp(ast.Not(), ast.Name(_PAUSED, ast.Load()))
    return [ast.If(test, [ast.Expr(ast.Yield(None))], []), _set_paused(False)]


def _wait_for(name):
    """while not _green_can_enter(<name>): yield"""
    test = ast.UnaryOp(ast.Not(), ast.Call(ast.Name("_green_can_enter", ast.Load()),
                                           [ast.Name(name, ast.Load())], []))
    return ast.While(test, [ast.Expr(ast.Yield(None))], [])


_generators = {}


def _sleep_names(globals_):
    names = set()
    for key, value in globals_.items():
        if value is time:
            names.add(f"{key}.sleep")
        elif value is _real_sleep or value is _sleep:
            names.add(key)
    return names or {"time.sleep"}


def _generator_for(cls):
    """cls.run, recompiled as a generator function. None if it cannot be."""
    if cls in _generators:
        return _generators[cls]
    fn = getattr(cls, "run", None)
    made = None
    try:
        fn = inspect.unwrap(fn)
        source = textwrap.dedent(inspect.getsource(fn))
        tree = ast.parse(source)
        ast.increment_lineno(tree, fn.__code__.co_firstlineno - 1)
        run = tree.body[0]
        run.decorator_list = []
        body = []
        for stmt in run.body:
            out = _Pauses(_sleep_names(fn.__globals__)).visit(stmt)
            body.extend(out if isinstance(out, list) else [out])
        # Every generator needs a yield somewhere, even one that never pauses.
        body.append(ast.If(ast.Constant(False), [ast.Expr(ast.Yield(None))], []))
        run.body = [_set_paused(False)] + body

        # Inside a class, so a zero-argument super() still has a __class__ cell,
        # and inside a function whose locals stand in for the original's other
        # free variables. Both sets of cells are then swapped for the original's.
        # The class takes the original's name so that a private self.__name in
        # run() is mangled exactly as it was.
        free = [n for n in fn.__code__.co_freevars if n != "__class__"]
        holder = ast.ClassDef(cls.__name__, [], [], [run], [], type_params=[])
        factory = ast.FunctionDef(
            "__green_factory__", ast.arguments([], [], None, [], [], None, []),
            [ast.Assign([ast.Name(n, ast.Store())], ast.Constant(None)) for n in free]
            + [holder, ast.Return(ast.Attribute(ast.Name(cls.__name__, ast.Load()),
                                                "run", ast.Load()))],
            [], None, type_params=[])
        module = ast.fix_missing_locations(ast.Module([factory], []))
        code = compile(module, inspect.getsourcefile(fn) or "<green>", "exec")

        scope = {}
        exec(code, {"__builtins__": __builtins__}, scope)
        compiled = scope["__green_factory__"]().__code__
        originals = dict(zip(fn.__code__.co_freevars, fn.__closure__ or ()))
        cells = tuple(originals[n] for n in compiled.co_freevars)

        glob = fn.__globals__
        glob.setdefault("_green_can_enter", _green_can_enter)
        made = type(fn)(compiled, glob, fn.__name__, fn.__defaults__, cells or None)
    except Exception as exc:  # noqa: BLE001 -- fall back to what the port always did
        _log(f"green: cannot rewrite {cls.__name__}.run ({type(exc).__name__}: {exc}); dropped")
        made = None
    _generators[cls] = made
    return made


# --- threading.Thread -------------------------------------------------------------

class GreenThread:
    """
    Stands in for threading.Thread.

    Animation threads (GREEN) run as green threads. The two one-shots in
    RUN_INLINE_ANYWAY, and anything that is not loop-shaped, run inline on
    start(), as they always have here. Anything else loop-shaped is dropped.
    """

    def __init__(self, group=None, target=None, name=None, args=(), kwargs=None, *, daemon=None):
        self._target, self._args, self._kwargs = target, args, kwargs or {}
        self.name, self.daemon = name or "greenthread", daemon
        self._gen = None
        self._alive = False
        self._wake = 0.0
        self._done = False

    def _kind(self):
        name = type(self).__name__
        if name in RUN_INLINE_ANYWAY or not hasattr(self, "keep_running"):
            return "inline"
        if name in GREEN:
            return "green"
        return "drop"

    def _bound_search(self):
        """Stop a search thread walking for ever, since nothing else can."""
        counter = getattr(self, "threadsafe_counter", None)
        if counter is None or not hasattr(counter, "increment"):
            return
        increment = counter.increment
        thread = self

        def bounded(step=1):
            increment(step)
            if counter.cur_count >= INLINE_SEARCH_LIMIT:
                _log(f"inline search {type(thread).__name__} gave up at {counter.cur_count}")
                thread.keep_running = False

        counter.increment = bounded

    def start(self):
        kind = self._kind()
        _log(f"thread start: {type(self).__name__} kind={kind} "
             f"target={getattr(self._target, '__name__', None)}")
        if kind == "drop" or self._done or self._alive:
            return
        if kind == "inline":
            self._done = True
            if hasattr(self, "keep_running"):
                self._bound_search()
            try:
                self.run()
            except Exception as exc:  # noqa: BLE001
                _log(f"inline thread {self.name} failed: {type(exc).__name__}: {exc}")
            return

        make = _generator_for(type(self))
        if make is None:
            return
        self._done = True
        self._gen = make(self)
        self._alive = True
        with _guarded:
            _threads.append(self)
        _live_changed()
        # Its first frame now, before whatever its starter goes on to do.
        if _current is MAIN and not _stepping:
            _step(self)

    def run(self):
        if self._target:
            self._target(*self._args, **self._kwargs)

    def is_alive(self):
        return self._alive

    def join(self, timeout=None):
        deadline = None if timeout is None else _now() + timeout
        idle_until(lambda: not self._alive, deadline=deadline)

    def stop(self):
        pass


def _current_thread():
    return _MAIN_THREAD if _current is MAIN else _current


class _MainThread:
    name = "MainThread"
    daemon = False

    def is_alive(self):
        return True


_MAIN_THREAD = _MainThread()


def install(js, log):
    """
    Put green threads, green locks and the scheduler's sleep in place.

    Has to run before anything under seedsigner/ is imported, because
    seedsigner.models.threads binds Thread and Lock at import.

    `js` has three methods: wait_key(ms) parks until a key is pending or the
    time is up, without taking the key; wait_ms(ms) parks for that long; and
    set_live(on) tells the page whether to tick.
    """
    global _js, _log
    _js, _log = js, log

    threading.Thread = GreenThread
    threading.Lock = GreenLock
    threading.RLock = GreenLock
    threading.current_thread = _current_thread
    time.sleep = _sleep

    # The tick. Registered before the page is ever told to send one, so a tick
    # can never land as a KeyboardInterrupt.
    signal.signal(signal.SIGINT, _tick)
    _live_changed()
