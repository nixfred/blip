"""Read a coarse shared city from Find My's People accessibility list.

No cache decryption, screenshots, message reads, location requests, tab changes,
or permission prompts. Unknown layouts, localization and identities fail closed.
The AX strings and address book stay in this process and are never persisted.
"""

from __future__ import annotations

from contextlib import closing, contextmanager
import ctypes
from datetime import datetime, timedelta, timezone
import fcntl
import hashlib
import json
import math
import os
import re
import stat
import subprocess
import sys
import time
import unicodedata

MAX_ROWS = 512
MAX_DESCRIPTION = 512
MAX_CONTACTS = 20000
MAX_NODES = 4096
MAX_DEPTH = 24
MAX_AGE_SECONDS = 300
MAX_LOCATION_AGE_SECONDS = 24 * 60 * 60
REFRESH_COOLDOWN_SECONDS = 15 * 60
MAX_REFRESH_HANDLES = 256
MAX_REFRESH_STATE_BYTES = 32 * 1024
AX_TIMEOUT_SECONDS = 4
_UNSAFE = re.compile(r"[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]")


class Unavailable(Exception):
    """Intentionally contains no private AX or Contacts strings."""


def normalize_handle(value: object) -> str:
    if not isinstance(value, str) or not value or len(value) > 320 or _UNSAFE.search(value):
        raise ValueError("invalid handle")
    handle = value.strip()
    if "@" in handle:
        if len(handle) > 254 or not re.fullmatch(r"[^@\s]+@[^@\s]+", handle):
            raise ValueError("invalid handle")
        return handle.lower()
    if not re.fullmatch(r"\+?[0-9(][0-9 ()./-]{5,39}", handle):
        raise ValueError("invalid handle")
    digits = re.sub(r"[^0-9]", "", handle)
    if not 7 <= len(digits) <= 15:
        raise ValueError("invalid handle")
    return "+" + digits


def name_key(value: object) -> str:
    if not isinstance(value, str) or len(value) > 160 or _UNSAFE.search(value):
        return ""
    return " ".join(unicodedata.normalize("NFC", value).split()).casefold()


def row_identity(description: object) -> str:
    if (not isinstance(description, str) or len(description) > MAX_DESCRIPTION
            or _UNSAFE.search(description)):
        return ""
    return description.split("·", 1)[0].strip()


# macOS 27.2 writes a People row with commas where 27.0 and 27.1 used dots:
# "Name, 1 mi, Boston, MA · Now" for "Name · 1 mi · Boston, MA · Now"
# (measured on the gateway 2026-11-11, row text never printed). The distance is
# the anchor, so a comma inside a name cannot move the split.
_COMMA_ROW = re.compile(r"(.+?), ([0-9]+(?:[,.][0-9]+)*\s+(?:mi|ft|km|m)), (.+)")


def legacy_row(description: object) -> object:
    """27.2's comma layout rewritten to the dotted one every check here reads.
    Anything else, including a dotted row, is returned unchanged."""
    if (not isinstance(description, str) or len(description) > MAX_DESCRIPTION
            or description.count("·") != 1):
        return description
    first, rest = description.split("·", 1)
    match = _COMMA_ROW.fullmatch(first.strip())
    if not match:
        return description
    return f"{match[1]}\u00a0· {match[2]}\u00a0· {match[3]}\u00a0·{rest}"


def age_seconds(age: str) -> int | None:
    """Conservatively preserve the old edge of Find My's rounded ages."""
    if age in {"Now", "Live"}:
        return 0
    match = re.fullmatch(r"([0-9]{1,3}) (sec\.|min\.|hr\.) ago", age)
    if not match:
        return None
    unit = {"sec.": 1, "min.": 60, "hr.": 3600}[match[2]]
    return int(match[1]) * unit + (1 if unit == 1 else unit - 1)


