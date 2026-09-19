"""Native adapter regressions, using fake accessibility objects (no desktop)."""
import importlib.util
from pathlib import Path
import re
import sys
from types import SimpleNamespace as NS
import unittest
from unittest.mock import patch

states = NS(**{s: s for s in ("FOCUSED", "SHOWING", "SENSITIVE", "EDITABLE", "MULTI_LINE")})
atspi = NS(init=lambda: None, set_timeout=lambda *a: None, StateType=states,
           CoordType=NS(WINDOW=0), Role=NS(DOCUMENT_WEB="document", DOCUMENT_FRAME="frame"))
sys.modules["gi"] = NS(require_version=lambda *a: None)
sys.modules["gi.repository"] = NS(Atspi=atspi, GLib=NS(MainLoop=lambda: None), Gio=NS())
spec = importlib.util.spec_from_file_location("adapter", Path(__file__).with_name("otp-desktop.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class Node:
    def __init__(self, index=None, children=()):
        self.index, self.children, self.parent = index, list(children), None
        self.flags = {"SHOWING", "SENSITIVE", "EDITABLE"} if index is not None else set()
        self.attrs = {"tag": "input", "text-input-type": "tel"}
        self.rect = NS(x=(index or 0) * 144, y=200, width=128, height=88)
        self.count, self.pid, self.role = 0, 100, "entry" if index is not None else "section"
        for c in children:
            c.parent = self

    def is_text(self): return self.index is not None
    def get_state_set(self): return NS(contains=lambda s: s in self.flags)
    def get_attributes(self): return self.attrs
    def get_component_iface(self): return self
    def get_text_iface(self): return self
    def get_extents(self, _): return self.rect
    def get_character_count(self): return self.count
    def get_application(self): return self
    def get_process_id(self): return self.pid
    def get_parent(self): return self.parent
    def get_child_count(self): return len(self.children)
    def get_child_at_index(self, i): return self.children[i]
    def get_role(self): return self.role
    def is_editable_text(self): return False
    def clear_cache(self): pass


class Segments(unittest.TestCase):
    def setUp(self):
        self.boxes = [Node(i) for i in range(6)]
        self.root = Node(children=[Node(children=[Node(children=[n])]) for n in self.boxes])
        self.window = {"pid": 100, "address": "0xabc"}
        self.metadata = {"web": True, "tag": "input", "type": "tel", "empty": True}
        self.boxes[0].flags.add("FOCUSED")

    def group(self):
        return m.segment_group(self.boxes[0], self.window, self.metadata)

    def test_nested_boxes_without_html_length_declarations(self):
        self.assertEqual(self.group(), self.boxes)
        for box in self.boxes:
            box.attrs["maxlength"] = "1"
        self.assertEqual(self.group(), self.boxes)

    def test_different_rows_and_large_inputs_are_not_a_group(self):
        self.boxes[1].rect.y += 100
        self.assertIsNone(self.group())
        self.boxes[1].rect.y -= 100
        self.boxes[0].rect.width = 800
        self.assertIsNone(self.group())

    def test_hidden_foreign_or_unrelated_fields_refuse(self):
        for change in (lambda b: b.flags.remove("SHOWING"), lambda b: setattr(b, "pid", 200),
                       lambda b: b.attrs.update({"text-input-type": "password"}), lambda b: setattr(b, "count", 2)):
            self.setUp()
            change(self.boxes[3])
            self.assertIsNone(self.group())

    def run_fill(self, advance=True, window_change=False, lock=False, occupied=False):
        chosen = {"window": self.window["address"], "pid": self.window["pid"], "browser": True, "field": self.metadata,
                  "segments": {"count": 6, "index": 0, "empty": not occupied}}
        clock, keys = [1000.0], []
        m.focused, m.last_segments = self.boxes[0], self.boxes
        def hypr(command, cap):
            if 'state="down"' in command:
                keys.append(re.search(r'key="([^"]+)"', command)[1])
            else:
                i = len(keys) - 1
                self.boxes[i].count = 1
                self.boxes[i].flags.discard("FOCUSED")
                if advance and i < 5:
                    self.boxes[i + 1].flags.add("FOCUSED")
            return b"ok"
        with patch.object(m, "snapshot", return_value=chosen), patch.object(m, "poll"), \
             patch.object(m, "hypr", side_effect=hypr), \
             patch.object(m, "active", side_effect=lambda: {**self.window, "address": "0xdef"} if window_change and keys else self.window), \
             patch.object(m, "unlocked", side_effect=lambda: not (lock and keys)), \
             patch.object(m.time, "time", side_effect=lambda: clock[0]), \
             patch.object(m.time, "sleep", side_effect=lambda delay: clock.__setitem__(0, clock[0] + delay)):
            m.fill({"code": "012345", "target": chosen, "deadline": 1001500, "mode": "smart"})
        return keys

    def test_autoadvance_fills_every_digit_preserving_zero(self):
        self.assertEqual("".join(self.run_fill()), "012345")

    def test_unexpected_focus_window_change_and_lock_stop_remaining_digits(self):
        for args in ({"advance": False}, {"window_change": True}, {"lock": True}):
            self.setUp()
            self.assertEqual(self.run_fill(**args), ["0"])

    def test_partially_filled_group_is_not_overwritten(self):
        self.assertEqual(self.run_fill(occupied=True), [])


class SingleField(unittest.TestCase):
    """Gecko reports set_text_contents() success while ignoring the write."""

    def run_fill(self, accepts_write):
        box = Node(0)
        box.flags.add("FOCUSED")
        window = {"pid": 100, "address": "0xabc"}
        metadata = {"web": True, "tag": "input", "type": "text", "empty": True}
        chosen = {"window": window["address"], "pid": window["pid"], "browser": True, "field": metadata}
        writes, keys = [], []
        def set_text_contents(text):
            writes.append(text)
            if accepts_write:
                box.count = len(text)
            return True
        box.is_editable_text = lambda: True
        box.get_editable_text_iface = lambda: NS(set_text_contents=set_text_contents)
        clock = [1000.0]
        def hypr(command, cap):
            if 'state="down"' in command:
                keys.append(re.search(r'key="([^"]+)"', command)[1])
            else:
                box.count = len(keys)
            return b"ok"
        m.focused, m.last_segments = box, None
        with patch.object(m, "snapshot", return_value=chosen), patch.object(m, "poll"), \
             patch.object(m, "hypr", side_effect=hypr), patch.object(m, "active", return_value=window), \
             patch.object(m, "unlocked", return_value=True), \
             patch.object(m.time, "time", side_effect=lambda: clock[0]), \
             patch.object(m.time, "sleep", side_effect=lambda delay: clock.__setitem__(0, clock[0] + delay)):
            m.fill({"code": "482913", "target": chosen, "deadline": 1001500, "mode": "smart"})
        return writes, keys

    def test_accepted_write_does_not_also_type(self):
        writes, keys = self.run_fill(accepts_write=True)
        self.assertEqual((writes, keys), (["482913"], []))

    def test_ignored_write_falls_back_to_typing(self):
        writes, keys = self.run_fill(accepts_write=False)
        self.assertEqual("".join(keys), "482913")


if __name__ == "__main__":
    unittest.main()
