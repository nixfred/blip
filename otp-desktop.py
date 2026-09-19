#!/usr/bin/python3 -I
"""Focused-object metadata and explicit insertion through native Linux APIs.

No browser extension, DevTools port, clipboard, field-content reads or message
logging. Browser-specific attribute aliases stay in this OS adapter.
"""
import json
import os
import re
import signal
import socket
import struct
import sys
import time
import uuid
from urllib.parse import urlsplit

import gi
gi.require_version("Atspi", "2.0")
from gi.repository import Atspi, GLib, Gio

def activate_accessibility():
    # Enable native accessibility, without enabling a screen reader or speech.
    # This shared session facility may also be used by other assistive clients;
    # do not switch it off when this particular client exits.
    try:
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        bus.call_sync("org.a11y.Bus", "/org/a11y/bus", "org.freedesktop.DBus.Properties", "Set",
            GLib.Variant("(ssv)", ("org.a11y.Status", "IsEnabled", GLib.Variant("b", True))),
            None, Gio.DBusCallFlags.NONE, 500, None)
    except Exception:
        pass  # Browser-wide manual mode remains available without AT-SPI.


Atspi.init()
Atspi.set_timeout(100, 100)
loop = GLib.MainLoop()
focused = None
focus_id = str(uuid.uuid4())
last_signature = None
last_target = None
last_segments = None
buffer = bytearray()
held = None
browser_re = re.compile(r"^(?:brave(?:-.*)?|chromium(?:-.*)?|google-chrome(?:-.*)?|chrome(?:-.*)?|firefox(?:-.*)?|zen(?:-.*)?|org\.mozilla\.firefox|app\.zen_browser\.zen|vivaldi(?:-.*)?|microsoft-edge(?:-.*)?)$", re.I)


def emit(event):
    data = json.dumps(event, separators=(",", ":"))
    if len(data.encode()) > 4096:
        raise RuntimeError("metadata limit")
    sys.stdout.write(data + "\n")
    sys.stdout.flush()


def endpoint():
    global held
    if held is not None:
        return f"/proc/self/fd/{held}/.socket.sock"
    runtime = os.environ.get("XDG_RUNTIME_DIR", "")
    instance = os.environ.get("HYPRLAND_INSTANCE_SIGNATURE", "")
    if not runtime.startswith("/") or not re.fullmatch(r"[a-zA-Z0-9_.-]{1,150}", instance):
        raise RuntimeError("desktop unavailable")
    parts = runtime.split("/") + ["hypr", instance]
    if any(p in (".", "..") for p in parts):
        raise RuntimeError("invalid runtime")
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for part in filter(None, parts):
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            os.close(fd)
            fd = child
            st = os.fstat(fd)
            if st.st_uid not in (0, os.getuid()) or st.st_mode & 0o022:
                raise RuntimeError("untrusted desktop directory")
        if os.fstat(fd).st_uid != os.getuid():
            raise RuntimeError("desktop owner")
        held = fd
        return f"/proc/self/fd/{fd}/.socket.sock"
    except Exception:
        os.close(fd)
        raise


