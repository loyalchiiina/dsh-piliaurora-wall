window.__ModuleLoader__.load({
  id: "dsh-piliaurora-wall",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useRef = React.useRef;

    var NAME = "dsh-piliaurora-wall";
    var VERSION = "0.2.3";
    var API = "/piliaurora-wall";

    /* PiliAurora 官方地址（取自其仓库 README，2.0.2 起本仓库只读归档，后续版本在 Next 仓库） */
    var PilaDown = "https://github.com/wallpap/PiliAurora/releases/latest";
    var PilaDownShort = "github.com/wallpap/PiliAurora";
    var PilaNext = "https://github.com/wallpap/PiliAuroraNext";

    /* ------------------------------------------------------------------ *
     * 模块级状态：侧边栏入口按钮 / 悬浮球 / 面板 三处共享
     * ------------------------------------------------------------------ */
    var store = { open: false, mode: "sidebar", listeners: [], ballPos: null, updBadge: false };
    try {
      var savedMode = window.localStorage.getItem("wall.mode");
      if (savedMode === "float" || savedMode === "sidebar") store.mode = savedMode;
    } catch (e) {
      /* ignore */
    }
    /* 球位置放 store：拖球时广播 emit，面板（也订阅 store）才能实时跟着球走 */
    store.ballPos = loadBallPos();
    function emit() {
      store.listeners.slice().forEach(function (fn) {
        try {
          fn();
        } catch (e) {
          /* ignore */
        }
      });
    }
    function useStore() {
      var pair = useState(0);
      var force = pair[1];
      useEffect(function () {
        var fn = function () {
          force(function (n) {
            return n + 1;
          });
        };
        store.listeners.push(fn);
        return function () {
          store.listeners = store.listeners.filter(function (x) {
            return x !== fn;
          });
        };
      }, []);
      return store;
    }

    /* ------------------------------------------------------------------ *
     * 与宿主通信
     * ------------------------------------------------------------------ */
    function api(pathname, init) {
      return fetch(API + pathname, Object.assign({ credentials: "same-origin" }, init || {})).then(
        function (r) {
          return r.json().catch(function () {
            return { ok: false, error: "响应不是 JSON（HTTP " + r.status + "）" };
          });
        }
      );
    }
    function post(pathname, payload) {
      return api(pathname, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload || {}),
      });
    }

    /* ------------------------------------------------------------------ *
     * 样式（用系统色 Canvas/CanvasText/Highlight，自动适配深浅主题）
     * ------------------------------------------------------------------ */
    var line = "1px solid color-mix(in srgb, CanvasText 16%, transparent)";
    var surface = "color-mix(in srgb, CanvasText 6%, Canvas)";
    var soft = "color-mix(in srgb, CanvasText 4%, Canvas)";
    var btnBase = {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      gap: 4,
      height: 26,
      padding: "0 9px",
      borderRadius: 7,
      border: line,
      background: surface,
      color: "CanvasText",
      fontSize: 12,
      lineHeight: 1,
      whiteSpace: "nowrap",
      cursor: "pointer",
      fontFamily: "inherit",
    };
    function btn(extra) {
      return Object.assign({}, btnBase, extra || {});
    }
    var mutedText = "color-mix(in srgb, CanvasText 62%, Canvas)";

    /* ------------------------------------------------------------------ *
     * 图标：2x2 网格 + 播放三角（与包内 icon.svg 同构，不用 emoji）
     * ------------------------------------------------------------------ */
    function GridIcon(props) {
      var s = (props && props.size) || 18;
      return h(
        "svg",
        { width: s, height: s, viewBox: "0 0 24 24", fill: "none", "aria-hidden": "true" },
        h("rect", { x: 1.6, y: 1.6, width: 8.6, height: 8.6, rx: 2.2, fill: "currentColor", opacity: 0.95 }),
        h("rect", { x: 13.8, y: 1.6, width: 8.6, height: 8.6, rx: 2.2, fill: "currentColor", opacity: 0.6 }),
        h("rect", { x: 1.6, y: 13.8, width: 8.6, height: 8.6, rx: 2.2, fill: "currentColor", opacity: 0.6 }),
        h("rect", { x: 13.8, y: 13.8, width: 8.6, height: 8.6, rx: 2.2, fill: "currentColor", opacity: 0.95 }),
        h("path", { d: "M9.7 8.6 L15.4 12 L9.7 15.4 Z", fill: "var(--dsw-alias-bg-base)" })
      );
    }

    /* ------------------------------------------------------------------ *
     * 数据：状态轮询
     * ------------------------------------------------------------------ */
    function useWall(active) {
      var s1 = useState(null);
      var data = s1[0];
      var setData = s1[1];
      var s2 = useState("");
      var error = s2[0];
      var setError = s2[1];
      var s3 = useState(false);
      var busy = s3[0];
      var setBusy = s3[1];

      function refresh() {
        return api("/status")
          .then(function (d) {
            setData(d);
            return d;
          })
          .catch(function (e) {
            setError(String((e && e.message) || e));
          });
      }

      useEffect(
        function () {
          var timer = null;
          if (active) {
            refresh();
            timer = setInterval(refresh, 2000);
          }
          return function () {
            if (timer) clearInterval(timer);
          };
        },
        [active]
      );

      return { data: data, error: error, setError: setError, busy: busy, setBusy: setBusy, refresh: refresh };
    }

    /* ------------------------------------------------------------------ *
     * 侧边栏底部入口按钮（天然跟随侧边栏显隐 = 与侧边栏隐藏状态联动）
     * ------------------------------------------------------------------ */
    /* 入口行：与「日程助手」完全同构（整行 30px 高、16px 图标 + 13px 文字、左对齐、透明背景） */
    function FooterButton() {
      var st = useStore();
      var s1 = useState(false);
      var hover = s1[0];
      var setHover = s1[1];
      function toggle() {
        store.open = !store.open;
        emit();
      }
      return h(
        "div",
        {
          role: "button",
          tabIndex: 0,
          title: "打开 PiliAurora 视频墙",
          "aria-pressed": st.open,
          onClick: toggle,
          onKeyDown: function (e) {
            if (e.key === "Enter" || e.key === " ") toggle();
          },
          onMouseEnter: function () {
            setHover(true);
          },
          onMouseLeave: function () {
            setHover(false);
          },
          style: {
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-start",
            gap: "7px",
            width: "100%",
            height: "30px",
            margin: 0,
            padding: "0 0 0 5px",
            border: "none",
            background: hover ? "color-mix(in srgb, CanvasText 8%, transparent)" : "transparent",
            color: "inherit",
            cursor: "pointer",
            fontSize: "13px",
            fontFamily: "inherit",
            lineHeight: "1",
            textAlign: "left",
            boxSizing: "border-box",
            borderRadius: 6,
          },
        },
        h(
          "span",
          {
            style: {
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: "16px",
              height: "16px",
              flex: "0 0 auto",
              lineHeight: "1",
              color: st.open ? "Highlight" : "inherit",
            },
          },
          h(GridIcon, { size: 16 })
        ),
        h(
          "span",
          {
            style: {
              display: "inline-flex",
              alignItems: "center",
              height: "16px",
              lineHeight: "1",
              fontSize: "13px",
              whiteSpace: "nowrap",
            },
          },
          "视频墙"
        )
      );
    }

    /* ------------------------------------------------------------------ *
     * 面板内容
     * ------------------------------------------------------------------ */
    function Row(props) {
      return h(
        "div",
        {
          style: Object.assign(
            { display: "flex", alignItems: "center", gap: 6, flexWrap: "nowrap", minWidth: 0 },
            props.style || {}
          ),
        },
        props.children
      );
    }

    function ChipButton(props) {
      var active = !!props.active;
      var s1 = useState(false);
      var hover = s1[0];
      var setHover = s1[1];
      return h(
        "button",
        {
          type: "button",
          disabled: props.disabled,
          title: props.title || props.children,
          onClick: props.onClick,
          onMouseEnter: function () {
            setHover(true);
          },
          onMouseLeave: function () {
            setHover(false);
          },
          style: btn({
            height: props.big ? 30 : 26,
            padding: props.big ? "0 12px" : "0 9px",
            fontWeight: props.big ? 600 : 400,
            borderColor: active ? "Highlight" : undefined,
            background: active
              ? "color-mix(in srgb, Highlight 20%, Canvas)"
              : hover
                ? "color-mix(in srgb, CanvasText 10%, Canvas)"
                : surface,
            color: active ? "Highlight" : props.danger ? "red" : "CanvasText",
            opacity: props.disabled ? 0.45 : 1,
            cursor: props.disabled ? "default" : "pointer",
          }),
        },
        props.children
      );
    }

    function Panel(props) {
      var wall = props.wall;
      var storeState = useStore();
      var s1 = useState("");      var keyword = s1[0];
      var setKeyword = s1[1];
      var s2 = useState(loadNumber("wall.count", 8));
      var count = s2[0];
      var setCount = s2[1];
      var s3 = useState(loadNumber("wall.volume", 0.6));
      var volume = s3[0];
      var setVolume = s3[1];
      var s4 = useState("");
      var note = s4[0];
      var setNote = s4[1];
      var s5 = useState(loadVolMode());
      var volMode = s5[0];
      var setVolModeState = s5[1];
      var s6 = useState(loadNumber("wall.volK", 100));
      var volK = s6[0];
      var setVolK = s6[1];
      /* 页签：视频墙 / 设置。同页切换，不做整页跳转。 */
      var s7 = useState("wall");
      var tab = s7[0];
      var setTab = s7[1];
      /* 检查更新的四态：idle / checking / latest / update / fail。
         独立于面板主状态，刷新轮询不会把它冲掉。 */
      var s8 = useState({ state: "idle", text: "" });
      var upd = s8[0];
      var setUpd = s8[1];
      /* 面板锚点：跟随悬浮球。球有自定义位置时面板贴着球弹出；
         球在默认位置（右下）时面板也回到默认位置。 */
      var anchor = store.ballPos;
      var panelStyle = anchor
        ? {
            left: Math.max(8, Math.min(window.innerWidth - 404, anchor.x - 181)),
            top: Math.max(8, Math.min(window.innerHeight - 300, anchor.y + 44)),
          }
        : { right: 16, bottom: 64 };

      useEffect(function () {
        saveNumber("wall.count", count);
      }, [count]);
      useEffect(function () {
        saveNumber("wall.volume", volume);
      }, [volume]);
      useEffect(function () {
        saveNumber("wall.volK", volK);
      }, [volK]);
      useEffect(function () {
        try {
          window.localStorage.setItem("wall.volMode", volMode);
        } catch (e) {
          /* ignore */
        }
      }, [volMode]);

      var data = wall.data || {};
      var st = data.status || {};
      var wins = Array.isArray(st.windows) ? st.windows : [];
      var running = !!data.running;
      var deps = data.deps || {};
      /* 三态提示：区分「服务没起」「脚本缺失」「程序没装」，
         原来一律显示"未启动"会让人以为手动打开 PiliAurora 就该变成运行中。 */
      var statusText = running
        ? "运行 " + wins.length + " 窗"
        : data.stale
          ? "未启动 · 旧快照"
          : deps.scriptsOk === false
            ? "缺脚本"
            : deps.exeExists === false
              ? "缺程序"
              : "未启动";
      var soundOn = wins.length > 0 && wins.some(function (w) {
        return w.muted === false;
      });

      function run(label, fn) {
        wall.setBusy(true);
        setNote(label + "…");
        return Promise.resolve()
          .then(fn)
          .then(function (r) {
            setNote(r && r.ok === false ? label + "失败：" + (r.error || "未知错误") : label + "完成");
            return wall.refresh();
          })
          .catch(function (e) {
            setNote(label + "失败：" + String((e && e.message) || e));
          })
          .then(function () {
            wall.setBusy(false);
          });
      }

      function openWall() {
        var payload = { keyword: keyword.trim(), count: count, volume: volume, search: keyword.trim().length > 0 };
        run("开窗 " + count + " 个", function () {
          return post("/open", payload).then(function (r) {
            if (r && r.fetched && r.fetched.count != null) {
              setNote("已抓到 " + r.fetched.count + " 条候选视频");
            }
            return r;
          });
        });
      }

      function cmd(action, value) {
        return function () {
          run(action, function () {
            return post("/cmd", { action: action, value: value });
          });
        };
      }

      /* ---- 音量 ---- *
       * 物理响度 = 系统主音量 × 会话音量（每会话 Windows 硬上限 100%）。
       *   跟随模式：会话音量钉 1.0  → 响度 == 系统主音量
       *   独立 K%≤100：会话音量 = K/100，不动系统音量
       *   独立 K%>100：会话音量 = 1.0，并把系统主音量抬到 min(s0×K/100, 1.0)
       *                （s0 = 进独立模式时记下的系统音量基准，回落时还原）
       */
      var sysvol0 = useRef(loadNumber("wall.sysvol0", 0));
      var volDeb = useRef(null);

      function pct(v) {
        return v == null || isNaN(v) ? "-" : Math.round(v * 100) + "%";
      }

      function sysvolNow() {
        var d = wall.data || {};
        var s = (d.status || {}).sysvol;
        return typeof s === "number" && s >= 0 ? s : null;
      }

      function cmdVol(action, value) {
        return post("/cmd", { action: action, value: value });
      }

      function applyVolK(k) {
        var sl = k / 100;
        var s0 = sysvol0.current || sysvolNow() || 0.5;
        if (!sysvol0.current) {
          sysvol0.current = s0;
          saveNumber("wall.sysvol0", s0);
        }
        if (sl <= 1) {
          return cmdVol("volume", sl).then(function (r) {
            var cur = sysvolNow();
            if (cur != null && Math.abs(cur - sysvol0.current) > 0.006) {
              return cmdVol("sysvol", sysvol0.current).then(function () {
                return r;
              });
            }
            return r;
          });
        }
        return cmdVol("volume", 1.0).then(function (r) {
          return cmdVol("sysvol", Math.min(1, sysvol0.current * sl)).then(function () {
            return r;
          });
        });
      }

      function onVolInput(k) {
        setVolK(k);
        if (volMode !== "free") {
          setVolModeState("free");
        }
        if (volDeb.current) clearTimeout(volDeb.current);
        volDeb.current = setTimeout(function () {
          run("音量 " + k + "%", function () {
            return applyVolK(k);
          });
        }, 350);
      }

      function setVolMode(mode) {
        setVolModeState(mode);
        if (mode === "follow") {
          run("跟随系统音量", function () {
            return cmdVol("follow_sysvol", true).then(function (r) {
              return cmdVol("volume", 1.0).then(function () {
                return r;
              });
            });
          });
        } else {
          sysvol0.current = sysvolNow() || sysvol0.current || 0.5;
          saveNumber("wall.sysvol0", sysvol0.current);
          run("独立音量 " + volK + "%", function () {
            return cmdVol("follow_sysvol", false).then(function () {
              return applyVolK(volK);
            });
          });
        }
      }

      var statusDot = h("span", {
        style: {
          width: 7,
          height: 7,
          borderRadius: 4,
          background: running ? "green" : "color-mix(in srgb, CanvasText 35%, Canvas)",
          boxShadow: running ? "0 0 0 3px color-mix(in srgb, green 22%, transparent)" : "none",
          display: "inline-block",
        },
      });

      var selectStyle = btn({ height: 28, padding: "0 6px", background: soft });

      /* 胶囊页签组：选中态用实底 Canvas 抬起，未选中透明。
         整组高度 26 = 22(胶囊) + 2*2(内边距)，与右侧关闭按钮 24 视觉齐平。 */
      var tabBar = h(
        "div",
        {
          style: {
            display: "flex",
            gap: 2,
            padding: 2,
            borderRadius: 999,
            background: "color-mix(in srgb, CanvasText 8%, transparent)",
            flex: "0 0 auto",
          },
        },
        [
          { k: "wall", t: "视频墙" },
          { k: "settings", t: "设置" },
        ].map(function (d) {
          var on = tab === d.k;
          return h(
            "button",
            {
              key: d.k,
              type: "button",
              "aria-pressed": on ? "true" : "false",
              onClick: function () {
                setTab(d.k);
              },
              style: {
                height: 22,
                padding: "0 10px",
                border: "none",
                borderRadius: 999,
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 12,
                whiteSpace: "nowrap",
                background: on ? "Canvas" : "transparent",
                color: on ? "CanvasText" : mutedText,
                fontWeight: on ? 600 : 400,
              },
            },
            d.t
          );
        })
      );

      return h(
        "div",
        {
          style: Object.assign(
            {
              position: "fixed",
              width: 396,
              maxWidth: "calc(100vw - 24px)",
              background: "Canvas",
              color: "CanvasText",
              border: line,
              borderRadius: 14,
              /* 面板投影同样固定纯黑：深色主题下 CanvasText 接近白色，
                 用 color-mix(CanvasText) 做投影会在面板底部糊出一片白光 */
              boxShadow: "0 18px 48px rgba(0, 0, 0, 0.28)",
              zIndex: 2147482000,
              overflow: "hidden",
              fontFamily: "inherit",
              fontSize: 12,
              /* 面板可能落在窗口顶栏的 drag 区上，同样要显式 no-drag，否则按钮点不动 */
              WebkitAppRegion: "no-drag",
              appRegion: "no-drag",
            },
            panelStyle
          ),
        },
        /* header */
        h(
          Row,
          {
            style: {
              padding: "10px 12px",
              borderBottom: line,
              background: soft,
              gap: 8,
            },
          },
          h(GridIcon, { size: 16 }),
          tabBar,
          h("div", { style: { flex: "1 1 auto" } }),
          h("div", { style: { display: "flex", alignItems: "center", gap: 5, color: mutedText, minWidth: 0 } }, statusDot,
            h("span", { style: { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, statusText)),
          h(
            "button",
            {
              type: "button",
              title: "关闭面板",
              "aria-label": "关闭面板",
              onClick: function () {
                store.open = false;
                emit();
              },
              style: {
                width: 24,
                height: 24,
                border: "none",
                borderRadius: 6,
                background: "transparent",
                color: "CanvasText",
                cursor: "pointer",
                fontSize: 15,
                lineHeight: 1,
              },
            },
            "×"
          )
        ),
        tab === "settings"
          ? h(SettingsView, { wall: wall, data: data, onNote: setNote, onSaved: wall.refresh })
          : h(
        "div",
        null,
        /* 搜索 + 开窗 */
        h(
          "div",
          { style: { padding: "10px 12px 8px", display: "flex", flexDirection: "column", gap: 8 } },
          h(
            Row,
            null,
            h(
              "div",
              { style: { position: "relative", flex: "1 1 auto", minWidth: 0, display: "flex" } },
              h("input", {
                value: keyword,
                name: "pa-wall-keyword",
                autoComplete: "off",
                autoCorrect: "off",
                autoCapitalize: "off",
                spellCheck: false,
                placeholder: "输入关键词搜索（留空 = 用现有视频池直接开窗）",
                title: "这个插件不缓存你的关键词；点右侧 × 可一键清空",
                onChange: function (e) {
                  setKeyword(e.target.value);
                },
                onKeyDown: function (e) {
                  if (e.key === "Enter") openWall();
                },
                style: {
                  flex: "1 1 auto",
                  minWidth: 0,
                  height: 28,
                  padding: keyword ? "0 26px 0 9px" : "0 9px",
                  borderRadius: 8,
                  border: line,
                  background: soft,
                  color: "CanvasText",
                  fontSize: 12,
                  outline: "none",
                  fontFamily: "inherit",
                },
              }),
              keyword
                ? h("div", {
                    role: "button",
                    tabIndex: 0,
                    title: "清空关键词",
                    onClick: function () {
                      setKeyword("");
                    },
                    style: {
                      position: "absolute",
                      right: 4,
                      top: 4,
                      width: 20,
                      height: 20,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      borderRadius: 10,
                      color: mutedText,
                      cursor: "pointer",
                      fontSize: 14,
                      lineHeight: 1,
                      userSelect: "none",
                    },
                    onMouseEnter: function (e) {
                      e.currentTarget.style.background = "color-mix(in srgb, CanvasText 10%, transparent)";
                    },
                    onMouseLeave: function (e) {
                      e.currentTarget.style.background = "transparent";
                    },
                  }, "×")
                : null
            ),
            h(
              "select",
              {
                value: count,
                title: "并行打开的窗口数量",
                onChange: function (e) {
                  setCount(Number(e.target.value));
                },
                style: selectStyle,
              },
              [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].map(function (n) {
                return h("option", { key: n, value: n }, n + " 窗");
              })
            ),
            h(ChipButton, { big: true, active: true, disabled: wall.busy, onClick: openWall }, running ? "重开" : "开窗排列")
          ),
          h(
            Row,
            { style: { gap: 2 } },
            h(ChipButton, { onClick: cmd("next_batch"), disabled: wall.busy || !running, title: "全部换成本批次以外的视频" }, "下一批"),
            h(ChipButton, { onClick: cmd("arrange"), disabled: wall.busy || !running, title: "重新铺成网格" }, "网格排列"),
            h(ChipButton, { onClick: cmd("hide_all"), disabled: wall.busy || !running, title: "全部窗口隐藏（进程仍在播放）" }, "全部隐藏"),
            h(ChipButton, { onClick: cmd("show_all"), disabled: wall.busy || !running, title: "全部窗口重新显示" }, "全部显示")
          ),
          h(
            Row,
            { style: { flexWrap: "wrap", rowGap: 4 } },
            h(
              ChipButton,
              {
                active: soundOn,
                disabled: wall.busy || !running,
                onClick: cmd("mute_all", soundOn ? true : false),
                title: "协议 mute 消息：开 = 出声，关 = 静音",
              },
              soundOn ? "声音：开" : "声音：静音"
            ),
            h(ChipButton, {
              active: !!st.autoplay,
              disabled: wall.busy || !running,
              onClick: function () {
                return run("自动连播", function () {
                  return post("/cmd", { action: "autoplay", value: !st.autoplay });
                });
              },
              title: "按视频时长自动换下一个",
            }, st.autoplay ? "连播：开" : "连播：关"),
            h(
              ChipButton,
              {
                active: volMode === "follow",
                disabled: wall.busy || !running,
                onClick: function () {
                  setVolMode("follow");
                },
                title: "跟随系统主音量：会话音量钉在 100%，响度完全由系统音量决定",
              },
              "跟随系统"
            ),
            h("input", {
              type: "range",
              min: 0,
              max: 200,
              step: 5,
              value: volK,
              disabled: wall.busy || !running,
              onInput: function (e) {
                onVolInput(Number(e.target.value));
              },
              title:
                "独立音量 0~200%：100% = 与系统主音量一致；>100% 会自动抬高系统主音量补齐超出部分（系统音量已是 100% 时到顶）",
              style: {
                flex: "1 1 auto",
                minWidth: 60,
                margin: 0,
                accentColor: "Highlight",
                cursor: wall.busy || !running ? "default" : "pointer",
                opacity: volMode === "follow" ? 0.45 : 1,
              },
            }),
            h(
              "span",
              {
                style: { color: mutedText, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", flexShrink: 0 },
                title: "当前系统主音量：" + pct(sysvolNow()),
              },
              volMode === "follow" ? "系统 " + pct(sysvolNow()) : volK + "%"
            )
          )
        ),
        /* 窗口列表 */
        h(
          "div",
          {
            style: {
              borderTop: line,
              padding: "6px 12px 10px",
              maxHeight: 188,
              overflowY: "auto",
            },
          },
          [
            !running && wins.length > 0
              ? h("div", { key: "stale", style: { color: mutedText, padding: "2px 0 6px" } },
                  "上次会话的窗口快照（服务已停止，窗口并不在屏幕上）")
              : null,
            wins.length === 0
              ? h("div", { key: "empty", style: { color: mutedText, padding: "6px 0" } },
                  running ? "窗口正在创建…" : "点「开窗排列」开始：抓取视频池 → 在屏幕外建窗 → 搬到网格位")
              : wins.map(function (w) {
                var on = w.alive !== false && running;
                return h(
                  Row,
                  { key: w.idx, style: { padding: "3px 0", gap: 7 } },
                  h("span", { style: { width: 16, color: mutedText, textAlign: "right" } }, String(w.idx)),
                  h("span", {
                    style: {
                      width: 6,
                      height: 6,
                      borderRadius: 3,
                      background: on ? "green" : "color-mix(in srgb, CanvasText 30%, Canvas)",
                    },
                  }),
                  h("span", {
                    style: {
                      flex: "1 1 auto",
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    },
                    title: (w.title || "") + "  " + (w.bvid || ""),
                  }, w.title || w.bvid || "窗口 " + w.idx),
                  h("span", { style: { color: mutedText, whiteSpace: "nowrap" } },
                    Math.round(Number(w.elapsed) || 0) + "/" + Math.round(Number(w.dur) || 0) + "s")
                );
              }),
          ]
        ),
        /* footer note */
        h(
          Row,
          { style: { padding: "6px 12px", borderTop: line, background: soft, gap: 8, flexWrap: "wrap", rowGap: 4 } },
          h("span", {
            style: { flex: "1 1 100%", minWidth: 0, color: mutedText, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
            title: note || (wall.error ? "错误：" + wall.error : ""),
          }, note || (wall.error ? "错误：" + wall.error : "批次 " + (st.batch == null ? "-" : st.batch) + " · 候选池 " + (st.pool == null ? "-" : st.pool) + " 条")),
          h("button", {
            type: "button",
            title: "立即重拉一次状态",
            onClick: function () {
              wall.refresh().then(function () {
                setNote("已刷新");
              });
            },
            style: btn({ height: 22, padding: "0 8px", background: "transparent" }),
          }, "刷新"),
          h("button", {
            type: "button",
            title: upd.text || "对照运行版本 / 磁盘包版本 / 上游最新版",
            onClick: function () {
              if (upd.state === "checking") return;
              setUpd({ state: "checking", text: "检查中…" });
              api("/check-update")
                .then(function (r) {
                  if (!r || r.ok === false) {
                    setUpd({ state: "fail", text: "检查失败：" + ((r && r.error) || "无返回") });
                    return;
                  }
                  if (r.hasUpdate) {
                    store.updBadge = true;
                    emit();
                    setUpd({
                      state: "update",
                      text:
                        "有新版本 v" + r.latest + "（当前 v" + r.current + "）：在 DSH 插件市场点更新，" +
                        "装完必须彻底退出 DSH 客户端再启动才生效",
                    });
                    setNote("有新版本 v" + r.latest);
                  } else if (r.pendingRestart) {
                    setUpd({
                      state: "update",
                      text: "磁盘包已是 v" + r.packaged + "，运行中仍是 v" + r.current + "：彻底退出 DSH 再启动生效",
                    });
                    setNote("待重启生效 v" + r.packaged);
                  } else {
                    store.updBadge = false;
                    emit();
                    setUpd({ state: "latest", text: "已是最新 v" + r.current + (r.source && r.source !== "none" ? "（源 " + r.source + "）" : "") });
                    setNote("已是最新 v" + r.current);
                  }
                })
                .catch(function (e) {
                  setUpd({ state: "fail", text: "检查失败：" + String((e && e.message) || e) });
                  setNote("检查更新失败：" + String((e && e.message) || e));
                });
            },
            style: btn({
              height: 22,
              padding: "0 8px",
              background: "transparent",
              color: upd.state === "update" ? "#e5484d" : undefined,
              opacity: upd.state === "checking" ? 0.5 : 1,
            }),
          }, upd.state === "checking" ? "检查中…" : upd.state === "latest" ? "已是最新" : upd.state === "update" ? "有新版" : upd.state === "fail" ? "重试" : "检查更新"),
          h("button", {
            type: "button",
            title: "切换入口形态：跟随侧边栏（按钮在侧栏底部，随侧栏一起隐藏）或独立悬浮球",
            onClick: function () {
              store.mode = store.mode === "float" ? "sidebar" : "float";
              try {
                window.localStorage.setItem("wall.mode", store.mode);
              } catch (e) {
                /* ignore */
              }
              emit();
            },
            style: btn({ height: 22, padding: "0 8px", background: "transparent" }),
          }, storeState.mode === "float" ? "入口：悬浮球" : "入口：侧栏"),
          h("button", {
            type: "button",
            title: "停止服务并关闭所有窗口",
            onClick: function () {
              run("停止", function () {
                return post("/stop", {});
              });
            },
            disabled: wall.busy || !running,
            style: btn({ height: 22, padding: "0 8px", color: "red", background: "transparent", opacity: running && !wall.busy ? 1 : 0.4 }),
          }, "停止")
        )
          )
      );
    }

    /* ------------------------------------------------------------------ *
     * 设置视图：依赖路径 + 一键启动
     * 目的：用户不必知道脚本/py 装在哪，也能把 PiliAurora 拉起来开墙。
     * 布局铁律：单屏不滚动、320px 不折行、深浅两套主题都读系统色。
     * ------------------------------------------------------------------ */
    function SettingsView(props) {
      var wall = props.wall;
      var onNote = props.onNote;
      var ss1 = useState(null);
      var cfg = ss1[0];
      var setCfg = ss1[1];
      var ss2 = useState(null);
      var det = ss2[0];
      var setDet = ss2[1];
      var ss3 = useState("");
      var tip = ss3[0];
      var setTip = ss3[1];
      var ss4 = useState(false);
      var busy = ss4[0];
      var setBusy = ss4[1];

      function load() {
        return api("/config").then(function (r) {
          if (r && r.ok) {
            setCfg(r.config || {});
            setDet(r.detected || {});
          } else {
            setTip("读取配置失败" + (r && r.error ? "：" + r.error : ""));
          }
          return r;
        });
      }

      useEffect(function () {
        var tries = 0;
        var timer = null;
        var alive = true;
        function tick() {
          load().then(function (r) {
            if (!alive) return;
            /* 宿主冷启动时首次探测可能超时：自动补试 3 次，仍失败才让用户手动点重试 */
            if (!(r && r.ok) && tries < 3) {
              tries += 1;
              timer = setTimeout(tick, 1500);
            }
          });
        }
        tick();
        return function () {
          alive = false;
          if (timer) clearTimeout(timer);
        };
      }, []);

      var c = cfg || {};
      var d = det || {};
      /* det 为 null = /config 还没回来（首次现探测约 1~2s，冷机更久），
         这时绝不能按「缺」渲染，否则用户看到的是「全部缺失」的假故障 */
      var loaded = det !== null;

      /* 受控输入的写法：一律用函数式更新，避免连续 patch 相互覆盖 */
      function patch(k, v) {
        setCfg(function (prev) {
          var next = Object.assign({}, prev || {});
          next[k] = v;
          return next;
        });
      }

      function act(label, fn) {
        setBusy(true);
        setTip(label + "…");
        return Promise.resolve()
          .then(fn)
          .then(function () {
            setBusy(false);
            return wall.refresh();
          })
          .catch(function (e) {
            setBusy(false);
            setTip(label + "失败：" + String((e && e.message) || e));
          });
      }

      /* 外链一律交给宿主用系统浏览器打开：客户端 fetch 打不开外链，也不能直接起进程 */
      function openUrl(url, label) {
        return act(label || "打开", function () {
          return post("/open-url", { url: url }).then(function (r) {
            if (r && r.ok) setTip("已在浏览器打开：" + url);
            else setTip("打开失败" + (r && r.error ? "：" + r.error : ""));
            return r;
          });
        });
      }

      function copyDl() {
        var nav = window.navigator || {};
        if (!nav.clipboard || !nav.clipboard.writeText) {
          setTip("剪贴板不可用，请手动复制：" + PilaDown);
          return;
        }
        nav.clipboard.writeText(PilaDown).then(
          function () { setTip("已复制：" + PilaDown); },
          function () { setTip("复制失败，请手动复制：" + PilaDown); }
        );
      }

      var inputStyle = {
        flex: "1 1 auto",
        minWidth: 0,
        height: 26,
        padding: "0 8px",
        borderRadius: 7,
        border: line,
        background: "Canvas",
        color: "CanvasText",
        fontFamily: "inherit",
        fontSize: 12,
      };
      var labelStyle = { width: 56, flex: "0 0 auto", color: mutedText, fontSize: 11, whiteSpace: "nowrap" };
      var itemStyle = { display: "flex", alignItems: "center", gap: 6, minWidth: 0 };
      var badge = function (ok, text) {
        return h("span", {
          style: {
            flex: "0 0 auto",
            fontSize: 10,
            padding: "1px 6px",
            borderRadius: 999,
            whiteSpace: "nowrap",
            color: ok ? "green" : mutedText,
            background: "color-mix(in srgb, " + (ok ? "green" : "CanvasText") + " 12%, transparent)",
          },
        }, text);
      };

      /* 依赖自检：把三条最关键的事实压成一行，一眼看出卡在哪；
         loaded=false 时只报「正在检测」，绝不把"还没探测完"说成"缺" */
      var depText = loaded
        ? [
            "程序 " + (d.exeExists ? "OK" : "缺"),
            "脚本 " + (d.autoDirOk ? "OK" : "缺"),
            "Python " + (d.pythonOk ? "OK" : "缺"),
            "运行 " + (d.exeRunning ? "中" : "未起"),
          ].join(" · ")
        : "正在检测依赖…";

      return h(
        "div",
        { style: { padding: "10px 12px 8px", display: "flex", flexDirection: "column", gap: 7 } },
        h("div", { style: itemStyle },
          h("span", { style: labelStyle }, "程序路径"),
          h("input", {
            value: c.exePath || "",
            placeholder: loaded ? d.exe || "留空 = 自动探测" : "检测中…",
            spellCheck: false,
            title: loaded && d.exe ? "探测到：" + d.exe + "（来源 " + (d.exeSource || "auto") + "）" : "",
            onChange: function (e) { patch("exePath", e.target.value); },
            style: inputStyle,
          }),
          h(ChipButton, {
            disabled: busy,
            title: "系统文件对话框，可直接选 .lnk，会自动解析成 exe",
            onClick: function () {
              act("选择程序", function () {
                return post("/pick-exe", {}).then(function (r) {
                  if (r && r.ok && r.path) {
                    patch("exePath", r.path);
                    setTip("已选：" + r.path);
                  } else {
                    setTip("未选择" + (r && r.error ? "：" + r.error : ""));
                  }
                  return r;
                });
              });
            },
          }, "浏览")
        ),
        h("div", { style: itemStyle },
          h("span", { style: labelStyle }, "脚本目录"),
          h("input", {
            value: c.autoDir || "",
            placeholder: loaded ? d.autoDir || "留空 = 自动探测" : "检测中…",
            spellCheck: false,
            onChange: function (e) { patch("autoDir", e.target.value); },
            style: inputStyle,
          }),
          badge(loaded && !!d.autoDirOk, loaded ? (d.autoDirOk ? "已找到" : "未找到") : "检测中")
        ),
        h("div", { style: itemStyle },
          h("span", { style: labelStyle }, "Python"),
          h("input", {
            value: c.pythonPath || "",
            placeholder: loaded ? d.python || "留空 = 自动探测" : "检测中…",
            spellCheck: false,
            onChange: function (e) { patch("pythonPath", e.target.value); },
            style: inputStyle,
          }),
          badge(loaded && !!d.pythonOk, loaded ? (d.pythonOk ? "可用" : "不可用") : "检测中")
        ),
        h("div", { style: itemStyle },
          h("span", { style: labelStyle }, "下载地址"),
          h("span", {
            style: { flex: "1 1 auto", minWidth: 0, color: mutedText, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
            title: PilaDown,
          }, PilaDownShort)
        ),
        h("div", { style: { display: "flex", alignItems: "center", gap: 4, flexWrap: "nowrap" } },
          h(ChipButton, { disabled: busy, title: "用系统浏览器打开官方 Releases 下载页（最新安装包在 releases/latest）", onClick: function () { openUrl(PilaDown, "打开下载页"); } }, "打开下载页"),
          h(ChipButton, { title: "复制完整下载地址", onClick: copyDl }, "复制"),
          h("div", { style: { flex: "1 1 auto" } }),
          h(ChipButton, { disabled: busy, title: "2.0.2 起本仓库只读归档，后续版本在 PiliAuroraNext 发布", onClick: function () { openUrl(PilaNext, "打开新仓库"); } }, "新仓库")
        ),
        h("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "nowrap" } },
          h(ChipButton, {
            disabled: busy,
            title: "把上面填的 .lnk 快捷方式解析成真实 exe 路径",
            onClick: function () {
              var lnk = (c.exePath || "").trim();
              if (!/\.lnk$/i.test(lnk)) {
                setTip("仅 .lnk 需要解析；其它路径直接保存即可");
                return;
              }
              act("解析快捷方式", function () {
                return post("/resolve-lnk", { lnk: lnk }).then(function (r) {
                  if (r && r.ok && r.target) {
                    patch("exePath", r.target);
                    setTip("已解析：" + r.target);
                  } else {
                    setTip("解析失败" + (r && r.error ? "：" + r.error : ""));
                  }
                  return r;
                });
              });
            },
          }, "解析快捷方式"),
          h(ChipButton, {
            disabled: busy,
            title: "立即启动 PiliAurora 主程序（与开窗互不影响）",
            onClick: function () {
              act("启动 PiliAurora", function () {
                return post("/launch", { exePath: (c.exePath || "").trim() }).then(function (r) {
                  if (r && r.ok) {
                    setTip(r.running ? "PiliAurora 已启动" : "已拉起进程，正在初始化…");
                  } else {
                    setTip("启动失败" + (r && r.error ? "：" + r.error : ""));
                  }
                  return r;
                });
              });
            },
          }, "启动"),
          h("div", { style: { flex: "1 1 auto" } }),
          h(ChipButton, {
            active: true,
            disabled: busy,
            onClick: function () {
              act("保存", function () {
                return post("/config", {
                  exePath: (c.exePath || "").trim(),
                  autoDir: (c.autoDir || "").trim(),
                  pythonPath: (c.pythonPath || "").trim(),
                  autoLaunch: c.autoLaunch !== false,
                }).then(function (r) {
                  if (r && r.ok) {
                    setCfg(r.config || {});
                    setDet(r.detected || {});
                    setTip("已保存");
                    onNote && onNote("设置已保存");
                  } else {
                    setTip("保存失败" + (r && r.error ? "：" + r.error : ""));
                  }
                  return r;
                });
              });
            },
          }, "保存")
        ),
        h("label", { style: { display: "flex", alignItems: "center", gap: 6, cursor: "pointer", whiteSpace: "nowrap" } },
          h("input", {
            type: "checkbox",
            checked: c.autoLaunch !== false,
            onChange: function (e) { patch("autoLaunch", !!e.target.checked); },
          }),
          h("span", null, "开窗时自动启动 PiliAurora（未运行则拉起）")
        ),
        h("div", {
          style: {
            color: mutedText,
            fontSize: 11,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            cursor: loaded ? "default" : "pointer",
          },
          title: loaded ? depText : "还在探测，点一下重新检测",
          onClick: loaded ? undefined : function () { load(); },
        }, depText),
        h("div", {
          style: { color: mutedText, fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
          title: tip || "",
        }, tip || (loaded ? "改完点「保存」；程序路径留空即用自动探测结果" : "正在检测依赖，请稍候…"))
      );
    }

    /* ------------------------------------------------------------------ *
     * 悬浮球（入口模式 = 悬浮球 时使用；34x34，hover 只放大 1.08）
     * 位置可拖拽，存 localStorage；球只能在 DSH 窗口内部（DOM 无法画出窗口）
     * ------------------------------------------------------------------ */
    var BALL_SIZE = 34;

    /* 视口钳制：球必须完整留在视口内。
       旧版允许 y=-8 的负坐标，球会被拖到窗口顶栏区域「卡住」；
       顶栏还是 Electron 的 -webkit-app-region:drag 区，事件会被窗口拖拽吞掉，
       所以这里既钳制坐标、又给球加 no-drag（见 Ball 的样式）。 */
    function ballClamp(p) {
      var w = window.innerWidth || 0;
      var h = window.innerHeight || 0;
      var maxX = Math.max(0, w - BALL_SIZE);
      var maxY = Math.max(0, h - BALL_SIZE);
      return {
        x: Math.round(Math.min(Math.max(0, p.x), maxX)),
        y: Math.round(Math.min(Math.max(0, p.y), maxY)),
      };
    }

    function loadBallPos() {
      try {
        var raw = window.localStorage.getItem("wall.ballPos");
        if (raw) {
          var o = JSON.parse(raw);
          if (o && Number.isFinite(o.x) && Number.isFinite(o.y)) {
            /* 存量脏数据（旧版留下的负坐标 / 换过分辨率）一律拉回视口内 */
            return ballClamp({ x: o.x, y: o.y });
          }
        }
      } catch (e) {
        /* ignore */
      }
      return null;
    }
    function saveBallPos(pos) {
      try {
        window.localStorage.setItem("wall.ballPos", JSON.stringify(pos));
      } catch (e) {
        /* ignore */
      }
    }

    /* 拖拽期间直接写行内样式：不走 store/emit，避免每帧全量重渲染把指针捕获弄丢 */
    function placeBall(el, p) {
      if (!el) return;
      if (p) {
        el.style.left = p.x + "px";
        el.style.top = p.y + "px";
        el.style.right = "auto";
        el.style.bottom = "auto";
      } else {
        el.style.left = "auto";
        el.style.top = "auto";
        el.style.right = "18px";
        el.style.bottom = "18px";
      }
    }

    function Ball(props) {
      var st = useStore();
      var s1 = useState(false);
      var hover = s1[0];
      var setHover = s1[1];
      var pos = st.ballPos;
      var dragRef = useRef(null);
      var moveRef = useRef(null);

      /* 窗口缩小后把球拉回视口：否则球留在视口外，任何指针都点不到它 */
      useEffect(function () {
        function onResize() {
          if (!store.ballPos) return;
          var p = ballClamp(store.ballPos);
          if (p.x !== store.ballPos.x || p.y !== store.ballPos.y) {
            store.ballPos = p;
            saveBallPos(p);
            placeBall(dragRef.current, p);
            emit();
          }
        }
        window.addEventListener("resize", onResize);
        return function () {
          window.removeEventListener("resize", onResize);
        };
      }, []);

      var stylePos = pos ? { left: pos.x, top: pos.y } : { right: 18, bottom: 18 };
      return h(
        "button",
        {
          type: "button",
          title: "PiliAurora 视频墙（可拖动）",
          "aria-label": "PiliAurora 视频墙",
          ref: function (el) {
            dragRef.current = el;
          },
          onPointerDown: function (e) {
            if (e.button !== 0) return;
            var el = dragRef.current;
            if (!el) return;
            var r = el.getBoundingClientRect();
            moveRef.current = {
              dx: e.clientX - r.left,
              dy: e.clientY - r.top,
              sx: e.clientX,
              sy: e.clientY,
              moved: false,
            };
            try {
              el.setPointerCapture(e.pointerId);
            } catch (err) {
              /* ignore */
            }
            e.preventDefault();
          },
          onPointerMove: function (e) {
            var d = moveRef.current;
            if (!d) return;
            if (!d.moved && Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) < 4) return;
            d.moved = true;
            var p = ballClamp({ x: e.clientX - d.dx, y: e.clientY - d.dy });
            store.ballPos = p;
            placeBall(dragRef.current, p);
          },
          onPointerUp: function (e) {
            var d = moveRef.current;
            moveRef.current = null;
            var el = dragRef.current;
            if (el) {
              try {
                el.releasePointerCapture(e.pointerId);
              } catch (err) {
                /* ignore */
              }
            }
            if (d && d.moved) {
              var p = ballClamp({ x: e.clientX - d.dx, y: e.clientY - d.dy });
              store.ballPos = p;
              saveBallPos(p);
              placeBall(el, p);
              emit(); /* 松手才广播：面板一次性落位到球旁边 */
            } else {
              store.open = !store.open;
              emit();
            }
          },
          onPointerCancel: function (e) {
            if (!moveRef.current) return;
            moveRef.current = null;
            var el = dragRef.current;
            if (el) {
              try {
                el.releasePointerCapture(e.pointerId);
              } catch (err) {
                /* ignore */
              }
            }
            /* 拖动被系统打断：回落到已保存位置，避免视觉位置与状态漂移 */
            placeBall(el, store.ballPos);
            emit();
          },
          onMouseEnter: function () {
            setHover(true);
          },
          onMouseLeave: function () {
            setHover(false);
          },
          style: Object.assign(
            {
              position: "fixed",
              width: BALL_SIZE,
              height: BALL_SIZE,
              display: "grid",
              placeItems: "center",
              borderRadius: BALL_SIZE / 2,
              /* 底色/描边/前景一律走宿主 --dsw-alias-* 令牌，与 dsh-deepseek-web-free
                 的悬浮球同源；不用 Canvas/CanvasText 是因为深色主题下 CanvasText 接近白色，
                 做投影会变成球底部一大团白光 */
              border: "1px solid var(--dsw-alias-border-l2)",
              background: "var(--dsw-alias-bg-base)",
              color: "var(--dsw-alias-label-primary)",
              /* 投影固定纯黑半透明（深浅主题都成立），不走 color-mix(CanvasText) */
              boxShadow: hover
                ? "0 10px 26px rgba(0, 0, 0, 0.24)"
                : "0 6px 20px rgba(0, 0, 0, 0.18)",
              cursor: "grab",
              zIndex: 2147482001,
              transform: hover ? "scale(1.08)" : "none",
              transition: "transform 120ms ease, box-shadow 120ms ease",
              padding: 0,
              touchAction: "none",
              userSelect: "none",
              /* 关键修复：窗口顶栏是 Electron 的 -webkit-app-region:drag 区，
                 不加 no-drag 时球在顶部收不到任何指针事件（点不中、拖不动） */
              WebkitAppRegion: "no-drag",
              appRegion: "no-drag",
            },
            stylePos
          ),
        },
        h(GridIcon, { size: Math.round(BALL_SIZE * 0.65) }),
        /* 有新版时的红点：球很小，只用一个 7px 圆点提示，不挡图标。
           球本身是 position:fixed，绝对定位子元素以它为基准。 */
        st.updBadge
          ? h("span", {
              key: "updbadge",
              title: "有新版本",
              style: {
                position: "absolute",
                top: -1,
                right: -1,
                width: 7,
                height: 7,
                borderRadius: 4,
                background: "#e5484d",
                boxShadow: "0 0 0 1.5px var(--dsw-alias-bg-base)",
                pointerEvents: "none",
              },
            })
          : null
      );
    }

    /* ------------------------------------------------------------------ *
     * 覆盖层：按 store 渲染球/面板
     * ------------------------------------------------------------------ */
    function Overlay() {
      var st = useStore();
      var wall = useWall(st.open);

      if (!st.open) return st.mode === "float" ? h(Ball, null) : null;
      return h(
        "div",
        { style: { position: "fixed", inset: 0, pointerEvents: "none", zIndex: 2147482000 } },
        h("div", { style: { pointerEvents: "auto" } }, h(Panel, { wall: wall })),
        st.mode === "float" ? h("div", { style: { pointerEvents: "auto" } }, h(Ball, null)) : null
      );
    }

    /* ------------------------------------------------------------------ *
     * 持久化小工具
     * ------------------------------------------------------------------ */
    function loadNumber(key, fallback) {
      try {
        var v = window.localStorage.getItem(key);
        var n = v == null ? NaN : Number(v);
        return Number.isFinite(n) ? n : fallback;
      } catch (e) {
        return fallback;
      }
    }
    function saveNumber(key, value) {
      try {
        window.localStorage.setItem(key, String(value));
      } catch (e) {
        /* ignore */
      }
    }
    function loadVolMode() {
      try {
        var v = window.localStorage.getItem("wall.volMode");
        return v === "follow" ? "follow" : "free";
      } catch (e) {
        return "free";
      }
    }

    /* ------------------------------------------------------------------ *
     * 插件入口
     * ------------------------------------------------------------------ */
    function apply(ctx) {
      var slots = ctx && ctx.slots;
      if (!slots || typeof slots.inject !== "function") return;

      slots.inject("sidebar.footer.action", function () {
        return slots.register(
          {
            name: "sidebar.footer.action",
            id: NAME,
            order: 60,
            label: function () {
              return "视频墙";
            },
          },
          function () {
            return h(FooterButton, null);
          }
        );
      });

      slots.inject("shell.overlay", function () {
        return slots.register(
          { name: "shell.overlay", id: NAME + "-overlay", order: 60 },
          function () {
            return h(Overlay, null);
          }
        );
      });
    }

    exports.name = NAME;
    exports.inject = ["slots"];
    exports.apply = apply;
    exports.version = VERSION;
    return module.exports;
  },
});