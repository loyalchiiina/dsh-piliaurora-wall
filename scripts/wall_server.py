"""PiliAurora wall server: keep N player windows alive, control mute/batch/autoplay
via a command file. Pure stdlib (socket websocket server + ctypes for window mgmt).

Commands (write to wall/cmd.json, will be executed and result written to wall/result.json):
  {"id":1,"action":"mute_all","value":false}   # true=all muted, false=all audible
  {"id":2,"action":"autoplay","value":true}    # when a video reaches its duration, auto-spawn next
  {"id":3,"action":"next_batch"}               # swap all windows to the next set of 8 videos
  {"id":4,"action":"next_one","value":0}       # replace window #0 with next unused video
  {"id":5,"action":"volume","value":0.8}       # rebuild all windows with this volume
  {"id":6,"action":"arrange"}
  {"id":7,"action":"status"}
  {"id":8,"action":"stop"}
"""
import base64, concurrent.futures, ctypes, hashlib, json, os, random, socket, struct, subprocess, sys, threading, time

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# 脚本目录 == 数据目录（pool.json / wall/ 都在脚本同级），所以默认取脚本自身所在目录；
# 宿主可以用 PILIAURORA_AUTO_DIR 覆盖（配置界面里改路径时由 index.js 传入）。
AUTO = os.environ.get("PILIAURORA_AUTO_DIR") or os.path.dirname(os.path.abspath(__file__))
WALL = os.path.join(AUTO, "wall")
os.makedirs(WALL, exist_ok=True)
CMD_F = os.path.join(WALL, "cmd.json")
RES_F = os.path.join(WALL, "result.json")
STAT_F = os.path.join(WALL, "status.json")
LOG_F = os.path.join(WALL, "wall.log")
# PiliAurora 主程序路径：宿主用 PILIAURORA_EXE 传当前配置（设置界面可改），缺省沿用安装路径
EXE = os.environ.get("PILIAURORA_EXE") or r"D:\Program Files (x86)\pili_aurora\PiliAurora.exe"
WDIR = os.path.dirname(EXE)
HIDDEN = (-4000, -3600, 480, 540)

ulog_lock = threading.Lock()


def log(msg):
    """Append to wall.log and echo to stdout.

    Under pythonw.exe sys.stdout is None and print() raises, so the file write
    comes first (that is the durable record) and the echo is best-effort.
    """
    line = "%s %s" % (time.strftime("%H:%M:%S"), msg)
    with ulog_lock:
        try:
            with open(LOG_F, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except Exception:
            pass
        try:
            print(line, flush=True)
        except Exception:
            pass


# ---------------- Win32 ----------------
user32 = ctypes.WinDLL("user32", use_last_error=True)
EnumProc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
user32.EnumWindows.argtypes = [EnumProc, ctypes.c_void_p]
user32.GetWindowThreadProcessId.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
user32.IsWindowVisible.argtypes = [ctypes.c_void_p]
user32.GetWindowTextW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int]
user32.GetWindowTextW.restype = ctypes.c_int
user32.GetWindowRect.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
user32.GetWindowRect.restype = ctypes.c_int
user32.GetClientRect.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
user32.GetClientRect.restype = ctypes.c_int
user32.ClientToScreen.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
user32.ClientToScreen.restype = ctypes.c_int
user32.MoveWindow.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_bool]
user32.ShowWindow.argtypes = [ctypes.c_void_p, ctypes.c_int]
user32.SetWindowPos.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int, ctypes.c_int,
                                ctypes.c_int, ctypes.c_int, ctypes.c_uint]


def win_title(hwnd):
    buf = ctypes.create_unicode_buffer(256)
    user32.GetWindowTextW(hwnd, buf, 256)
    return buf.value


def pid_windows(pid, visible_only=False):
    """Top-level windows owned by pid. Flutter creates several hidden helper windows,
    so only keep real player windows (title starts with 'PiliAurora')."""
    out = []

    def cb(h, l):
        p = ctypes.c_ulong()
        user32.GetWindowThreadProcessId(h, ctypes.byref(p))
        if p.value == pid:
            t = win_title(h)
            if t.startswith("PiliAurora") or t.startswith("PiliAurora Player"):
                if not visible_only or user32.IsWindowVisible(h):
                    out.append(h)
        return True

    user32.EnumWindows(EnumProc(cb), None)
    return out