def parse_row(description: object, now: datetime) -> dict | None:
    """Only the verified English city/state list format, with a known age.

    Keep an age's rounding uncertainty on the old side: a displayed minute
    can be almost sixty seconds old. Never turn Home, a street or unavailable
    status into a city. Unsupported countries/layouts simply have no subtitle.
    """
    if not row_identity(description):
        return None
    parts = [part.strip() for part in description.split("·")]
    if len(parts) != 4:
        return None
    if not re.fullmatch(r"[0-9]+(?:[,.][0-9]+)*\s+(?:mi|ft|km|m)", parts[1]):
        return None
    city = parts[2]
    canadian = re.fullmatch(r"(.{2,120}) (AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT) Canada", city)
    if canadian:
        city = f"{canadian[1]}, {canadian[2]}"
    place = re.fullmatch(r"(.{2,120}), ([A-Z]{2})", city)
    if not place or not all(c.isalpha() or c in " .'-’" for c in place[1]):
        return None
    words = re.findall(r"[^\W\d_]+", place[1].casefold(), re.UNICODE)
    if not words or any(word in {"home", "work", "school", "street", "road", "avenue",
                                "lane", "boulevard", "drive", "apartment", "suite"}
                        for word in words):
        return None
    seconds = age_seconds(parts[3])
    if seconds is None or seconds >= MAX_LOCATION_AGE_SECONDS:
        return None
    observed = now - timedelta(seconds=seconds)
    # The observation keeps its real age. A five-minute snapshot lease makes
    # the next lookup verify sharing again without claiming a new observation.
    expires = min(now + timedelta(seconds=MAX_AGE_SECONDS),
                  observed + timedelta(seconds=MAX_LOCATION_AGE_SECONDS))
    stamp = lambda value: value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    return {"city": city, "observedAt": stamp(observed), "expiresAt": stamp(expires)}


def contact_handles(card: dict) -> frozenset[str]:
    handles = set()
    for item in card.get("phones", []):
        try:
            handles.add(normalize_handle(item.get("number")))
        except (ValueError, AttributeError):
            pass
    for item in card.get("emails", []):
        try:
            handles.add(normalize_handle(item.get("address")))
        except (ValueError, AttributeError):
            pass
    return frozenset(handles)


def matching_row(handle: str, rows: list[str], cards: list[dict]) -> str | None:
    """Match a handle itself, or an unambiguous saved personal contact name.

    Even unavailable/stale rows participate in ambiguity checks. Only exact
    phone digits match; a shared national suffix is not proof of identity.
    Mirrored cards may differ in extra fields when every same-name card binds
    the exact requested handle. Unexplained homonyms may not collapse.
    """
    if len(rows) > MAX_ROWS or len(cards) > MAX_CONTACTS:
        return None
    direct = []
    for row in rows:
        try:
            if normalize_handle(row_identity(row)) == handle:
                direct.append(row)
        except ValueError:
            pass
    if direct:
        return direct[0] if len(direct) == 1 else None
    by_name: dict[str, list[frozenset[str]]] = {}
    matches = set()
    for card in cards:
        first, last = name_key(card.get("first")), name_key(card.get("last"))
        full = name_key(card.get("name"))
        handles = contact_handles(card)
        if full:
            by_name.setdefault(full, []).append(handles)
        # A personal card can legitimately have just one name field. Match
        # that exact saved display name, never a shortened version of a name.
        personal = " ".join(part for part in (first, last) if part)
        if not personal or full != personal or full == name_key(card.get("org")):
            continue
        if handle in handles:
            matches.add(full)
    if len(matches) != 1:
        return None
    wanted = next(iter(matches))
    if any(handle not in handles for handles in by_name[wanted]):
        return None
    matching_rows = [row for row in rows if name_key(row_identity(row)) == wanted]
    return matching_rows[0] if len(matching_rows) == 1 else None


def select_city(handle: str, rows: list[str], cards: list[dict], now: datetime) -> dict | None:
    row = matching_row(handle, rows, cards)
    return parse_row(row, now) if row is not None else None


def needs_refresh(description: object, now: datetime) -> bool:
    """Refresh a recognized city row whose numeric age is stale.

    Validate identity text, distance and locality independently from age before
    activating Find My. Unknown labels or unsupported places never trigger it.
    """
    if not row_identity(description):
        return False
    parts = description.split("·")
    if len(parts) != 4 or parse_row("·".join(parts[:-1]) + "·Now", now) is None:
        return False
    age = parts[-1].strip()
    seconds = age_seconds(age)
    return seconds is not None and seconds >= MAX_AGE_SECONDS


