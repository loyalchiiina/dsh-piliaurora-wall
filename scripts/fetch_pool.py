"""抓取 bilibili 视频池 -> pool.json

用法：
  python fetch_pool.py                                  # 默认关键词组
  python fetch_pool.py --keyword "狗兰 舞蹈,Eku 舞蹈" --limit 40
  python fetch_pool.py --keyword "毛晓彤" --limit 24 --out pool2.json
"""
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
HDRS = {"User-Agent": UA, "Referer": "https://www.bilibili.com/",
        "Accept": "application/json, text/plain, */*"}

DEFAULT_KEYWORDS = ["狗兰", "golaniyule0", "狗兰 舞蹈", "Eku 舞蹈", "狗兰 直播"]
WHITELIST = ("狗兰", "golaniyule", "golan", "eku", "고라니", "刚子")
PAGES = (1, 2, 3)
MIN_DUR = 90
MAX_DUR = 1200
LIMIT = 60

# 中文/日韩文连续段（只在这些段里切滑窗子串；纯 ASCII 段不切 2 字母子串，
# 否则 as / we / zz 之类会把无关标题放大成"命中"，NO_RESULT 就形同虚设）
CJK_RE = re.compile("[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+")
# 常见噪声/通用词：作 needle 会把大量无关视频放进池子，必须排除
NOISE_CJK = set(
    "乱码 下载 教程 解决 视频 高清 完整版 无水印 免费 修复 报错 怎么 如何 "
    "分享 资源 在线 合集 全集 直播录播 录播 测试 学习 入门 新手 视频"
    .split()
)
# 随机小写 ASCII 串（>=6 位、低元音占比）= 典型的乱码关键词
ASCII_RUN_RE = re.compile(r"[a-z]{6,}")
VOWELS = set("aeiou")


def _is_noise_token(tok):
    """判断一个 token 是否为随机乱码串（长全小写字母、元音极少）。"""
    low = tok.lower()
    for m in ASCII_RUN_RE.findall(low):
        v = sum(1 for ch in m if ch in VOWELS)
        if len(m) >= 6 and v / float(len(m)) < 0.34:
            return True
    return False


def build_needles(tokens):
    """用户关键词 -> needles：整词 + 词内每段中文的所有 >=2 字滑窗子串。

    例：芥末姨姨 -> 芥末姨姨 / 芥末 / 末姨 / 姨姨 / 芥末姨 / 末姨姨
    规则：
      - 单字不收入（「的」「了」这类 1 字会造成大面积误命中）
      - NOISE_CJK 里的通用噪声词不收入
      - 随机乱码 token（长小写 ASCII）整词 + 子串全部丢弃
    """
    out, seen = [], set()

    def add(s):
        s = (s or "").strip()
        if len(s) < 2:
            return
        if s.lower() in NOISE_CJK:
            return
        if s.lower() in seen:
            return
        seen.add(s.lower())
        out.append(s)

    for tok in tokens:
        # 乱码 token / 纯噪声词 token：整词与派生子串都不能当 needle
        if _is_noise_token(tok) or tok.lower() in NOISE_CJK:
            continue
        add(tok)
        for run in CJK_RE.findall(tok):
            for i in range(len(run)):
                for j in range(i + 2, len(run) + 1):
                    add(run[i:j])
    return out


def dur_secs(s):
    try:
        parts = [int(x) for x in str(s).split(":")]
    except Exception:
        return 0
    if len(parts) == 2:
        return parts[0] * 60 + parts[1]
    if len(parts) == 3:
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    return 0