def hypr(command, cap=16384):
    with socket.socket(socket.AF_UNIX) as peer:
        peer.settimeout(0.25)
        peer.connect(endpoint())
        _, uid, _ = struct.unpack("3i", peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        if uid != os.getuid():
            raise RuntimeError("desktop peer mismatch")
        peer.sendall(command.encode())
        output = bytearray()
        deadline = time.monotonic() + 0.25
        while time.monotonic() < deadline:
            chunk = peer.recv(min(4096, cap + 1 - len(output)))
            if not chunk:
                return bytes(output)
            output.extend(chunk)
            if len(output) > cap:
                raise RuntimeError("desktop response limit")
        raise RuntimeError("desktop deadline")


def active():
    # A QML prompt does not take keyboard focus; activewindow remains the target.
    data = json.loads(hypr("j/activewindow"))
    if not isinstance(data, dict) or not isinstance(data.get("pid"), int) or data["pid"] <= 0:
        return None
    if not re.fullmatch(r"0x[a-f0-9]+", data.get("address", "")):
        return None
    return data


def unlocked():
    # Read login1 over D-Bus, with a finite timeout and no helper process.
    try:
        bus = Gio.bus_get_sync(Gio.BusType.SYSTEM, None)
        sid = os.environ.get("XDG_SESSION_ID", "")
        method, parameters = ("GetSession", GLib.Variant("(s)", (sid,))) if re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", sid) else ("GetSessionByPID", GLib.Variant("(u)", (os.getpid(),)))
        session = bus.call_sync("org.freedesktop.login1", "/org/freedesktop/login1",
            "org.freedesktop.login1.Manager", method, parameters,
            None, Gio.DBusCallFlags.NONE, 200, None).unpack()[0]
        locked = bus.call_sync("org.freedesktop.login1", session, "org.freedesktop.DBus.Properties", "Get",
            GLib.Variant("(ss)", ("org.freedesktop.login1.Session", "LockedHint")),
            None, Gio.DBusCallFlags.NONE, 200, None).unpack()[0]
        return locked is False
    except Exception:
        return False


def web_origin(obj):
    # Chromium uses URI; Gecko may expose DocURL. Read document metadata only.
    for _ in range(24):
        if obj is None:
            break
        if obj.get_role() in (Atspi.Role.DOCUMENT_WEB, Atspi.Role.DOCUMENT_FRAME):
            attrs = obj.get_document_iface().get_document_attributes()
            raw = attrs.get("URI", attrs.get("DocURL", ""))
            if len(raw) > 2048:
                return True, ""
            url = urlsplit(raw)
            if url.scheme == "https" and url.hostname and not url.username and not url.password:
                origin = "https://" + url.netloc.lower()
                return True, origin if len(origin) <= 512 else ""
            return True, ""
        obj = obj.get_parent()
    return False, ""


def field(obj, window):
    if obj is None:
        return None
    try:
        if obj.get_application().get_process_id() != window["pid"]:
            return None
        state = obj.get_state_set()
        if not state.contains(Atspi.StateType.FOCUSED) or not state.contains(Atspi.StateType.SHOWING):
            return None
        if not state.contains(Atspi.StateType.EDITABLE) or not obj.is_text():
            return None
        attrs = obj.get_attributes()
        web, origin = web_origin(obj)
        tag = attrs.get("tag", "native" if not web else "other").lower()
        typ = attrs.get("text-input-type", attrs.get("input-type", "password" if obj.get_role() == Atspi.Role.PASSWORD_TEXT else "text")).lower()
        raw_max = attrs.get("maxlength", "-1")
        maximum = int(raw_max) if re.fullmatch(r"-?\d{1,6}", raw_max) else -1
        return {"tag": tag if tag in ("input", "textarea", "div", "native") else "other",
            "type": typ if typ in ("text", "tel", "number", "password", "email", "search") else "other",
            "label": obj.get_name()[:160], "autocomplete": attrs.get("autocomplete", "")[:100],
            "editable": state.contains(Atspi.StateType.SENSITIVE),
            "multiline": state.contains(Atspi.StateType.MULTI_LINE),
            "empty": obj.get_text_iface().get_character_count() == 0,
            "maxLength": maximum if -1 <= maximum <= 65536 else -1,
            "web": web, "origin": origin}
    except Exception:
        return None


def field_anchor(obj, window, monitor, metadata):
    if not obj or not metadata or not monitor:
        return None
    try:
        r = obj.get_component_iface().get_extents(Atspi.CoordType.WINDOW)
        # Chromium's Wayland ATK WINDOW coordinates are physical pixels,
        # while Hyprland and layer-shell margins use logical pixels.
        scale = float(monitor.get("scale", 1)) if metadata["web"] else 1.0
        if not 0.5 <= scale <= 4:
            return None
        x, y, w, h = [v / scale for v in (r.x, r.y, r.width, r.height)]
        ww, wh = window["size"]
        if not 0 <= x < ww or not 0 <= y < wh or not 1 <= w <= ww or not 1 <= h <= wh or x + w > ww + 2 or y + h > wh + 2:
            return None
        return {"x": round(window["at"][0] - monitor["x"] + x),
            "y": round(window["at"][1] - monitor["y"] + y), "w": round(w), "h": round(h)}
    except Exception:
        return None


def segment_group(obj, window, metadata):
    """Recognize a small row of digit boxes, including JS-only size limits.

    Keep the actual accessible objects private. Never infer permission to type
    into an arbitrary newly focused field after a character advances focus.
    """
    if not obj or not metadata or not metadata["web"] or metadata["tag"] != "input" or metadata["type"] not in ("text", "tel", "number"):
        return None
    stop = time.monotonic() + 0.2
    def item(node):
        if not node.is_text() or not node.get_state_set().contains(Atspi.StateType.EDITABLE):
            return None
        attrs = node.get_attributes()
        state = node.get_state_set()
        rect = node.get_component_iface().get_extents(Atspi.CoordType.WINDOW)
        if (attrs.get("tag") != "input" or attrs.get("text-input-type", attrs.get("input-type", "text")) != metadata["type"]
            or attrs.get("maxlength", "-1") not in ("1", "-1")
            or not all(state.contains(s) for s in (Atspi.StateType.SHOWING, Atspi.StateType.SENSITIVE))
            or state.contains(Atspi.StateType.MULTI_LINE) or node.get_application().get_process_id() != window["pid"]
            or not 8 <= rect.height <= 512 or not 8 <= rect.width <= rect.height * 2.5
            or node.get_text_iface().get_character_count() > 1):
            raise ValueError("not a digit box")
        return (node, rect)
    try:
        item(obj)  # Avoid tree walks for ordinary full-width fields.
        parent = obj
        for _ in range(4):
            parent = parent.get_parent()
            if parent is None or parent.get_role() in (Atspi.Role.DOCUMENT_WEB, Atspi.Role.DOCUMENT_FRAME):
                return None
            boxes, stack, visited = [], [(parent, 0)], 0
            while stack:
                node, depth = stack.pop()
                visited += 1
                if visited > 64 or time.monotonic() >= stop:
                    return None
                if node.get_role() in (Atspi.Role.DOCUMENT_WEB, Atspi.Role.DOCUMENT_FRAME):
                    return None
                entry = item(node)
                if entry:
                    boxes.append(entry)
                    if len(boxes) > 12:
                        return None
                else:
                    count = node.get_child_count()
                    if count > 24 or (count and depth >= 4):
                        return None
                    stack.extend((node.get_child_at_index(i), depth + 1) for i in reversed(range(count)))
            if len(boxes) < 4:
                continue
            if not any(node == obj for node, _ in boxes):
                return None
            # Same-sized adjacent boxes on one row, in accessibility order.
            for (_, a), (_, b) in zip(boxes, boxes[1:]):
                if (abs(a.y - b.y) > a.height * 0.25 or abs(a.height - b.height) > a.height * 0.25
                    or abs(a.width - b.width) > a.width * 0.25 or not -2 <= b.x - a.x - a.width <= a.height * 2):
                    return None
            return [node for node, _ in boxes]
    except Exception:
        pass
    return None


def snapshot():
    global focus_id, last_signature, last_target, last_segments
    last_segments = None
    if not unlocked():
        last_target = None
        return None
    window = active()
    if not window:
        last_target = None
        return None
    metadata = field(focused, window)
    browser = bool(browser_re.fullmatch(window.get("class", ""))) or bool(metadata and metadata["web"])
    monitors = json.loads(hypr("j/monitors"))
    output = next((m for m in monitors if m.get("id") == window.get("monitor")), None)
    monitor = output.get("name", "") if output else ""
    if not re.fullmatch(r"[a-zA-Z0-9_.:-]{0,64}", monitor):
        monitor = ""
    signature = (window["pid"], window["address"], bool(metadata))
    if signature != last_signature:
        focus_id = str(uuid.uuid4())
        last_signature = signature
    last_target = {"id": focus_id, "window": window["address"], "pid": window["pid"],
        "browser": browser, "monitor": monitor}
    if metadata:
        last_target["field"] = metadata
        last_segments = segment_group(focused, window, metadata)
        if last_segments:
            last_target["segments"] = {"count": len(last_segments), "index": last_segments.index(focused),
                "empty": all(node.get_text_iface().get_character_count() == 0 for node in last_segments)}
        anchor = field_anchor(focused, window, output, metadata)
        if anchor:
            last_target["anchor"] = anchor
    return last_target


def on_focus(event):
    global focused, focus_id
    if event.detail1:
        focused = event.source
        focus_id = str(uuid.uuid4())
    elif event.source == focused:
        focused = None
        focus_id = str(uuid.uuid4())
    poll()


def poll():
    try:
        emit({"type": "focus", "target": snapshot()})
    except Exception:
        emit({"type": "focus", "target": None})
    return True


def fill(event):
    code = event.get("code", "")
    chosen = event.get("target")
    deadline = event.get("deadline", 0)
    if not isinstance(code, str) or not re.fullmatch(r"[a-zA-Z0-9-]{4,12}", code):
        return
    if not isinstance(deadline, (float, int)) or not time.time() * 1000 < deadline <= time.time() * 1000 + 1500:
        return
    current = snapshot()
    if not chosen or current != chosen:
        return
    original = focused
    segments = last_segments if chosen.get("segments") else None
    if segments:
        if len(segments) != len(code) or not chosen["segments"]["empty"]:
            return
        if original != segments[0] and not segments[0].get_component_iface().grab_focus():
            return
    if chosen.get("field"):
        if not chosen["field"]["empty"]:
            return
        if not segments and original and original.is_editable_text():
            original.get_editable_text_iface().set_text_contents(code)
            # Gecko (Zen, Firefox) returns success but may ignore the write.
            # If the field is still empty, fall through to key events below.
            original.clear_cache()
            if original.get_text_iface().get_character_count() != 0:
                poll()
                return
    elif event.get("mode") != "manual" or not chosen.get("browser"):
        return
    # Chromium exposes field metadata but not EditableText. Use Hyprland's
    # same window-targeted insertion path as Blip's typecode, on its socket.
    # No process argv or clipboard transport; only validated key names enter
    # the fixed Hyprland dispatcher call.
    for index, ch in enumerate(code):
        expected = segments[index] if segments else original
        if expected and chosen.get("field"):
            # A site may move focus asynchronously after input. Wait only for
            # this prevalidated next box, never follow arbitrary focus changes.
            wait_until = min(deadline / 1000, time.time() + 0.15)
            while True:
                expected.clear_cache()
                state = expected.get_state_set()
                if state.contains(Atspi.StateType.FOCUSED):
                    break
                if not segments or time.time() >= wait_until:
                    return
                time.sleep(0.01)
            if not all(state.contains(s) for s in (Atspi.StateType.EDITABLE, Atspi.StateType.SHOWING, Atspi.StateType.SENSITIVE)):
                return
            if segments and expected.get_text_iface().get_character_count() != 0:
                return
        window = active()
        if time.time() * 1000 >= deadline or not unlocked() or not window or window["address"] != chosen["window"] or window["pid"] != chosen["pid"]:
            break
        key = "minus" if ch == "-" else ch.lower()
        mods = "SHIFT" if ch.isupper() else ""
        for state in ("down", "up"):
            command = 'dispatch hl.dsp.send_key_state({mods="%s",key="%s",state="%s",window="address:%s"})' % (mods, key, state, chosen["window"])
            if hypr(command, 1024).strip() != b"ok":
                return
        time.sleep(0.01)
    poll()


def readable(_fd, condition):
    global buffer
    if condition & (GLib.IO_HUP | GLib.IO_ERR):
        loop.quit()
        return False
    chunk = os.read(0, 4096)
    if not chunk:
        loop.quit()
        return False
    buffer.extend(chunk)
    while b"\n" in buffer:
        line, _, buffer = buffer.partition(b"\n")
        if len(line) > 4096:
            loop.quit()
            return False
        try:
            event = json.loads(line)
            if event.get("type") == "fill":
                fill(event)
        except Exception:
            pass
    if len(buffer) > 4096:
        loop.quit()
        return False
    return True


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: loop.quit())
    activate_accessibility()
    listener = Atspi.EventListener.new(on_focus)
    listener.register("object:state-changed:focused")
    GLib.io_add_watch(0, GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR, readable)
    GLib.timeout_add(350, poll)
    emit({"type": "ready"})
    loop.run()