def move_pid_window(pid, x, y, w, h, tries=10):
    """Place one player window so its *visible client area* is exactly the rect
    (x, y, w, h).

    MoveWindow sets the frame rect, and the frame is bigger than the client
    area (PiliAurora player windows have 8px left/right and 1px top / 8px
    bottom borders). Placing frames flush therefore leaves a visible band of
    desktop background between neighbouring windows. Here the real insets are
    measured per window and the frame is grown/shifted so the client areas
    tile the screen with no gap.
    """
    for _ in range(tries):
        wins = pid_windows(pid, visible_only=False)
        if wins:
            hwnd = wins[0]
            il, it, ir, ib = window_insets(hwnd)
            if il == 0 and it == 0 and ir == 0 and ib == 0:
                il, it, ir, ib = DEFAULT_INSET
            fx = int(x) - il
            fy = int(y) - it
            fw = int(w) + il + ir
            fh = int(h) + it + ib
            user32.MoveWindow(hwnd, fx, fy, fw, fh, True)
            user32.SetWindowPos(hwnd, None, 0, 0, 0, 0, 0x0010 | 0x0001 | 0x0002)
            return True
        time.sleep(0.4)
    return False


def show_pid_window(pid, visible):
    wins = pid_windows(pid, visible_only=False)
    if not wins:
        return False
    user32.ShowWindow(wins[0], 8 if visible else 0)  # SW_SHOWNA / SW_HIDE
    return True


class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


def window_insets(hwnd):
    """Return (left, top, right, bottom) frame insets of a window, i.e. how much
    of the frame rect is border instead of the visible client area.

    Measured on PiliAurora player windows: left=8, top=1, right=8, bottom=8,
    so a 642x542 frame shows a 626x533 client area.
    """
    fr = RECT()
    cr = RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(fr)):
        return (0, 0, 0, 0)
    if not user32.GetClientRect(hwnd, ctypes.byref(cr)):
        return (0, 0, 0, 0)
    pt = POINT(0, 0)
    if not user32.ClientToScreen(hwnd, ctypes.byref(pt)):
        return (0, 0, 0, 0)
    il = pt.x - fr.left
    it = pt.y - fr.top
    ir = (fr.right - fr.left) - (cr.right - cr.left) - il
    ib = (fr.bottom - fr.top) - (cr.bottom - cr.top) - it
    return (il, it, ir, ib)


# ---------------- WebSocket helpers ----------------
def ws_accept(key):
    g = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
    return base64.b64encode(hashlib.sha1((key + g).encode()).digest()).decode()


def send_frame(conn, payload, opcode=1):
    if isinstance(payload, str):
        payload = payload.encode()
    hdr = bytes([0x80 | opcode])
    n = len(payload)
    if n < 126:
        hdr += bytes([n])
    elif n < 65536:
        hdr += bytes([126]) + struct.pack(">H", n)
    else:
        hdr += bytes([127]) + struct.pack(">Q", n)
    conn.sendall(hdr + payload)


def recv_frame(conn):
    def rd(n):
        buf = b""
        while len(buf) < n:
            c = conn.recv(n - len(buf))
            if not c:
                raise ConnectionError("eof")
            buf += c
        return buf

    b1, b2 = rd(2)
    opcode = b1 & 0x0F
    masked = b2 & 0x80
    ln = b2 & 0x7F
    if ln == 126:
        ln = struct.unpack(">H", rd(2))[0]
    elif ln == 127:
        ln = struct.unpack(">Q", rd(8))[0]
    mask = rd(4) if masked else None
    payload = rd(ln) if ln else b""
    if mask:
        payload = bytes(payload[i] ^ mask[i % 4] for i in range(len(payload)))
    return opcode, payload


