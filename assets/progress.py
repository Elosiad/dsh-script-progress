"""dsh-script-progress · 进度条 + 里程碑标记。

给任何可能跑超过 20 秒的脚本用。它做两件事：

1. 打一条实时进度行：百分比、速度、ETA；
2. 到 10 / 25 / 50 / 75 / 90 / 100% 各打一行机器可读标记 `@@PROGRESS ...`，
   让 agent 能从捉到的输出里认出「跑到哪了」，好在聊天里回报。

用法
----

自动包一个可迭代对象::

    import sys
    sys.path.insert(0, r"C:\\Users\\you\\.dsh\\script-progress")
    from progress import track

    for item in track(items, label="下载"):
        fetch(item)

手动控制::

    from progress import Progress

    p = Progress(total=len(urls), label="下载", unit="req")
    for url in urls:
        p.update(note=url)
    p.close()

设计取舍
--------

* 进度条只用 ASCII（``#`` / ``-``）：Windows 下 stdout 被重定向时编码往往是
  cp936，画 ``█`` 会直接 UnicodeEncodeError，把用户的脚本炸掉。
* 任何写失败都被吞掉：进度是锦上添花，绝不能成为脚本的崩溃源。
* 非 TTY（被 agent 捉输出）时不刷 ``\\r``，改为每 ``interval`` 秒一行，
  免得输出撑爆上下文。
"""

from __future__ import annotations

import json
import os
import sys
import time
import zlib

__all__ = ["Progress", "track", "counted", "MILESTONES", "MARKER"]

#: 默认里程碑（百分比）。100% 由 close() 单独负责。
MILESTONES = (10, 25, 50, 75, 90)

#: 里程碑行的前缀，agent 按这个找。
MARKER = "@@PROGRESS"


def _fmt_seconds(seconds):
    """把剩余秒数格式化成 ``MM:SS`` / ``H:MM:SS``。"""
    try:
        if seconds is None or seconds != seconds or seconds < 0:
            return "--:--"
        total = int(round(seconds))
    except (TypeError, ValueError):
        return "--:--"
    hours, rest = divmod(total, 3600)
    minutes, secs = divmod(rest, 60)
    if hours:
        return "{:d}:{:02d}:{:02d}".format(hours, minutes, secs)
    return "{:02d}:{:02d}".format(minutes, secs)


def _fmt_rate(rate):
    """速度：整数部分大就少留小数，避免 ``1234.5678`` 这种噪音。"""
    try:
        rate = float(rate)
    except (TypeError, ValueError):
        return "0"
    if rate >= 1000:
        return "{:,.0f}".format(rate)
    if rate >= 100:
        return "{:.0f}".format(rate)
    if rate >= 10:
        return "{:.1f}".format(rate)
    return "{:.2f}".format(rate)


def _safe_write(stream, text):
    """写一行，必要时降级成纯 ASCII；任何异常都不外泄。"""
    if text == "":
        return False
    candidates = (text, text.encode("ascii", "replace").decode("ascii"))
    for payload in candidates:
        try:
            stream.write(payload)
            stream.flush()
            return True
        except UnicodeEncodeError:
            continue
        except (ValueError, OSError):
            return False
    return False