def fetch(kw, page):
    q = urllib.parse.urlencode({"search_type": "video", "keyword": kw, "page": page})
    url = "https://api.bilibili.com/x/web-interface/search/type?" + q
    # bilibili 搜索接口对高频请求回 412（风控），必须退避重试，否则整页丢 0 条
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, headers=HDRS)
            with urllib.request.urlopen(req, timeout=20) as r:
                raw = r.read().decode("utf-8", "replace")
            data = json.loads(raw)
            if data.get("code") == 0:
                return data.get("data", {}).get("result") or []
            print("  code=%s kw=%s page=%d" % (data.get("code"), kw, page))
            return []
        except Exception as e:
            print("  retry %d kw=%s page=%d: %s" % (attempt, kw, page, e))
            time.sleep(3.0 + 4.0 * attempt)
    return []


USER_MIN_DUR = 8
# 用户关键词模式下放宽单条上限：这类 UP 主多为直播回放，真实时长常在 1~3 小时，
# 按默认 1200s 过滤会把大半命中项全部丢掉，池子凑不满数量。
USER_MAX_DUR = 14400


def parse_args():
    args = sys.argv[1:]
    kws, limit, user_mode = DEFAULT_KEYWORDS, LIMIT, False
    out_path = os.path.join(HERE, "pool.json")
    meta_path = ""
    for i, a in enumerate(args):
        nx = args[i + 1] if i + 1 < len(args) else ""
        if a in ("-h", "--help"):
            print("用法: fetch_pool.py [--keyword \"kw1,kw2\"] [--limit N] [--out path] [--meta path]")
            print("  不带 --keyword = 内置默认关键词(狗兰族)；带 --keyword = 只按你给的关键词搜")
            print("  --meta = 额外写一个 {\"count\":N,\"out\":...} 的 json，给宿主程序读条数用")
            raise SystemExit(0)
        if a == "--keyword" and nx:
            parts = nx.replace("，", ",").replace(";", ",").split(",")
            kws = [k.strip() for k in parts if k.strip()] or DEFAULT_KEYWORDS
            user_mode = kws != DEFAULT_KEYWORDS
        elif a == "--limit" and nx:
            try:
                limit = max(1, int(nx))
            except Exception:
                pass
        elif a == "--out" and nx:
            out_path = nx if os.path.isabs(nx) else os.path.join(HERE, nx)
        elif a == "--meta" and nx:
            meta_path = nx if os.path.isabs(nx) else os.path.join(HERE, nx)
    return kws, user_mode, limit, out_path, meta_path


def api_view(bvid):
    """view 接口的 data（原 main 尾部补 cid 的内联实现，抽成函数复用）。"""
    u = "https://api.bilibili.com/x/web-interface/view?bvid=" + bvid
    req = urllib.request.Request(u, headers=HDRS)
    with urllib.request.urlopen(req, timeout=15) as r:
        j = json.loads(r.read().decode("utf-8", "replace"))
    return j.get("data") or {}