class AccessibilityReader:
    """Small ctypes wrapper around public AX and CoreFoundation APIs.

    CF copy/create results are released in finally blocks. Child handles are
    borrowed only while their containing CFArray is alive. All walks share a
    deadline/node budget and each AX request has its own short timeout.
    """

    def __init__(self, monotonic=time.monotonic):
        if sys.platform != "darwin":
            raise Unavailable()
        self.clock = monotonic
        self.deadline = monotonic() + AX_TIMEOUT_SECONDS
        self.nodes = 0
        self.cf = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
        self.ax = ctypes.CDLL("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices")
        ptr, index = ctypes.c_void_p, ctypes.c_long
        self._bind(self.cf, "CFRelease", [ptr], None)
        self._bind(self.cf, "CFGetTypeID", [ptr], ctypes.c_ulong)
        self._bind(self.cf, "CFStringGetTypeID", [], ctypes.c_ulong)
        self._bind(self.cf, "CFStringCreateWithCString", [ptr, ctypes.c_char_p, ctypes.c_uint32], ptr)
        self._bind(self.cf, "CFStringGetLength", [ptr], index)
        self._bind(self.cf, "CFStringGetCString", [ptr, ptr, index, ctypes.c_uint32], ctypes.c_bool)
        self._bind(self.cf, "CFArrayGetTypeID", [], ctypes.c_ulong)
        self._bind(self.cf, "CFArrayGetCount", [ptr], index)
        self._bind(self.cf, "CFArrayGetValueAtIndex", [ptr, index], ptr)
        self._bind(self.cf, "CFBooleanGetTypeID", [], ctypes.c_ulong)
        self._bind(self.cf, "CFBooleanGetValue", [ptr], ctypes.c_bool)
        self._bind(self.cf, "CFNumberGetTypeID", [], ctypes.c_ulong)
        self._bind(self.cf, "CFNumberGetValue", [ptr, ctypes.c_int, ptr], ctypes.c_bool)
        self._bind(self.ax, "AXIsProcessTrusted", [], ctypes.c_bool)
        self._bind(self.ax, "AXUIElementCreateApplication", [ctypes.c_int], ptr)
        self._bind(self.ax, "AXUIElementSetMessagingTimeout", [ptr, ctypes.c_float], ctypes.c_int)
        self._bind(self.ax, "AXUIElementCopyAttributeValue", [ptr, ptr, ctypes.POINTER(ptr)], ctypes.c_int)

    @staticmethod
    def _bind(library, name, arguments, result):
        function = getattr(library, name)
        function.argtypes, function.restype = arguments, result

    def check(self):
        if self.clock() >= self.deadline:
            raise Unavailable()

    @contextmanager
    def attribute(self, element, name):
        self.check()
        if self.ax.AXUIElementSetMessagingTimeout(element, 0.15) != 0:
            raise Unavailable()
        key = self.cf.CFStringCreateWithCString(None, name.encode("ascii"), 0x08000100)
        value = ctypes.c_void_p()
        try:
            code = self.ax.AXUIElementCopyAttributeValue(element, key, ctypes.byref(value))
            # Unsupported/no-value is normal, transport errors invalidate the
            # entire snapshot so a partial list cannot hide an ambiguous row.
            if code not in (0, -25205, -25212):
                raise Unavailable()
            yield value.value if code == 0 else None
        finally:
            if value.value:
                self.cf.CFRelease(value)
            if key:
                self.cf.CFRelease(key)
        self.check()

    def text(self, element, name):
        with self.attribute(element, name) as value:
            if not value or self.cf.CFGetTypeID(value) != self.cf.CFStringGetTypeID():
                return ""
            if self.cf.CFStringGetLength(value) > MAX_DESCRIPTION:
                raise Unavailable()
            buffer = ctypes.create_string_buffer(MAX_DESCRIPTION * 4 + 1)
            if not self.cf.CFStringGetCString(value, buffer, len(buffer), 0x08000100):
                raise Unavailable()
            return buffer.value.decode("utf-8")

    def selected(self, element):
        with self.attribute(element, "AXValue") as value:
            if not value:
                return False
            kind = self.cf.CFGetTypeID(value)
            if kind == self.cf.CFBooleanGetTypeID():
                return bool(self.cf.CFBooleanGetValue(value))
            number = ctypes.c_int()
            return (kind == self.cf.CFNumberGetTypeID()
                    and self.cf.CFNumberGetValue(value, 9, ctypes.byref(number)) and number.value == 1)

    def children(self, element, attribute="AXChildren"):
        with self.attribute(element, attribute) as value:
            if not value:
                return
            if self.cf.CFGetTypeID(value) != self.cf.CFArrayGetTypeID():
                raise Unavailable()
            count = self.cf.CFArrayGetCount(value)
            if count > MAX_NODES:
                raise Unavailable()
            for index in range(count):
                self.check()
                yield self.cf.CFArrayGetValueAtIndex(value, index)

    def walk(self, element, depth=0):
        self.check()
        self.nodes += 1
        if self.nodes > MAX_NODES or depth > MAX_DEPTH:
            raise Unavailable()
        yield element
        for child in self.children(element):
            yield from self.walk(child, depth + 1)

    def snapshot(self, pid):
        if not self.ax.AXIsProcessTrusted():
            raise Unavailable()
        application = self.ax.AXUIElementCreateApplication(pid)
        if not application:
            raise Unavailable()
        snapshots = []
        try:
            for window in self.children(application, "AXWindows"):
                for element in self.walk(window):
                    if self.text(element, "AXIdentifier") != "CardContainerView":
                        continue
                    rows, labels, heading, selected = [], [], False, False
                    for item in self.walk(element):
                        role = self.text(item, "AXRole")
                        if role == "AXHeading":
                            if self.text(item, "AXDescription") == "People":
                                heading = True
                        elif role == "AXRadioButton" and self.text(item, "AXDescription") == "People":
                            selected = self.selected(item)
                        elif role == "AXButton" and self.text(item, "AXIdentifier") == "ListEntityRow":
                            rows.append(self.text(item, "AXDescription"))
                        elif (role == "AXStaticText"
                              and self.text(item, "AXIdentifier").startswith("ListEntityRow")):
                            # macOS 27.2: the row is static text whose identifier
                            # repeats "ListEntityRow", and there is no row button.
                            labels.append(self.text(item, "AXDescription"))
                        if len(rows) + len(labels) > MAX_ROWS:
                            raise Unavailable()
                    rows = [legacy_row(value) for value in (rows or labels)]
                    # A user can change tabs during the walk. Recheck the
                    # People gate before accepting the collected rows.
                    if heading and selected and self.people_gate(element):
                        snapshots.append(rows)
        finally:
            self.cf.CFRelease(application)
        if len(snapshots) != 1:
            raise Unavailable()
        return snapshots[0]

    def people_gate(self, container):
        heading, selected = False, False
        for element in self.walk(container):
            role = self.text(element, "AXRole")
            if role == "AXHeading":
                heading = heading or self.text(element, "AXDescription") == "People"
            elif role == "AXRadioButton" and self.text(element, "AXDescription") == "People":
                selected = self.selected(element)
        return heading and selected