# ---------------- window model ----------------
class Win:
    def __init__(self, idx, video, volume, pos):
        self.idx = idx
        self.video = video
        self.volume = volume
        self.pos = pos
        self.pid = None
        self.sock = None
        self.sl = threading.Lock()
        self.ready = threading.Event()
        self.born = 0.0
        self.muted = None
        self.alive = False
        self.srv = None
        self.cache = None
        self.proc = None
        self.msg_logged = 0

    def send(self, obj):
        with self.sl:
            if not self.sock:
                return False
            try:
                send_frame(self.sock, json.dumps(obj))
                return True
            except Exception:
                return False

    def kill(self):
        self.alive = False
        with self.sl:
            if self.sock:
                try:
                    send_frame(self.sock, b"", 8)
                except Exception:
                    pass
                try:
                    self.sock.close()
                except Exception:
                    pass
                self.sock = None
        if self.srv:
            try:
                self.srv.close()
            except Exception:
                pass
            self.srv = None
        if self.pid:
            subprocess.run(["taskkill", "/PID", str(self.pid), "/F", "/T"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            self.pid = None


def read_loop(win):
    conn = win.sock
    conn.settimeout(1.0)
    while win.alive:
        try:
            op, payload = recv_frame(conn)
        except socket.timeout:
            continue
        except Exception:
            break
        if op == 8:
            break
        if op == 9:
            try:
                with win.sl:
                    send_frame(conn, payload, 10)
            except Exception:
                break
            continue
        try:
            msg = json.loads(payload.decode("utf-8", "replace"))
        except Exception:
            continue
        t = msg.get("type")
        # diagnostic: log the first few raw message types per window so a
        # "not ready" window can be told apart from a dead child.
        try:
            if win.msg_logged < 5:
                win.msg_logged += 1
                log("win%d msg type=%r keys=%s len=%d"
                    % (win.idx, t, sorted(msg.keys())[:8], len(payload)))
        except Exception:
            pass
        if t == "ready":
            win.ready.set()
        elif t == "failed":
            log("win%d child reported failed" % win.idx)
        elif t == "close":
            log("win%d child sent close" % win.idx)
            break
    win.alive = False
    log("win%d reader exit" % win.idx)


def _new_socket(win):
    """Create the listener socket and spawn one player window for `win`.

    Returns (srv, port, proc). On failure returns (None, None, None) and logs.
    Kept separate from `_prepare` so a failed connect can rebuild the whole
    listener + child process from scratch.
    """
    srv = None
    try:
        srv = socket.socket()
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind(("127.0.0.1", 0))
        srv.listen(1)
        port = srv.getsockname()[1]
        token = base64.urlsafe_b64encode(os.urandom(32)).decode()
        win.cache = os.path.join(WALL, "cache_w%d_%d" % (win.idx, int(time.time())))
        os.makedirs(win.cache, exist_ok=True)
        env = dict(os.environ)
        env["PILIAURORA_WINDOW_ID"] = str(win.idx)
        env["PILIAURORA_WINDOW_PORT"] = str(port)
        env["PILIAURORA_WINDOW_TOKEN"] = token
        p = subprocess.Popen([EXE, "--piliaurora-player-window"], cwd=WDIR, env=env,
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL)
        return srv, port, p
    except Exception as e:
        log("win%d spawn fail %s" % (win.idx, e))
        if srv is not None:
            try:
                srv.close()
            except Exception:
                pass
        return None, None, None


def _prepare(win):
    """Fast half of launch(): listener socket + env + Popen the player window.

    Serial. The whole batch costs a few hundred ms, so all windows can be spawned
    first and only the slow half (`_connect`) needs to run concurrently.
    """
    win.ready.clear()
    win.alive = False
    if not win.video:
        log("win%d prepare skipped: no video" % win.idx)
        return False
    srv, port, p = _new_socket(win)
    if srv is None:
        win.srv = None
        return False
    win.srv = srv
    win.pid = p.pid
    win.proc = p
    log("win%d prepared pid=%d port=%d" % (win.idx, p.pid, port))
    return True


def _connect_once(win, place=True, attempt=1):
    """One accept/handshake/init/read_loop/ready attempt for `win`.

    Uses the listener socket currently held in `win.srv`. Returns True on ready.
    On failure the window is killed (child + socket) and False is returned.
    """
    srv = getattr(win, "srv", None)
    v = win.video
    if srv is None or not v:
        log("win%d connect skipped (srv=%s video=%s) attempt=%d"
            % (win.idx, bool(srv), bool(v), attempt))
        return False
    srv.settimeout(READY_TIMEOUT + 10)
    try:
        conn, _ = srv.accept()
    except Exception as e:
        log("win%d accept timeout/fail attempt=%d: %s" % (win.idx, attempt, e))
        win.kill()
        return False
    srv.settimeout(None)
    try:
        req = b""
        while b"\r\n\r\n" not in req:
            c = conn.recv(4096)
            if not c:
                raise ConnectionError("eof")
            req += c
        txt = req.decode("latin1")
        key = ""
        for line in txt.split("\r\n"):
            if line.lower().startswith("sec-websocket-key:"):
                key = line.split(":", 1)[1].strip()
        resp = ("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                "Connection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n" % ws_accept(key))
        conn.sendall(resp.encode())
    except Exception as e:
        log("win%d handshake fail attempt=%d: %s" % (win.idx, attempt, e))
        win.kill()
        return False
    init = {
        "request": {"route": "/videoV", "arguments": {
            "aid": v["aid"], "bvid": v["bvid"], "cid": v["cid"],
            "epId": None, "seasonId": None, "pgcType": None,
            "videoType": "ugc", "pgcApi": None, "isVertical": False,
            "cover": v.get("cover", ""), "title": v.get("title", ""),
            "progress": 0, "heroTag": "desktop-%d" % v["cid"]}},
        "volume": win.volume,
        "storage": {},
        "bounds": [HIDDEN[0] - win.idx * 60, HIDDEN[1], HIDDEN[2], HIDDEN[3]],
        "cacheDirectory": win.cache,
    }
    win.sock = conn
    win.alive = True
    send_frame(conn, json.dumps(init))
    th = threading.Thread(target=read_loop, args=(win,), daemon=True)
    th.start()
    win.born = time.time()
    if not win.ready.wait(READY_TIMEOUT):
        alive = False
        try:
            alive = win.pid is not None and (win.proc is None or win.proc.poll() is None)
        except Exception:
            pass
        log("win%d not ready in %ds attempt=%d (pid %d child_alive=%s)"
            % (win.idx, READY_TIMEOUT, attempt, win.pid or -1, alive))
        win.kill()
        return False
    # audio: the protocol `mute` message is the ONLY working volume channel (init volume is ignored).
    # It must be sent ~2.5s after ready, otherwise PlPlayerController.instance is still null.
    def _late_mute(w=win):
        w.send({"type": "mute", "muted": bool(w.muted) if w.muted is not None else False})

    threading.Timer(2.5, _late_mute).start()
    if place:
        def _late_place(w=win):
            ok = move_pid_window(w.pid, *w.pos)
            log("win%d delayed place -> %s (parc=%s)" % (w.idx, ok, w.pos))
        threading.Timer(3.0, _late_place).start()
        log("win%d ready pid=%d place scheduled bvid=%s" % (win.idx, win.pid, v["bvid"]))
    else:
        log("win%d ready pid=%d hidden bvid=%s" % (win.idx, win.pid, v["bvid"]))
    return True


def _connect(win, place=True):
    """Slow half of launch(): connect a prepared window, retrying once.

    A window whose child never reports `ready` (or whose listener never gets
    connected) is rebuilt from scratch once: new listener socket + new child
    process. Two attempts of 30s each give a 60s budget per window.
    """
    v = win.video
    if not v:
        log("win%d connect skipped: no video" % win.idx)
        return False
    for attempt in (1, 2):
        if attempt == 2:
            # rebuild: the old socket was already accepted/failed and the child
            # may be a zombie -> kill it and spawn a brand new one.
            log("win%d retrying connect attempt=2 (rebuild socket + child)" % win.idx)
            win.kill()
            win.ready.clear()
            win.alive = False
            if not _prepare(win):
                log("win%d FAILED after retries: rebuild failed (attempt=2)" % win.idx)
                return False
        try:
            ok = _connect_once(win, place=place, attempt=attempt)
        except Exception as e:
            log("win%d connect exception attempt=%d: %s" % (win.idx, attempt, repr(e)))
            ok = False
        if ok:
            return True
    log("win%d FAILED after retries (2 attempts, %ds budget) bvid=%s"
        % (win.idx, READY_TIMEOUT * 2, (v or {}).get("bvid")))
    return False


def launch(win, place=True):
    """(re)spawn one player window for win.video; block until ready or timeout."""
    if not _prepare(win):
        return False
    return _connect(win, place=place)


def launch_many(wins, place=True):
    """Spawn several windows at once: prepare serially, then connect concurrently.

    Returns the number of windows that became ready. Worker bodies never raise:
    every exception is logged through log() and counts as a failed window.
    """
    todo = [w for w in wins if w is not None]
    if not todo:
        return 0
    prepped = []
    for w in todo:
        try:
            if _prepare(w):
                prepped.append(w)
        except Exception as e:
            log("win%d prepare exception %s" % (w.idx, repr(e)))
    if not prepped:
        log("launch_many: nothing prepared")
        return 0
    okn = [0]
    lock = threading.Lock()

    def _run(w):
        try:
            good = _connect(w, place=place)
        except Exception as e:
            log("win%d connect exception %s" % (w.idx, repr(e)))
            good = False
        if good:
            with lock:
                okn[0] += 1

    workers = min(CONNECT_WORKERS, len(prepped))
    log("launch_many: prepared %d/%d, connecting with %d thread(s)"
        % (len(prepped), len(todo), workers))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        futs = [ex.submit(_run, w) for w in prepped]
        concurrent.futures.wait(futs)
    log("launch_many: ready %d/%d" % (okn[0], len(todo)))
    return okn[0]


# ---------------- pool / state ----------------
def load_bad_bvids():
    """bvid values whose player window never reaches the `ready` handshake.

    Some pool entries make the child process stay alive but never send
    `ready` (measured: BV1WbUWBhEZP failed 9/9 times). Persisting the list
    keeps later batches from burning the whole ready budget on them.
    """
    p = os.path.join(WALL, "bad_videos.json")
    if not os.path.exists(p):
        return set()
    try:
        with open(p, encoding="utf-8") as fh:
            return set(json.load(fh))
    except Exception:
        return set()


def save_bad_bvids(bad):
    p = os.path.join(WALL, "bad_videos.json")
    try:
        with open(p, "w", encoding="utf-8") as fh:
            json.dump(sorted(bad), fh)
    except Exception:
        pass


def load_pool():
    pool, seen = [], set()
    bad = load_bad_bvids()
    files = ("pool.json",) if os.path.exists(os.path.join(AUTO, "pool.json")) else ("videos.json", "videos-extra.json")
    for f in files:
        p = os.path.join(AUTO, f)
        if not os.path.exists(p):
            continue
        with open(p, encoding="utf-8") as fh:
            for v in json.load(fh):
                if (v.get("bvid") and v["bvid"] not in seen
                        and v.get("dur", 0) >= 60 and v["bvid"] not in bad):
                    seen.add(v["bvid"])
                    pool.append(v)
    if bad:
        log("load_pool: skipped %d known-bad video(s): %s"
            % (len(bad), ",".join(sorted(bad))))
    return pool


POOL = []
POOL_PTR = 0
BATCH = 0
AUTOPLAY = False
COLS, ROWS = 4, 2


def _primary_screen_size(fallback=(1920, 1080)):
    """主屏尺寸（像素）。不主动声明 DPI 感知：本进程与 MoveWindow 都用同一套
    坐标空间，保持一致才不会错位。取不到就退回 1920x1080。"""
    try:
        import ctypes
        u = ctypes.windll.user32
        w, h = int(u.GetSystemMetrics(0)), int(u.GetSystemMetrics(1))
        if w >= 640 and h >= 480:
            return w, h
    except Exception:
        pass
    return fallback


SCREEN_W, SCREEN_H = _primary_screen_size()
MAX_WINDOWS = 16
# Seam compensation. MoveWindow sets the *frame* rect; the Flutter client area
# is smaller than the frame and the window carries a border/rounded corner, so
# abutting frames still leave a 6~8px band of desktop background between
# neighbouring windows. move_pid_window() measures the real per-window insets
# and expands the frame so the *client* areas tile the screen exactly.
# These are the measured insets of a PiliAurora player window (left, top,
# right, bottom) and are only used as a fallback before the window exists.
DEFAULT_INSET = (8, 1, 8, 8)
# Budget for one window to report `ready` after its handshake. Flutter cold
# start on this machine needs ~2-8s normally but the last few windows of a big
# batch can take much longer, so the single-window budget is generous.
READY_TIMEOUT = 60
# How many windows may run the slow handshake phase at the same time. Too many
# Flutter cold starts at once starve each other (measured: the last windows of
# a 9-window batch never reported `ready` within 30s), so the batch is
# connected in waves of this size.
CONNECT_WORKERS = 4


def grid_size(n):
    """Return (cols, rows) for n windows, covering 1..16.

    1->1x1, 2->2x1, 3->3x1, 4->2x2, 5..6->3x2, 7..9->3x3, 10..12->4x3,
    13..16->4x4. The product is always >= n so every window gets its own cell.
    """
    n = int(n)
    if n <= 1:
        return (1, 1)
    if n == 2:
        return (2, 1)
    if n == 3:
        return (3, 1)
    if n == 4:
        return (2, 2)
    if n <= 6:
        return (3, 2)
    if n <= 9:
        return (3, 3)
    if n <= 12:
        return (4, 3)
    return (4, 4)


def grid_pos(i):
    """Client-area rect of window i.

    Cell width/height are ceil-divided so the cells tile the screen exactly
    (no rounding gap). The rect returned is the *visible client area*; the
    frame is grown by the measured border insets in move_pid_window(), so
    neighbouring windows touch with no background band between them.
    """
    cw = -(-SCREEN_W // COLS)   # ceil
    ch = -(-SCREEN_H // ROWS)   # ceil
    col = i % COLS
    row = i // COLS
    x = col * cw
    y = row * ch
    w = cw
    h = ch
    # clamp the right/bottom edge cell so the client area never leaves the screen
    if x + w > SCREEN_W:
        w = SCREEN_W - x
    if y + h > SCREEN_H:
        h = SCREEN_H - y
    if w <= 0:
        w = cw
    if h <= 0:
        h = ch
    return (x, y, w, h)


def next_video():
    global POOL_PTR
    if not POOL:
        log("POOL 为空，先抓视频池 (empty pool -> nothing to play)")
        return None
    v = POOL[POOL_PTR % len(POOL)]
    POOL_PTR += 1
    return v


def unique_by_bvid(items):
    """Keep first occurrence of each bvid, preserving pool order."""
    seen = set()
    out = []
    for v in items or []:
        b = v.get("bvid")
        if b and b not in seen:
            seen.add(b)
            out.append(v)
    return out


def pick_videos(count):
    """Choose `count` videos for the initial windows.

    Unique bvid first: every window should show a different video while the pool
    allows it. If the pool holds fewer unique videos than windows, the pool is
    used up and the remaining slots repeat it in rounds (round-robin), so all
    `count` windows still get a video. The final order is shuffled.
    """
    global POOL_PTR
    pool = POOL or []
    uniq = unique_by_bvid(pool)
    if not uniq:
        return []
    if len(uniq) < count:
        log("pool exhausted: %d unique videos for %d windows, repeating"
            % (len(uniq), count))
    picks = list(uniq[:count])
    i = 0
    while len(picks) < count:
        picks.append(uniq[i % len(uniq)])
        i += 1
    random.shuffle(picks)
    # keep the round-robin cursor in sync so the next `next_batch` continues
    # after these videos instead of replaying the first ones
    POOL_PTR += len(picks)
    return picks


WINS = []

# window idx that already logged "autoplay starved (pool empty)"; avoids log spam
STARVED = set()


def write_status(extra=None):
    data = {"time": time.strftime("%Y-%m-%d %H:%M:%S"), "autoplay": AUTOPLAY, "batch": BATCH,
            "pool": len(POOL),
            "volume": WINS[0].volume if WINS else None,
            "follow_sysvol": FOLLOW_SYSVOL, "sysvol": get_sys_volume(),
            "windows": []}
    for w in WINS:
        vv = w.video or {}
        data["windows"].append({
            "idx": w.idx, "pid": w.pid, "bvid": vv.get("bvid"),
            "title": vv.get("title"), "dur": vv.get("dur"),
            "elapsed": round(time.time() - w.born, 1) if w.born else None,
            "alive": w.alive, "muted": w.muted, "pos": w.pos,
            "hwnd_visible": bool(w.pid and pid_windows(w.pid, visible_only=True)),
        })
    if extra:
        data.update(extra)
    tmp = STAT_F + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, STAT_F)
    return data


def cmd_value(v):
    return v


# ---- per-window session volume via pycaw (Windows CoreAudio) ----
# Protocol `initialization.volume` is ignored by the player; the only working
# audio channel is ISimpleAudioVolume on the window process's audio session
# (session name `package:media_kit`). Max session volume is 1.0.
FOLLOW_SYSVOL = False  # True: session volume tracks system master volume
_last_sysvol_seen = None

try:
    from pycaw.pycaw import AudioUtilities, IAudioEndpointVolume, IAudioMeterInformation  # noqa: E402
    from pycaw.constants import EDataFlow, ERole, CLSID_MMDeviceEnumerator  # noqa: E402
    import comtypes  # noqa: E402
    from ctypes import POINTER, cast  # noqa: E402
    _PYCAW = True
except Exception as _e:  # pycaw missing -> volume actions degrade gracefully
    _PYCAW = False
    _PYCAW_ERR = repr(_e)


def _default_endpoint():
    en = comtypes.CoCreateInstance(
        CLSID_MMDeviceEnumerator,
        __import__("pycaw.pycaw", fromlist=["IMMDeviceEnumerator"]).IMMDeviceEnumerator,
        comtypes.CLSCTX_ALL,
    )
    dev = en.GetDefaultAudioEndpoint(EDataFlow.eRender.value, ERole.eMultimedia.value)
    ep = dev.Activate(
        __import__("pycaw.pycaw", fromlist=["IAudioEndpointVolume"]).IAudioEndpointVolume._iid_,
        comtypes.CLSCTX_ALL, None,
    )
    return cast(ep, POINTER(IAudioEndpointVolume))


def get_sys_volume():
    """System master volume 0..1 (endpoint scalar)."""
    if not _PYCAW:
        return None
    try:
        return _default_endpoint().GetMasterVolumeLevelScalar()
    except Exception as e:
        log("get_sys_volume failed: %s" % e)
        return None


def set_sys_volume(v):
    v = max(0.0, min(1.0, float(v)))
    try:
        ep = _default_endpoint()
        ep.SetMasterVolumeLevelScalar(v, None)
        return ep.GetMasterVolumeLevelScalar()
    except Exception as e:
        log("set_sys_volume(%s) failed: %s" % (v, e))
        return None


def apply_session_volume(val):
    """Set ISimpleAudioVolume for every live window's audio session.

    val: 0..1 session-level volume (per-session hard cap is 1.0; >100% of the
    system volume is achieved by raising the endpoint volume instead).
    Returns how many sessions were set.
    """
    if not _PYCAW:
        log("volume: pycaw unavailable (%s)" % locals().get("_PYCAW_ERR", "not installed"))
        return 0
    val = max(0.0, min(1.0, float(val)))
    want = set(w.pid for w in WINS if w.pid)
    if not want:
        return 0
    okn = 0
    try:
        for s in AudioUtilities.GetAllSessions():
            pid = getattr(s, "ProcessId", None)
            if pid not in want:
                continue
            sav = getattr(s, "SimpleAudioVolume", None)
            if sav is None:
                continue
            sav.SetMasterVolume(val, None)
            okn += 1
    except Exception as e:
        log("apply_session_volume error: %s" % e)
    return okn


def execute(cmd):
    global AUTOPLAY, POOL, POOL_PTR, FOLLOW_SYSVOL, _last_sysvol_seen
    a = cmd.get("action")
    if a == "reload_pool":
        POOL = load_pool()
        POOL_PTR = 0
        log("reload_pool -> %d videos" % len(POOL))
        return {"ok": True, "pool": len(POOL)}
    if a == "mute_all":
        val = bool(cmd.get("value"))
        for w in WINS:
            w.muted = val
            w.send({"type": "mute", "muted": val})
        log("mute_all -> %s" % val)
        return {"ok": True, "muted": val, "windows": len(WINS)}
    if a == "autoplay":
        AUTOPLAY = bool(cmd.get("value"))
        log("autoplay -> %s" % AUTOPLAY)
        return {"ok": True, "autoplay": AUTOPLAY}
    if a == "next_batch":
        global BATCH
        BATCH += 1
        for w in WINS:
            w.kill()
        targets = []
        for w in WINS:
            v = next_video()
            if v is None:
                log("next_batch: win%d skipped (no video in pool)" % w.idx)
                continue
            w.video = v
            targets.append(w)
        ok = launch_many(targets)
        log("next_batch -> batch %d (ready %d/%d)" % (BATCH, ok, len(WINS)))
        return {"ok": True, "batch": BATCH, "videos": [(w.video or {}).get("bvid") for w in WINS]}
    if a == "next_one":
        i = int(cmd.get("value", 0))
        if 0 <= i < len(WINS):
            w = WINS[i]
            old = (w.video or {}).get("bvid")
            v = next_video()
            if v is None:
                log("next_one %d skipped: no video in pool" % i)
                return {"ok": False, "error": "no_pool"}
            w.kill()
            w.video = v
            launch(w)
            log("next_one %d %s -> %s" % (i, old, v.get("bvid")))
            return {"ok": True, "idx": i, "bvid": v.get("bvid")}
        return {"ok": False, "error": "bad index"}
    if a == "volume":
        # pycaw per-session volume; `value` is the session-level volume 0..1.
        # The playback protocol ignores initialization.volume entirely, so the
        # old rebuild-based path never worked; ISimpleAudioVolume does.
        val = float(cmd.get("value", 0.6))
        okn = apply_session_volume(val)
        log("volume -> %s (pycaw %d/%d windows)" % (val, okn, len(WINS)))
        return {"ok": True, "volume": val, "windows": okn}
    if a == "follow_sysvol":
        val = bool(cmd.get("value", True))
        FOLLOW_SYSVOL = val
        if val:
            # switch to tracking: remember baseline so we only react to changes
            _last_sysvol_seen = None
            log("follow_sysvol -> True (tracking system master volume)")
        else:
            log("follow_sysvol -> False (independent volume)")
        return {"ok": True, "follow_sysvol": FOLLOW_SYSVOL}
    if a == "sysvol":
        # read-or-set system master volume; returns current value
        sv = cmd.get("value", None)
        try:
            if sv is None:
                cur = get_sys_volume()
            else:
                cur = set_sys_volume(float(sv))
            return {"ok": True, "sysvol": cur}
        except Exception as e:
            return {"ok": False, "error": repr(e)}
    if a in ("hide_all", "show_all"):
        want = (a == "show_all")
        ok = 0
        for w in WINS:
            if w.pid and show_pid_window(w.pid, want):
                ok += 1
        log("%s -> %d/%d" % (a, ok, len(WINS)))
        return {"ok": True, "action": a, "windows": ok, "hidden": not want}
    if a == "arrange":
        ok = 0
        for w in WINS:
            if w.pid and move_pid_window(w.pid, *w.pos):
                ok += 1
        log("arrange -> %d/%d" % (ok, len(WINS)))
        return {"ok": True, "placed": ok}
    if a == "status":
        return {"ok": True, "status": write_status()}
    if a == "stop":
        log("stop requested")
        for w in list(WINS):
            try:
                proc = getattr(w, "proc", None)
                if proc is not None:
                    proc.kill()
                elif w.pid:
                    subprocess.run(["taskkill", "/F", "/PID", str(w.pid)], capture_output=True)
            except Exception as e:
                log("kill win%d failed: %s" % (w.idx, e))
        return {"ok": True, "stopping": True}
    return {"ok": False, "error": "unknown action %s" % a}


def refill_failed(wins):
    """Retry windows whose child never reached `ready` with a different video.

    Some pool entries make the player child stay alive but never send the
    `ready` message, so the window never places itself. Instead of leaving a
    hole in the grid, the offending bvid is blacklisted and the window is
    rebuilt with another video from the pool. Returns the number of windows
    recovered.
    """
    global POOL
    failed = [w for w in wins if w is not None and not w.ready.is_set()]
    if not failed:
        return 0
    bad = load_bad_bvids()
    used = set((w.video or {}).get("bvid") for w in wins if w.video)
    fixed = 0
    for w in failed:
        old = (w.video or {}).get("bvid")
        if old:
            bad.add(old)
        alt = None
        for v in POOL:
            b = v.get("bvid")
            if b and b not in bad and b not in used:
                alt = v
                break
        if alt is None:
            log("win%d refill skipped: no alternative video available" % w.idx)
            continue
        used.add(alt["bvid"])
        log("win%d refill: bvid %s -> %s" % (w.idx, old, alt["bvid"]))
        w.video = alt
        w.ready.clear()
        w.alive = False
        try:
            if _prepare(w) and _connect(w, place=True):
                fixed += 1
        except Exception as e:
            log("win%d refill exception: %s" % (w.idx, repr(e)))
    save_bad_bvids(bad)
    if failed:
        log("refill_failed: recovered %d/%d window(s), blacklist=%s"
            % (fixed, len(failed), ",".join(sorted(bad))))
    return fixed


def main():
    global POOL, WINS, COLS, ROWS
    count = 8
    volume = 0.6
    args = sys.argv[1:]
    for i, a in enumerate(args):
        if a == "--count" and i + 1 < len(args):
            count = int(args[i + 1])
        if a == "--volume" and i + 1 < len(args):
            volume = float(args[i + 1])
    if count < 1:
        count = 1
    if count > MAX_WINDOWS:
        log("count=%d exceeds max %d, clamped" % (count, MAX_WINDOWS))
        count = MAX_WINDOWS
    COLS, ROWS = grid_size(count)
    POOL = load_pool()
    log("pool=%d videos, count=%d volume=%s grid=%dx%d" % (len(POOL), count, volume, COLS, ROWS))
    picks = pick_videos(count)
    if not picks:
        log("POOL 为空，先抓视频池 (no videos in pool, abort spawn)")
        write_status({"phase": "no_pool", "pool": 0})
        return
    WINS = [Win(i, picks[i], volume, grid_pos(i)) for i in range(len(picks))]
    ok = launch_many(WINS)
    ok += refill_failed(WINS)
    log("spawn done ok=%d/%d" % (ok, len(WINS)))
    time.sleep(4.0)
    placed = 0
    for w in WINS:
        if w.pid and move_pid_window(w.pid, *w.pos):
            placed += 1
    log("initial arrange -> %d/%d" % (placed, len(WINS)))
    for w in WINS:
        w.muted = False
        w.send({"type": "mute", "muted": False})
    write_status({"phase": "running", "spawned": ok})

    last_id = 0
    if os.path.exists(CMD_F):
        try:
            with open(CMD_F, encoding="utf-8") as f:
                last_id = int(json.load(f).get("id", 0))
        except Exception:
            pass
    stop = False
    _sysvol_tick = 0.0
    while not stop:
        time.sleep(0.4)
        # follow system master volume: pin session volume at 1.0 so the
        # perceived loudness exactly equals the system master volume
        # (loudness = sysvol * sessionvol; session 1.0 -> loudness = sysvol)
        if FOLLOW_SYSVOL and _PYCAW and WINS:
            _sysvol_tick += 0.4
            if _sysvol_tick >= 2.0:
                _sysvol_tick = 0.0
                apply_session_volume(1.0)
                sv = get_sys_volume()
                if sv is not None and sv != _last_sysvol_seen:
                    _last_sysvol_seen = sv
                    log("follow_sysvol: session pinned 1.0 (system volume %.3f)" % sv)
        if os.path.exists(CMD_F):
            try:
                with open(CMD_F, encoding="utf-8") as f:
                    cmd = json.load(f)
            except Exception:
                cmd = None
            if cmd and int(cmd.get("id", 0)) > last_id:
                last_id = int(cmd.get("id", 0))
                log("cmd %s %s" % (cmd.get("action"), cmd.get("value")))
                try:
                    res = execute(cmd)
                except Exception as e:
                    res = {"ok": False, "error": repr(e)}
                res["id"] = last_id
                with open(RES_F, "w", encoding="utf-8") as f:
                    json.dump(res, f, ensure_ascii=False, indent=1)
                if cmd.get("action") == "stop":
                    stop = True
                write_status({"phase": "after_cmd", "last_cmd": cmd.get("action")})
        if AUTOPLAY:
            now = time.time()
            for w in WINS:
                if not w.alive:
                    continue
                dur = float((w.video or {}).get("dur") or 0)
                if dur and now - w.born >= dur - 0.5:
                    old = (w.video or {}).get("bvid")
                    v = next_video()
                    if v is None:
                        if w.idx not in STARVED:
                            STARVED.add(w.idx)
                            log("autoplay: win%d skipped (%s, no video in pool)" % (w.idx, old))
                        continue
                    STARVED.discard(w.idx)
                    w.kill()
                    w.video = v
                    launch(w)
                    log("autoplay: win%d %s done -> %s" % (w.idx, old, v.get("bvid")))
                    write_status({"phase": "autoplay_switch", "idx": w.idx})
    for w in WINS:
        w.kill()
    log("server exit")


main()