def main():
    kws, user_mode, limit, out_path, meta_path = parse_args()
    tokens = []
    for k in kws:
        for token in k.replace("/", " ").split():
            if token not in tokens:
                tokens.append(token)
    # 用户模式：整词 + 词内中文 >=2 字滑窗子串（芥末姨姨 -> 芥末 / 末姨 / 姨姨 ...）；
    # 默认模式（狗兰族）仍用 WHITELIST 原样，行为不变。
    needles = build_needles(tokens) if user_mode else list(WHITELIST)
    if user_mode and not needles:
        # 关键词被判为纯乱码/纯噪声：没有可用 needle，直接判无结果（不抓取、不写盘）
        print("NO_RESULT 关键词不含有效匹配片段（乱码或通用噪声词）")
        if meta_path:
            try:
                tmp = meta_path + ".tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump({"count": 0, "out": out_path, "error": "no_result"}, f,
                              ensure_ascii=False)
                os.replace(tmp, meta_path)
            except Exception as e:
                print("  meta write fail %s: %s" % (meta_path, e))
        raise SystemExit(3)
    lo = USER_MIN_DUR if user_mode else MIN_DUR
    hi = USER_MAX_DUR if user_mode else MAX_DUR
    print("keywords=%s user_mode=%s limit=%d needles(%d)=%s dur=%d..%d"
          % (kws, user_mode, limit, len(needles), needles[:12], lo, hi))

    raw = []
    for kw in kws:
        for page in PAGES:
            res = fetch(kw, page)
            print("kw=%s page=%d -> %d" % (kw, page, len(res)))
            raw.extend(res)
            if len(raw) >= limit * 4:
                break
            time.sleep(1.2)
        if len(raw) >= limit * 4:
            break

    def pick(strict_title):
        seen, picked = set(), []
        for v in raw:
            if len(picked) >= limit:
                break
            bv = v.get("bvid")
            if not bv or bv in seen:
                continue
            d = dur_secs(v.get("duration"))
            if d < lo or d > hi:
                continue
            tl = (v.get("title") or "").lower()
            if needles:
                # 严格模式只看标题；放宽模式要求 标题/简介/作者 任一命中关键词，
                # 否则乱码关键词会靠搜索接口的无关结果通过，NO_RESULT 保证失效。
                if strict_title:
                    blob = tl
                else:
                    blob = tl + " " + (v.get("description") or "").lower() \
                        + " " + str(v.get("author") or "").lower()
                if not any(k.lower() in blob for k in needles):
                    continue
            seen.add(bv)
            pic = v.get("pic", "")
            picked.append({
                "bvid": bv, "aid": v.get("aid"), "cid": v.get("cid") or 0,
                "title": (v.get("title") or "").replace("<em class=\"keyword\">", "").replace("</em>", ""),
                "dur": d, "w": pic,
                "author": v.get("author"), "play": v.get("play"),
                "cover": "https:" + pic if str(pic).startswith("//") else pic,
                "desc": (v.get("description") or "")[:80],
            })
        return picked

    out = pick(True)
    if not out and user_mode and needles:
        print("标题过滤后 0 条，放宽标题条件重试一次")
        out = pick(False)

    def write_meta(count, error=None):
        """给宿主程序读条数用的小 json（原子写）。"""
        if not meta_path:
            return
        try:
            payload = {"count": int(count), "out": out_path}
            if error:
                payload["error"] = error
            tmp = meta_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False)
            os.replace(tmp, meta_path)
        except Exception as e:
            print("  meta write fail %s: %s" % (meta_path, e))

    if not out:
        print("NO_RESULT 该关键词没有搜到符合条件的视频（原池保持不动）")
        write_meta(0, "no_result")
        raise SystemExit(3)

    # 补齐缺 cid 的条目（沿用原脚本已有的 view 接口逻辑）
    for v in out:
        if v.get("cid"):
            continue
        try:
            vd = api_view(v.get("bvid"))
            if vd:
                v["aid"] = vd.get("aid") or v.get("aid")
                v["cid"] = vd.get("cid")
                pg = vd.get("pages") or []
                if pg and not v.get("cid"):
                    v["cid"] = pg[0].get("cid")
                v["dur"] = int(vd.get("duration") or v.get("dur") or 0) or v.get("dur")
                # 注意：w 字段是封面 URL（见 pick 里的 "w": pic），绝不能用
                # dimension.width 覆盖它，否则客户端拿到整数当图片地址就裂图。
                if vd.get("pic"):
                    v["cover"] = vd.get("pic")
                print("  cid fix %s -> %s" % (v.get("bvid"), v.get("cid")))
        except Exception as e:
            print("  cid fix fail %s: %s" % (v.get("bvid"), e))

    out = [v for v in out if v.get("cid")]
    if not out:
        print("NO_RESULT 补齐 cid 后为空（原池保持不动）")
        write_meta(0, "no_result")
        raise SystemExit(3)

    tmp = out_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    os.replace(tmp, out_path)
    write_meta(len(out))
    print("WROTE %s  %d videos" % (out_path, len(out)))


if __name__ == "__main__":
    main()