def read_rows(*, enabled: bool, reader_factory=AccessibilityReader, runner=subprocess.run) -> list[str]:
    """The caller's enabled setting is required even to launch Find My.

    Launch in the background only after the non-prompting AX trust preflight.
    A different selected tab is unavailable: never switch tabs or steal focus.
    """
    if not enabled:
        return []
    reader = reader_factory()
    if not reader.ax.AXIsProcessTrusted():
        return []
    result = runner(["/usr/bin/pgrep", "-x", "FindMy"], capture_output=True, timeout=1)
    if result.returncode != 0:
        runner(["/usr/bin/open", "-g", "-a", "FindMy"], stdout=subprocess.DEVNULL,
               stderr=subprocess.DEVNULL, timeout=1)
        result = runner(["/usr/bin/pgrep", "-x", "FindMy"], capture_output=True, timeout=1)
    raw = result.stdout.decode("ascii") if isinstance(result.stdout, bytes) else result.stdout
    if (result.returncode != 0 or not raw or len(raw) > 32
            or not re.fullmatch(r"[0-9]{1,10}\s*", raw)
            or not 0 < int(raw.strip()) < 2 ** 31):
        return []
    return reader.snapshot(int(raw.strip()))


_FOCUS_SCRIPT = r"""
ObjC.import('AppKit');
function run(args) {
  var workspace = $.NSWorkspace.sharedWorkspace;
  var front = workspace.frontmostApplication;
  if (args[0] === 'start') {
    var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.findmy');
    if (Number(apps.count) !== 1 || !front) return '{}';
    var target = apps.objectAtIndex(0);
    var previousPid = Number(front.processIdentifier);
    var findmyPid = Number(target.processIdentifier);
    if (!target.activateWithOptions($.NSApplicationActivateIgnoringOtherApps)) return '{}';
    return JSON.stringify({previousPid: previousPid, findmyPid: findmyPid});
  }
  var previous = Number(args[1]), expected = Number(args[2]);
  // A user choosing another app takes precedence over our restoration.
  if (front && Number(front.processIdentifier) === expected && previous !== expected) {
    var original = $.NSRunningApplication.runningApplicationWithProcessIdentifier(previous);
    if (original) original.activateWithOptions($.NSApplicationActivateIgnoringOtherApps);
  }
  return '{}';
}
"""