class Progress:
    """一条进度条。

    :param total: 总数量；``None`` 表示不知道总量（只报计数和速度，不报百分比）。
    :param label: 任务名，显示在行尾，也进里程碑标记。
    :param unit: 速度单位，``it`` / ``req`` / ``line`` / ``MB`` ...
    :param stream: 输出流，默认 stderr（stdout 留给脚本自己的数据）。
    :param milestones: 里程碑百分比，默认 10/25/50/75/90。
    :param width: 进度条字符宽度。
    :param interval: 非 TTY 下两次刷新之间的最小间隔（秒）。
    """

    def __init__(
        self,
        total=None,
        label="",
        unit="it",
        stream=None,
        milestones=MILESTONES,
        width=22,
        interval=0.5,
    ):
        self.total = int(total) if total else None
        self.label = str(label or "")
        self.unit = str(unit or "it")
        self.stream = stream if stream is not None else sys.stderr
        self.milestones = tuple(sorted({int(m) for m in milestones}))
        self.width = max(8, int(width))
        self.interval = max(0.0, float(interval))

        self.done = 0
        self._started = time.monotonic()
        self._last_print = 0.0
        self._milestone_index = 0
        self._closed = False
        self._ui_path_value = None
        self._ui_checked = False
        self._ui_last = 0.0
        self._task_id_value = None
        try:
            self._tty = bool(self.stream.isatty())
        except Exception:
            self._tty = False

    # ── 内部 ────────────────────────────────────────────────────────────
    def _percent(self):
        if not self.total:
            return None
        return min(100.0, self.done * 100.0 / self.total)

    def _rate(self):
        elapsed = time.monotonic() - self._started
        if elapsed <= 0:
            return 0.0
        return self.done / elapsed

    def _elapsed(self):
        return time.monotonic() - self._started

    # ── DSH 进度通道（dsh-task-progress 协议，可选） ──────────────────────
    # 存在 DSH_PROGRESS_DIR 时，把同一条进度写成一个 JSON 行追加进去，
    # Web 界面就能实时画出来（悬浮窗 / 右侧栏 tab）。没有这个环境变量就静默跳过。
    def _task_id(self):
        if self._task_id_value is None:
            raw = self.label or ""
            allowed = "".join(c if (c.isascii() and (c.isalnum() or c in "._-")) else "-" for c in raw)
            while "--" in allowed:
                allowed = allowed.replace("--", "-")
            allowed = allowed.strip("._-")
            if len(allowed) < 3:
                # 中文标签洗不出可用 id 时用短哈希，避免不同任务撞成同一行。
                allowed = "task-" + format(zlib.crc32(raw.encode("utf-8")) & 0xFFFF, "04x")
            self._task_id_value = allowed[:40]
        return self._task_id_value

    def _ui_path(self):
        if not self._ui_checked:
            self._ui_checked = True
            base = os.environ.get("DSH_PROGRESS_DIR", "").strip()
            if base:
                self._ui_path_value = os.path.join(base, self._task_id() + ".jsonl")
        return self._ui_path_value

    def _publish(self, state, percent, message=""):
        path = self._ui_path()
        if not path:
            return
        now = time.monotonic()
        if state == "running" and now - self._ui_last < 1.0:
            return
        self._ui_last = now
        line = {
            "v": 1,
            "task": self._task_id(),
            "state": state,
            "at": int(time.time() * 1000),
        }
        if percent is not None:
            line["pct"] = max(0, min(100, round(percent, 1)))
        if self.total:
            line["done"] = self.done
            line["total"] = self.total
        line["unit"] = self.unit
        if message:
            line["msg"] = str(message)[:200]
        elif self.label:
            line["msg"] = self.label[:200]
        try:
            with open(path, "a", encoding="utf-8") as handle:
                handle.write(json.dumps(line, ensure_ascii=False) + "\n")
        except Exception:
            # 界面进度永远不能拖垮脚本本身。
            self._ui_path_value = None

    def _eta(self, rate):
        if not self.total or rate <= 0:
            return None
        return max(0.0, (self.total - self.done) / rate)

    def _emit(self, text, newline=True):
        return _safe_write(self.stream, text + ("\n" if newline else ""))

    def _milestone(self, percent, rate, eta):
        """输出所有已越过、尚未输出的里程碑。"""
        if percent is None:
            return
        while (
            self._milestone_index < len(self.milestones)
            and percent >= self.milestones[self._milestone_index]
        ):
            hit = self.milestones[self._milestone_index]
            self._milestone_index += 1
            rate_text = "{} {}/s".format(_fmt_rate(rate), self.unit)
            parts = [
                MARKER,
                "{}%".format(int(hit)),
                rate_text.replace(" ", ""),
                "eta={}".format(_fmt_seconds(eta)),
            ]
            if self.label:
                parts.append("label={}".format(self.label))
            if self._tty:
                _safe_write(self.stream, "\n")
            self._emit(" ".join(parts))

    def _render(self, percent, rate, eta, note):
        # 开头 0.25 秒不画条：Windows 的 monotonic 分辨率是 15.6ms，首帧
        # elapsed 可能正好是 0，会打出一条「0.00 it/s」的噪声。里程碑不受影响。
        if self._elapsed() < 0.25 and (percent is None or percent < 100):
            return

        # TTY 下每帧都刷（\r 覆盖）；被重定向时按 interval 节流成一行行。
        if not self._tty:
            now = time.monotonic()
            if now - self._last_print < self.interval:
                return
            self._last_print = now

        speed = "{} {}/s".format(_fmt_rate(rate), self.unit)
        if percent is None:
            left = "[{:>8} {}] {:>12}".format(self.done, self.unit, speed)
        else:
            filled = int(round(self.width * percent / 100.0))
            bar = "#" * filled + "-" * (self.width - filled)
            left = "[{:3.0f}%] {} {:>12} ETA {}".format(percent, bar, speed, _fmt_seconds(eta))

        tail = []
        if self.label:
            tail.append(self.label)
        if note:
            tail.append(str(note))
        line = left + (" | " + " ".join(tail) if tail else "")

        if self._tty:
            _safe_write(self.stream, "\r" + line)
        else:
            self._emit(line)

    # ── 公开 API ────────────────────────────────────────────────────────
    def update(self, n=None, note=""):
        """推进计数。``n`` 为空表示 +1。返回自身，方便链式调用。"""
        self.done = self.done + 1 if n is None else int(n)
        percent = self._percent()
        rate = self._rate()
        eta = self._eta(rate)
        self._milestone(percent, rate, eta)
        self._render(percent, rate, eta, note)
        self._publish("running", percent, note)
        return self

    def tick(self, note=""):
        """``update()`` 的 +1 简写。"""
        return self.update(None, note)

    def close(self, note="", state=None):
        """收尾：补一条 100% 里程碑 + 一行汇总。重复调用无害。

        ``state`` 显式指定终态（``done`` / ``failed`` / ``cancelled``）；
        留空时按是否跑满自动判断。
        """
        if self._closed:
            return self
        self._closed = True

        elapsed = time.monotonic() - self._started
        rate = self.done / elapsed if elapsed > 0 else 0.0
        complete = self.total is not None and self.done >= self.total

        if state is None:
            state = "done" if (complete or self.total is None) else "cancelled"
        self._publish(state, 100.0 if complete else self._percent(), note)

        if self._tty:
            _safe_write(self.stream, "\r")
        elif complete:
            # 只有真的跑满才打 100% —— 中途 break 时打 100% 会让 agent 误报完成。
            parts = [MARKER, "100%", "{} {}/s".format(_fmt_rate(rate), self.unit)]
            if elapsed > 0:
                parts.append("elapsed={}".format(_fmt_seconds(elapsed)))
            if self.label:
                parts.append("label={}".format(self.label))
            self._emit(" ".join(parts))

        if complete or self.total is None:
            head = "完成 {} {}".format(self.done, self.unit)
        else:
            head = "中止于 {}/{} {}".format(self.done, self.total, self.unit)
        summary = "{} · 耗时 {} · 平均 {} {}/s".format(
            head, _fmt_seconds(elapsed), _fmt_rate(rate), self.unit
        )
        if self.label:
            summary += " · " + self.label
        self._emit(summary)
        return self

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        self.close()
        return False


def track(iterable, label="", total=None, unit="it", **kwargs):
    """包住一个可迭代对象，逐项自动推进度。

        for item in track(items, label="下载"):
            ...

    提前 ``break`` 或抛异常时也会关掉进度条。
    """
    if total is None:
        try:
            total = len(iterable)  # type: ignore[arg-type]
        except (TypeError, AttributeError):
            total = None

    progress = Progress(total=total, label=label, unit=unit, **kwargs)
    try:
        for index, item in enumerate(iterable, 1):
            progress.update(index)
            yield item
    except Exception:
        # 真异常 → failed；提前 break 走的是 GeneratorExit，落到 finally 记 cancelled。
        progress.close(state="failed")
        raise
    finally:
        progress.close()


def counted(iterable, **kwargs):
    """``track`` 的别名，语义更直白一点。"""
    return track(iterable, **kwargs)
