"""Synthetic transport tests; no Contacts access or real card mutations."""
import fcntl
import importlib.machinery
import importlib.util
import io
import json
import pathlib
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

PATH = pathlib.Path(__file__).with_name("contact-save")
loader = importlib.machinery.SourceFileLoader("contact_save", str(PATH))
spec = importlib.util.spec_from_loader(loader.name, loader)
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)
REQUEST = {"operation": "create", "confirmed": True, "handle": "+15551234567",
           "firstName": "Example", "lastName": "Person", "phone": "+15551234567", "email": ""}


class ContactSaveTransportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        self.bin = (self.root / "bin").resolve()
        self.bin.mkdir()
        (self.bin / "contact-save.js").write_text("// synthetic helper")

    def tearDown(self):
        self.temp.cleanup()

    def call(self, data, runner):
        stdin = types.SimpleNamespace(buffer=io.BytesIO(data))
        with patch.object(module, "__file__", str(self.bin / "contact-save")), \
                patch.object(module.sys, "stdin", stdin), \
                patch.object(module, "bounded_process", runner):
            return module.main()

    def test_fields_use_stdin_and_fixed_argv(self):
        payload = json.dumps(REQUEST).encode()

        def run(args, data, maximum, timeout):
            self.assertGreaterEqual(timeout, 150)
            self.assertEqual(args, ["/usr/bin/osascript", "-l", "JavaScript", str(self.bin / "contact-save.js")])
            if json.loads(data).get("phase") == "inspect":
                return 0, b'{"ok":true,"duplicate":false,"phones":[]}'
            self.assertEqual(json.loads(data), json.loads(payload))
            self.assertEqual(maximum, module.MAX_BYTES)
            return 0, b'{"ok":true}'

        self.assertEqual(self.call(payload, run), {"ok": True})
        self.assertEqual((self.root / "contact-save.lock").read_bytes(), b"")

    def test_invalid_and_oversized_requests_never_invoke_contacts(self):
        def forbidden(*args, **kwargs):
            self.fail("Contacts invoked for an invalid request")
        for payload in [b"not json", b"null", b"[]", b"{}", b"x" * (module.MAX_BYTES + 1),
                        json.dumps({**REQUEST, "confirmed": False}).encode()]:
            self.assertEqual(self.call(payload, forbidden), {"ok": False, "code": "invalid"})

    def test_unknown_response_or_timeout_cannot_claim_nothing_was_saved(self):
        payload = json.dumps(REQUEST).encode()
        for output in [b"not json", b"[]"]:
            with patch.object(module, "check_duplicates", lambda *args: None):
                self.assertEqual(self.call(payload, lambda *args: (0, output)),
                                 {"ok": False, "code": "unknown"})
        def timeout(*args):
            raise subprocess.TimeoutExpired("osascript", 155)
        with patch.object(module, "check_duplicates", lambda *args: None):
            self.assertEqual(self.call(payload, timeout), {"ok": False, "code": "unknown"})

    def test_full_field_validation_precedes_lookup(self):
        changes = [{"phone": "+15551234568"}, {"handle": "chat1234"}, {"firstName": "", "lastName": ""},
                   {"firstName": "x" * 161}, {"lastName": "Example\u202ePerson"}, {"email": "not an email"}]
        for change in changes:
            self.assertEqual(self.call(json.dumps({**REQUEST, **change}).encode(),
                                       lambda *args: self.fail("invalid request performed lookup")),
                             {"ok": False, "code": "invalid"})

    def test_parenthesized_phone_preserves_selected_identity(self):
        request = {**REQUEST, "handle": "(555) 123-4567", "phone": "5551234567"}
        self.assertEqual(module.valid_request(request), request)
        request = {**request, "handle": "5551234567", "phone": "(555) 123-4567"}
        self.assertEqual(module.valid_request(request), request)
        for invalid in ("(555) 123-4568", "(abc) 123-4567", "(12)", "()", "555+1234567"):
            with self.subTest(phone=invalid), self.assertRaises(ValueError):
                module.valid_request({**request, "phone": invalid})

    def test_region_aware_duplicates_reuse_the_bridge_matcher(self):
        parse, matches = module.phone_matcher(PATH)
        cases = [("1", "+12025550187", "2025550187", True),
                 ("1", "2025550187", "+12025550187", True),
                 ("47", "+4712345678", "123 45 678", True),
                 ("44", "+447700900187", "07700 900187", True),
                 ("1", "+12025550187", "+442025550187", False),
                 ("1", "+12025550187", "5550187", False)]
        for region, handle, card, duplicate in cases:
            request = {**REQUEST, "handle": handle, "phone": handle}
            response = {"ok": True, "duplicate": False, "phones": [card]}
            with patch.dict(parse.__globals__, {"_home_calling_code": lambda: region}), \
                    patch.object(module, "phone_matcher", lambda unused: (parse, matches)), \
                    patch.object(module, "invoke", lambda *args: response):
                self.assertEqual(module.check_duplicates(request, self.bin / "contact-save.js"),
                                 {"ok": False, "code": "duplicate"} if duplicate else None)

    def test_unknown_phone_region_does_not_guess_and_create(self):
        parse, matches = module.phone_matcher(PATH)
        response = {"ok": True, "duplicate": False, "phones": ["2025550187"]}
        with patch.dict(parse.__globals__, {"_home_calling_code": lambda: None}), \
                patch.object(module, "phone_matcher", lambda unused: (parse, matches)), \
                patch.object(module, "invoke", lambda *args: response):
            self.assertEqual(module.check_duplicates({**REQUEST, "handle": "+12025550187", "phone": "+12025550187"}, self.bin / "contact-save.js"),
                             {"ok": False, "code": "unavailable"})

    def test_duplicate_inspection_failure_blocks_creation(self):
        for response in [{"ok": False}, {"ok": True}, {"ok": True, "duplicate": False, "phones": [None]},
                         {"ok": True, "duplicate": False, "phones": ["x"] * 65}]:
            with patch.object(module, "invoke", lambda *args: response):
                self.assertEqual(module.check_duplicates(REQUEST, self.bin / "contact-save.js"),
                                 {"ok": False, "code": "unavailable"})

    def test_process_drains_stdin_and_caps_both_output_streams(self):
        code, output = module.bounded_process([sys.executable, "-c", "import sys; sys.stdout.buffer.write(sys.stdin.buffer.read())"],
                                               b"synthetic", 100, 2)
        self.assertEqual((code, output), (0, b"synthetic"))
        for stream in ("stdout", "stderr"):
            with self.assertRaises(ValueError):
                module.bounded_process([sys.executable, "-c", "import sys; sys." + stream + ".write('x' * 4096)"],
                                       b"", 100, 2)
        with self.assertRaises(TimeoutError):
            module.bounded_process([sys.executable, "-c", "import time; time.sleep(1)"], b"", 100, 0.02)

    def test_lock_covers_lookup_and_creation_across_sessions(self):
        payload = json.dumps(REQUEST).encode()
        with (self.root / "contact-save.lock").open("wb") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(self.call(payload, lambda *args, **kwargs: self.fail("concurrent creation")),
                             {"ok": False, "code": "busy"})

    def test_lock_symlink_is_refused(self):
        target = self.root / "untouched"
        target.write_text("unchanged")
        (self.root / "contact-save.lock").symlink_to(target)
        self.assertEqual(self.call(json.dumps(REQUEST).encode(), lambda *args, **kwargs: self.fail("unsafe lock")),
                         {"ok": False, "code": "unavailable"})
        self.assertEqual(target.read_text(), "unchanged")


if __name__ == "__main__":
    unittest.main()