@contextmanager
def refresh_lock(directory=None):
    directory = directory or os.path.expanduser("~/.blip")
    os.makedirs(directory, mode=0o700, exist_ok=True)
    descriptor = os.open(os.path.join(directory, "findmy-ui.lock"),
                         os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        info = os.fstat(descriptor)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_nlink != 1):
            raise Unavailable()
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(descriptor)


def claim_refresh(handle, directory, clock):
    """Under refresh_lock, persist a bounded per-handle attempt before focusing.

    Hashes avoid plaintext handles on disk; they are identifiers, not secrets.
    Corrupt or unsafe state fails closed. Future stamps (clock rollback) keep
    their cooldown rather than permitting repeated focus changes.
    """
    key = hashlib.sha256(normalize_handle(handle).encode("utf-8")).hexdigest()
    stamp = clock()
    if type(stamp) not in (int, float) or not math.isfinite(stamp) or stamp < 0:
        raise Unavailable()
    path = os.path.join(directory or os.path.expanduser("~/.blip"), "findmy-refresh.json")
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    with os.fdopen(descriptor, "r+", encoding="ascii") as state_file:
        info = os.fstat(state_file.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600
                or info.st_size > MAX_REFRESH_STATE_BYTES):
            raise Unavailable()
        raw = state_file.read(MAX_REFRESH_STATE_BYTES + 1)
        entries = json.loads(raw) if raw else {}
        if (not isinstance(entries, dict) or len(entries) > MAX_REFRESH_HANDLES
                or any(not re.fullmatch(r"[0-9a-f]{64}", key)
                       or type(value) not in (int, float) or not math.isfinite(value) or value < 0
                       for key, value in entries.items())):
            raise Unavailable()
        entries = {key: value for key, value in entries.items()
                   if stamp - value < REFRESH_COOLDOWN_SECONDS}
        if key in entries or len(entries) >= MAX_REFRESH_HANDLES:
            return False
        entries[key] = stamp
        encoded = json.dumps(entries, separators=(",", ":"))
        if len(encoded) > MAX_REFRESH_STATE_BYTES:
            raise Unavailable()
        state_file.seek(0)
        state_file.write(encoded)
        state_file.truncate()
        state_file.flush()
        os.fsync(state_file.fileno())
        return True


def foreground_rows(*, enabled: bool, handle: str, row_reader=read_rows, runner=subprocess.run,
                    sleeper=time.sleep, lock_directory=None, reader_factory=AccessibilityReader,
                    clock=time.time) -> list[str] | None:
    """Refresh a stale target with a brief, explicitly opted-in focus bounce.

    AppKit calls require no Apple Events grant and never change Find My's tab.
    Restore only while Find My is still frontmost, including on AX failures.
    None means cooldown: the caller can keep its passive, revalidated snapshot.
    """
    if not enabled:
        return []
    # Trust may have changed since the passive read. Never activate before
    # checking it again, and never use a prompting trust API.
    reader = reader_factory()
    if not reader.ax.AXIsProcessTrusted():
        return []
    with refresh_lock(lock_directory):
        if not claim_refresh(handle, lock_directory, clock):
            return None
        command = ["/usr/bin/osascript", "-l", "JavaScript", "-e", _FOCUS_SCRIPT]
        started = runner(command + ["start"], capture_output=True, text=True, timeout=2)
        if started.returncode != 0 or len(started.stdout or "") > 256:
            raise Unavailable()
        state = json.loads(started.stdout)
        if (not isinstance(state, dict) or set(state) != {"previousPid", "findmyPid"}
                or any(type(value) is not int or not 0 < value < 2 ** 31 for value in state.values())):
            raise Unavailable()
        try:
            sleeper(2)
            return row_reader(enabled=True)
        finally:
            runner(command + ["restore", str(state["previousPid"]), str(state["findmyPid"])],
                   capture_output=True, text=True, timeout=2)


def load_cards(contacts) -> list[dict]:
    """Use existing read-only Contacts queries, without their suffix dedupe.

    Any unreadable source aborts rather than mistaking an incomplete book for
    global name uniqueness. SQLite progress callbacks bound busy work.
    """
    deadline = time.monotonic() + 3
    cards = []
    for path in contacts.bounded_source_dbs():
        if time.monotonic() >= deadline:
            raise Unavailable()
        with closing(contacts.open_db(path)) as connection:
            connection.execute("PRAGMA busy_timeout = 100")
            connection.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
            count = connection.execute("SELECT COUNT(*) FROM ZABCDRECORD").fetchone()[0]
            if count > MAX_CONTACTS - len(cards):
                raise Unavailable()
            cards.extend(contacts.fetch_contacts(connection))
    return cards


def unavailable_reason(target: object, now: datetime) -> str:
    """A bounded diagnostic enum, never a contact or accessibility string."""
    if target is None:
        return "no-match"
    if not isinstance(target, str):
        return "unsupported-location"
    parts = target.split("·")
    if len(parts) in (2, 3):
        return "location-unavailable"
    if len(parts) != 4 or parse_row("·".join(parts[:-1]) + "·Now", now) is None:
        return "unsupported-location"
    if parts[-1].strip() == "Paused":
        return "location-unavailable"
    seconds = age_seconds(parts[-1].strip())
    if seconds is not None and seconds >= MAX_LOCATION_AGE_SECONDS:
        return "observation-too-old"
    return "unsupported-location"


def shared_city(handle: object, contacts, *, enabled: bool, row_reader=read_rows,
                card_loader=load_cards, refresher=foreground_rows, now=None) -> dict:
    canonical = normalize_handle(handle)
    result = {"ok": True, "handle": canonical, "city": None,
              "reason": "source-unavailable" if enabled else "disabled"}
    if not enabled:
        return result
    try:
        rows = row_reader(enabled=True)
        if not isinstance(rows, list) or not rows or len(rows) > MAX_ROWS:
            return result
        # A handle shown directly by Find My needs no address-book lookup.
        direct = any(_same_handle(row_identity(row), canonical) for row in rows)
        cards = [] if direct or not rows else card_loader(contacts)
        target = matching_row(canonical, rows, cards)
        if needs_refresh(target, now or datetime.now(timezone.utc)):
            refreshed = refresher(enabled=True, handle=canonical)
            if refreshed is not None:
                rows = refreshed
                if not isinstance(rows, list) or not rows or len(rows) > MAX_ROWS:
                    return result
                direct = any(_same_handle(row_identity(row), canonical) for row in rows)
                # Sharing, names, and the address book can change during refresh.
                cards = [] if direct or not rows else card_loader(contacts)
        city = select_city(canonical, rows, cards, now or datetime.now(timezone.utc))
        if city:
            result.update(city)
            result["reason"] = "available"
        else:
            result["reason"] = unavailable_reason(matching_row(canonical, rows, cards),
                                                  now or datetime.now(timezone.utc))
    except Exception:
        # Never return an exception containing a path, contact or AX payload.
        pass
    return result


def _same_handle(value, wanted):
    try:
        return normalize_handle(value) == wanted
    except ValueError:
        return False
