#!/usr/bin/env python3
import importlib.machinery
import importlib.util
import io
import json
import os
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from unittest import mock


SCRIPT = os.path.join(os.path.dirname(__file__), "contacts")
loader = importlib.machinery.SourceFileLoader("blip_contacts", SCRIPT)
spec = importlib.util.spec_from_loader(loader.name, loader)
contacts = importlib.util.module_from_spec(spec)
loader.exec_module(contacts)


class Stdin:
    def __init__(self, value: bytes):
        self.buffer = io.BytesIO(value)


class ContactResolverTests(unittest.TestCase):
    def test_card_deletion_uses_the_current_contacts_framework(self):
        script_helper = os.path.join(os.path.dirname(__file__), "contact-repair.js")
        native_helper = os.path.join(os.path.dirname(__file__), "contact-delete.swift")
        with open(script_helper, "r", encoding="utf-8") as stream:
            script_source = stream.read()
        with open(native_helper, "r", encoding="utf-8") as stream:
            native_source = stream.read()
        self.assertNotIn("removeRecord(", script_source)
        # Contacts.delete() covers the person delete-fallback AND field
        # removal — the remove-from-person Apple event is broken on current
        # macOS ("Message not understood"), deleting the specifier works.
        self.assertNotIn("contacts.remove(", script_source)
        self.assertNotIn("Contacts.remove(", script_source)
        self.assertGreaterEqual(script_source.count("delete("), 3)
        self.assertIn('request.operation === "delete-fallback"', script_source)
        self.assertIn('value.operation === "delete-fallback"', script_source)
        # the add-to-person Apple event errors with "No error. (0)" on current
        # macOS; the push pattern is the one that works
        self.assertIn('person[kind === "email" ? "emails" : "phones"].push(entry)', script_source)
        # add-only edits keep existing entries (and their damaged rows) untouched
        self.assertIn("function addedEntries", script_source)
        self.assertIn("CNSaveRequest()", native_source)
        self.assertIn("save.delete(mutable)", native_source)
        self.assertIn("request.unifyResults = false", native_source)
        self.assertIn("grouped[container, default: []]", native_source)
        # every save stage retries transient Cocoa 134092 against a FRESH
        # store session, refetching by pinned identifier each attempt
        self.assertIn("func withFreshStoreRetry", native_source)
        self.assertIn("try body(CNContactStore())", native_source)
        self.assertIn("nsError.code == 134092", native_source)
        self.assertIn('withFreshStoreRetry("update survivor")', native_source)
        self.assertIn('withFreshStoreRetry("delete sources")', native_source)
        self.assertIn('withFreshStoreRetry("save same-account merge")', native_source)
        self.assertIn("Contacts saved the merged contact but could not delete", native_source)
        # unchanged label+value rows are REUSED, never rebuilt: replacing a value
        # forces contactsd to fault the old row out, and one damaged stored row
        # then fails the whole save with Cocoa 134092. Contacts.app's scripting
        # layer also reports unlabeled values under default kind names, which
        # must normalize back to nil instead of becoming literal custom labels.
        self.assertIn("func reuseLabeled", native_source)
        self.assertIn("func normalizedLabel", native_source)
        self.assertIn('kindDefaults: ["Email"]', native_source)
        self.assertIn('kindDefaults: ["Phone"]', native_source)
        # residual failures name their stage and code so reports are diagnosable
        self.assertIn("(stage: \\(stage), code \\(nsError.code))", native_source)

    def test_native_deletion_uses_fixed_argv_and_private_stdin(self):
        completed = (0, b'{"deletedCount":2,"ok":true}', b"")
        file_info = os.stat_result((stat.S_IFREG | 0o700, 0, 0, 1, os.getuid(), 0, 1, 0, 0, 0))
        with mock.patch.object(contacts.os, "lstat", return_value=file_info), mock.patch.object(
            contacts, "run_bounded_process", return_value=completed,
        ) as run:
            result = contacts.run_contact_delete(["person-1", "person-2"])
        argv, payload = run.call_args.args
        self.assertEqual(len(argv), 1)
        self.assertTrue(argv[0].endswith("contact-delete"))
        self.assertNotIn(b"person-1", " ".join(argv).encode())
        self.assertIn(b"person-1", payload)
        self.assertEqual(result["deletedCount"], 2)

    def test_handle_normalization(self):
        self.assertEqual(contacts.normalize_resolve_handle("+1 (555) 010-0001")[1], "5550100001")
        self.assertEqual(contacts.normalize_resolve_handle("Person@Example.COM")[1], "person@example.com")
        with self.assertRaisesRegex(ValueError, "valid phone"):
            contacts.normalize_resolve_handle("--not-a-phone")

    def test_source_names_come_from_active_mac_accounts_without_exposing_ids(self):
        with tempfile.TemporaryDirectory() as root:
            accounts_db = os.path.join(root, "Accounts4.sqlite")
            with sqlite3.connect(accounts_db) as con:
                con.executescript("""
                    CREATE TABLE ZACCOUNTTYPE (
                        Z_PK INTEGER PRIMARY KEY,
                        ZACCOUNTTYPEDESCRIPTION TEXT
                    );
                    CREATE TABLE ZACCOUNT (
                        Z_PK INTEGER PRIMARY KEY,
                        ZACTIVE INTEGER,
                        ZACCOUNTTYPE INTEGER,
                        ZPARENTACCOUNT INTEGER,
                        ZIDENTIFIER TEXT,
                        ZACCOUNTDESCRIPTION TEXT,
                        ZUSERNAME TEXT
                    );
                    INSERT INTO ZACCOUNTTYPE VALUES (1, 'CardDAV');
                    INSERT INTO ZACCOUNT VALUES (1, 1, 1, NULL, 'parent', 'Personal iCloud', 'private@example.com');
                    INSERT INTO ZACCOUNT VALUES (2, 1, 1, 1, 'source-one', 'iCloud', 'private@example.com');
                    INSERT INTO ZACCOUNT VALUES (3, 0, 1, NULL, 'inactive', 'Old account', 'old@example.com');
                """)
            paths = [
                os.path.join(root, "AddressBook", "Sources", "source-one", "AddressBook-v22.abcddb"),
                os.path.join(root, "AddressBook", "AddressBook-v22.abcddb"),
            ]
            with mock.patch.object(contacts, "ACCOUNTS_DB", accounts_db):
                labels = contacts.contact_source_names(paths)
            self.assertEqual(labels["source-one"], "Personal iCloud")
            self.assertEqual(labels["__on_my_mac__"], "On My Mac")
            self.assertNotIn("inactive", labels)
            self.assertNotIn("private@example.com", json.dumps(labels))

    def test_candidates_group_duplicate_cards_by_name(self):
        records = [
            {"name": "Alex Rivera", "uid": "one", "source": "a", "sourceName": "iCloud", "modified": 2, "photo": True},
            {"name": "Alex Rivera", "uid": "two", "source": "b", "sourceName": "Google", "modified": 3, "photo": False},
            {"name": "Pat Rivera", "uid": "three", "source": "b", "sourceName": "Google", "modified": 1, "photo": False},
        ]
        with mock.patch.object(
            contacts, "matching_records", return_value=("+15550100001", "5550100001", records)
        ), mock.patch.object(
            contacts, "active_record_uids", return_value={record["uid"] for record in records}
        ):
            handle, candidates, by_name = contacts.contact_candidates("ignored")
        self.assertEqual(handle, "+15550100001")
        self.assertEqual([row["name"] for row in candidates], ["Alex Rivera", "Pat Rivera"])
        self.assertEqual(candidates[0]["recordCount"], 2)
        self.assertEqual(candidates[0]["sourceCount"], 2)
        self.assertTrue(candidates[0]["hasPhoto"])
        self.assertEqual(len(candidates[0]["cards"]), 2)
        self.assertEqual(
            [card["accountNumber"] for card in candidates[0]["cards"]], [1, 2]
        )
        self.assertEqual(
            [card["sourceName"] for card in candidates[0]["cards"]], ["iCloud", "Google"]
        )
        self.assertRegex(candidates[0]["cards"][0]["token"], r"^sha256:[0-9a-f]{64}$")
        self.assertNotEqual(candidates[0]["cards"][0]["token"], candidates[0]["token"])
        self.assertEqual(len(by_name["alex rivera"]), 2)
        self.assertRegex(candidates[0]["token"], r"^sha256:[0-9a-f]{64}$")

    def test_candidate_counts_multiple_matching_fields_as_one_card(self):
        records = [{
            "name": "Alex Rivera", "uid": "one", "source": "a", "modified": 2,
            "photo": False, "fields": [
                {"id": "field-1", "value": "+15550100001", "label": "mobile"},
                {"id": "field-2", "value": "5550100001", "label": "home"},
            ],
        }]
        with mock.patch.object(
            contacts, "matching_records", return_value=("+15550100001", "5550100001", records)
        ), mock.patch.object(contacts, "active_record_uids", return_value={"one"}):
            _, candidates, _ = contacts.contact_candidates("ignored")
        self.assertEqual(candidates[0]["recordCount"], 1)
        self.assertEqual(candidates[0]["cards"][0]["matchCount"], 2)

    def test_candidates_exclude_inactive_account_cache_rows(self):
        records = [
            {"name": "Alex Rivera", "uid": "active", "source": "a", "modified": 2,
             "photo": True, "fields": []},
            {"name": "Mom", "uid": "inactive", "source": "b", "modified": 3,
             "photo": True, "fields": []},
        ]
        with mock.patch.object(
            contacts, "matching_records", return_value=("+15550100001", "5550100001", records)
        ), mock.patch.object(contacts, "active_record_uids", return_value={"active"}):
            _, candidates, by_name = contacts.contact_candidates("ignored")
        self.assertEqual([candidate["name"] for candidate in candidates], ["Alex Rivera"])
        self.assertNotIn("mom", by_name)

    def test_contact_audit_classifies_matches_without_returning_unmatched_handles(self):
        one = {"name": "Alex", "recordCount": 1, "sourceCount": 1, "cards": []}
        duplicate = {"name": "Pat", "recordCount": 2, "sourceCount": 2, "cards": []}
        conflict = {"name": "Sam", "recordCount": 1, "sourceCount": 1, "cards": []}
        responses = {
            "5550100001": ("+15550100001", [one], {}),
            "5550100002": ("+15550100002", [duplicate], {}),
            "5550100003": ("+15550100003", [one, conflict], {}),
            "5550100004": ("+15550100004", [], {}),
        }
        with mock.patch.object(
            contacts, "contact_candidates",
            side_effect=lambda handle: responses[contacts.normalize_resolve_handle(handle)[1]],
        ):
            result = contacts.audit_contact_handles(list(row[0] for row in responses.values()))
        self.assertEqual(result["handleCount"], 4)
        self.assertEqual(result["noMatchCount"], 1)
        self.assertEqual([row["handle"] for row in result["singleCards"]], ["+15550100001"])
        self.assertEqual([row["handle"] for row in result["duplicates"]], ["+15550100002"])
        self.assertEqual([row["handle"] for row in result["conflicts"]], ["+15550100003"])
        self.assertNotIn("+15550100004", json.dumps(result))

    def test_contact_audit_rejects_duplicate_or_excessive_handles(self):
        with self.assertRaisesRegex(ValueError, "duplicate handle"):
            contacts.audit_contact_handles(["+15550100001", "5550100001"])
        with self.assertRaisesRegex(ValueError, "handle list"):
            contacts.audit_contact_handles(["+15550100001"] * (contacts.MAX_AUDIT_HANDLES + 1))

    def test_active_card_filter_rejects_ids_the_object_layer_did_not_receive(self):
        records = [{"uid": "active"}, {"uid": "inactive"}]
        with mock.patch.object(
            contacts, "run_contact_repair", return_value={"ok": True, "available": ["other"]}
        ):
            with self.assertRaisesRegex(RuntimeError, "active-card id"):
                contacts.active_record_uids(records)

    def test_resolve_input_is_bounded_before_json_parse(self):
        original = sys.stdin
        try:
            sys.stdin = Stdin(b" " * (contacts.MAX_RESOLVE_INPUT_BYTES + 1))
            with self.assertRaisesRegex(ValueError, "too large"):
                contacts.read_resolve_request()
        finally:
            sys.stdin = original

    def test_open_uses_a_validated_addressbook_url_and_fixed_argv(self):
        name = "Alex Rivera"
        key = "5550100001"
        token = contacts.resolve_token(key, name)
        exact_token = contacts.card_token(key, "x", "A/B UUID")
        candidate = {
            "token": token, "name": name, "recordCount": 1,
            "sourceCount": 1, "hasPhoto": True,
            "cards": [{"token": exact_token, "accountNumber": 1,
                       "sourceName": "iCloud", "hasPhoto": True}],
        }
        by_name = {
            name.casefold(): [{
                "name": name, "uid": "A/B UUID", "source": "x", "modified": 3, "photo": True,
            }]
        }
        completed = subprocess.CompletedProcess([], 0, "", "")
        with mock.patch.object(contacts, "read_resolve_request", return_value={
            "operation": "open", "handle": "+15550100001", "token": exact_token,
        }), mock.patch.object(
            contacts, "contact_candidates", return_value=("+15550100001", [candidate], by_name)
        ), mock.patch.object(contacts.subprocess, "run", return_value=completed) as run:
            output = io.StringIO()
            with redirect_stdout(output):
                contacts._cmd_resolve(None)
        argv = run.call_args.args[0]
        self.assertEqual(argv[0], "/usr/bin/open")
        self.assertEqual(argv[1], "addressbook://A%2FB%20UUID")
        result = json.loads(output.getvalue())
        self.assertEqual(result["opened"], True)
        self.assertEqual(result["cardNumber"], 1)
        self.assertEqual(result["cardCount"], 1)
        self.assertEqual(result["accountNumber"], 1)
        self.assertEqual(result["sourceName"], "iCloud")

    def test_open_rejects_an_unknown_card_token_without_launching_contacts(self):
        candidate = {
            "token": contacts.resolve_token("5550100001", "Alex"),
            "name": "Alex", "recordCount": 1, "sourceCount": 1, "hasPhoto": False,
            "cards": [{
                "token": contacts.card_token("5550100001", "x", "uid"),
                "accountNumber": 1, "sourceName": "iCloud", "hasPhoto": False,
            }],
        }
        with mock.patch.object(contacts, "read_resolve_request", return_value={
            "operation": "open", "handle": "+15550100001", "token": "sha256:" + "f" * 64,
        }), mock.patch.object(
            contacts, "contact_candidates", return_value=("+15550100001", [candidate], {
                "alex": [{"name": "Alex", "uid": "uid", "source": "x", "modified": 0, "photo": False}]
            })
        ), mock.patch.object(contacts.subprocess, "run") as run:
            with self.assertRaisesRegex(ValueError, "no longer a candidate"):
                contacts._cmd_resolve(None)
        run.assert_not_called()

    def test_discard_unsaved_requires_gate_and_reports_only_confirmation(self):
        with mock.patch.object(
            contacts, "read_resolve_request",
            return_value={"operation": "discard-unsaved"},
        ), mock.patch.object(contacts, "require_write_gate") as gate, mock.patch.object(
            contacts, "run_contact_repair",
            return_value={"ok": True, "discarded": True},
        ) as repair:
            output = io.StringIO()
            with redirect_stdout(output):
                contacts._cmd_resolve(None)
        gate.assert_called_once_with()
        repair.assert_called_once_with({"operation": "discard-unsaved"})
        self.assertEqual(json.loads(output.getvalue()), {"ok": True, "discarded": True})

    def test_write_gate_requires_an_owner_only_regular_file(self):
        with tempfile.TemporaryDirectory() as root, mock.patch.object(
            contacts, "WRITE_GATE", os.path.join(root, "gate")
        ):
            self.assertFalse(contacts.write_gate_enabled())
            with open(contacts.WRITE_GATE, "wb") as stream:
                stream.write(b"enabled-v1\n")
            os.chmod(contacts.WRITE_GATE, 0o600)
            self.assertTrue(contacts.write_gate_enabled())
            os.chmod(contacts.WRITE_GATE, 0o644)
            self.assertFalse(contacts.write_gate_enabled())
            os.unlink(contacts.WRITE_GATE)
            os.symlink(__file__, contacts.WRITE_GATE)
            self.assertFalse(contacts.write_gate_enabled())

    def test_undo_receipt_is_private_bounded_and_token_pinned(self):
        receipt = {
            "personUid": "person-1", "key": "5550100001", "kind": "phone",
            "fields": [{"id": "field-1", "value": "+15550100001", "label": "mobile"}],
            "name": "Alex Rivera", "handle": "+15550100001", "source": "source-1",
            "cardToken": "sha256:" + "a" * 64,
        }
        with tempfile.TemporaryDirectory() as root, mock.patch.object(
            contacts, "UNDO_DIR", os.path.join(root, "undo")
        ):
            token = contacts.write_undo_receipt(receipt)
            self.assertRegex(token, r"^undo:[0-9a-f]{32}$")
            self.assertEqual(contacts.read_undo_receipt(token)["personUid"], "person-1")
            self.assertEqual(os.stat(contacts.UNDO_DIR).st_mode & 0o777, 0o700)
            self.assertEqual(os.stat(os.path.join(contacts.UNDO_DIR, contacts.UNDO_FILE)).st_mode & 0o777, 0o600)
            with self.assertRaisesRegex(ValueError, "no longer available"):
                contacts.read_undo_receipt("undo:" + "f" * 32)
            contacts.clear_undo_receipt(token)
            self.assertFalse(os.path.exists(os.path.join(contacts.UNDO_DIR, contacts.UNDO_FILE)))

    def test_automation_output_cap_kills_a_producer_before_timeout(self):
        started = time.monotonic()
        producer = (
            "import os,time;"
            f"os.write(1,b'x'*{contacts.MAX_REPAIR_PROCESS_BYTES + 1});"
            "time.sleep(10)"
        )
        with self.assertRaisesRegex(RuntimeError, "too much data"):
            contacts.run_bounded_process([sys.executable, "-c", producer], b"{}")
        self.assertLess(time.monotonic() - started, 2)

    def test_comparison_validates_details_and_keeps_raw_ids_private(self):
        key = "5550100001"
        candidate = {
            "token": contacts.resolve_token(key, "Alex Rivera"),
            "name": "Alex Rivera", "recordCount": 2, "sourceCount": 2,
            "hasPhoto": True,
            "cards": [
                {"token": "sha256:" + "b" * 64, "accountNumber": 1,
                 "sourceName": "iCloud", "hasPhoto": True},
                {"token": "sha256:" + "c" * 64, "accountNumber": 2,
                 "sourceName": "Google", "hasPhoto": False},
            ],
        }
        records = [
            {"uid": "private-person-one", "source": "source-one", "photo": True},
            {"uid": "private-person-two", "source": "source-two", "photo": False},
        ]
        detail = {
            "displayName": "Alex Rivera", "firstName": "Alex", "middleName": "",
            "lastName": "Rivera", "nickname": "", "organization": "Example",
            "department": "", "jobTitle": "", "birthday": "--09-02", "note": "",
            "phones": [{"label": "mobile", "value": "+1 555 010 0001"}],
            "emails": [], "urls": [], "addresses": [],
        }
        with mock.patch.object(
            contacts, "selected_candidate",
            return_value=("+15550100001", key, candidate, records),
        ), mock.patch.object(
            contacts, "run_contact_repair", return_value={"ok": True, "cards": [detail, detail]},
        ), mock.patch.object(
            contacts, "native_collection_counts",
            side_effect=lambda uids: {uid: (1, 0, 0, 0) for uid in uids},
        ), mock.patch.object(contacts, "write_gate_enabled", return_value=True):
            result = contacts.compare_candidate("+15550100001", candidate["token"])
        self.assertEqual(result["cardCount"], 2)
        self.assertEqual(result["sourceCount"], 2)
        self.assertEqual(result["cards"][0]["accountNumber"], 1)
        self.assertEqual(result["cards"][0]["sourceName"], "iCloud")
        self.assertRegex(result["cards"][0]["token"], r"^sha256:[0-9a-f]{64}$")
        self.assertRegex(result["cards"][0]["revision"], r"^sha256:[0-9a-f]{64}$")
        serialized = json.dumps(result)
        self.assertNotIn("private-person-one", serialized)
        self.assertNotIn("private-person-two", serialized)
        self.assertNotIn("source-one", serialized)

        hostile = dict(detail)
        hostile["phones"] = [{"label": "x", "value": "1"}] * 17
        with self.assertRaisesRegex(RuntimeError, "phone list"):
            contacts.validated_card_detail(hostile)

    def test_link_helper_uses_fixed_argv_and_refuses_unsafe_card_ids(self):
        records = [{"uid": "person-1"}, {"uid": "person_2"}]
        completed = (0, b'{"ok":true,"ready":true,"action":"Link Selected Cards"}', b"")
        with mock.patch.object(
            contacts, "run_bounded_process", return_value=completed,
        ) as run:
            result = contacts.run_contact_link("prepare", records)
        argv, payload = run.call_args.args
        self.assertEqual(argv[0], "/usr/bin/osascript")
        self.assertTrue(argv[1].endswith("contact-link.applescript"))
        self.assertEqual(argv[2:], ["prepare", "person-1", "person_2"])
        self.assertEqual(payload, b"")
        self.assertTrue(result["ready"])

        with mock.patch.object(contacts, "run_bounded_process") as run:
            with self.assertRaisesRegex(RuntimeError, "unsafe card identifier"):
                contacts.run_contact_link("prepare", [{"uid": "safe"}, {"uid": "bad/value"}])
        run.assert_not_called()

    def test_link_apply_requires_gate_and_preserves_apple_action(self):
        candidate = {
            "name": "Alex Rivera", "sourceCount": 2,
        }
        selected = (
            "+15550100001", "5550100001", candidate,
            [{"uid": "person-1"}, {"uid": "person-2"}],
        )
        with mock.patch.object(
            contacts, "selected_candidate", return_value=selected,
        ), mock.patch.object(
            contacts, "run_contact_link",
            return_value={"ok": True, "ready": False, "action": "Merge Selected Cards"},
        ), mock.patch.object(contacts, "write_gate_enabled", return_value=True):
            preview = contacts.link_candidate("+15550100001", "sha256:" + "a" * 64, False)
        self.assertFalse(preview["ready"])
        self.assertEqual(preview["action"], "Merge Selected Cards")

        with mock.patch.object(contacts, "require_write_gate", side_effect=PermissionError("disabled")):
            with self.assertRaisesRegex(PermissionError, "disabled"):
                contacts.link_candidate(
                    "+15550100001", "sha256:" + "a" * 64, True,
                    "Merge Selected Cards",
                )

        with mock.patch.object(contacts, "require_write_gate"), mock.patch.object(
            contacts, "selected_candidate", return_value=selected,
        ), mock.patch.object(
            contacts, "run_contact_link",
            return_value={"ok": True, "linked": True, "action": "Link Selected Cards"},
        ):
            with self.assertRaisesRegex(RuntimeError, "action changed"):
                contacts.link_candidate(
                    "+15550100001", "sha256:" + "a" * 64, True,
                    "Merge Selected Cards",
                )

    def test_remove_revalidates_fields_and_saves_undo_before_automation(self):
        preview = {
            "handle": "+15550100001", "name": "Pat Rivera", "kind": "phone",
            "fieldCount": 1, "labels": ["mobile"], "cardNumber": 1,
            "cardCount": 1, "accountNumber": 1, "sourceName": "iCloud",
            "writeEnabled": True,
        }
        private = {
            "personUid": "person-1", "key": "5550100001", "kind": "phone",
            "fields": [{"id": "field-1", "value": "+15550100001", "label": "mobile"}],
            "name": "Pat Rivera", "handle": "+15550100001", "source": "source-1",
            "cardToken": "sha256:" + "a" * 64,
        }
        events = []
        with mock.patch.object(contacts, "require_write_gate"), mock.patch.object(
            contacts, "inspect_repair", return_value=(preview, private, private["fields"])
        ), mock.patch.object(
            contacts, "write_undo_receipt", side_effect=lambda value: events.append("receipt") or "undo:" + "b" * 32
        ), mock.patch.object(
            contacts, "run_contact_repair",
            side_effect=lambda value: events.append("automation") or {"ok": True, "removed": True, "fieldCount": 1},
        ):
            result = contacts.remove_from_contact(
                "+15550100001", private["cardToken"], "sha256:" + "c" * 64
            )
        self.assertEqual(events, ["receipt", "automation"])
        self.assertTrue(result["removed"])
        self.assertRegex(result["undoToken"], r"^undo:")

    def test_inspect_refuses_the_saved_correct_contact(self):
        key = "5550100001"
        correct = {
            "token": contacts.resolve_token(key, "Alex Rivera"),
            "name": "Alex Rivera", "recordCount": 1, "sourceCount": 1,
            "hasPhoto": False, "cards": [],
        }
        wrong = {
            "token": contacts.resolve_token(key, "Pat Rivera"),
            "name": "Pat Rivera", "recordCount": 1, "sourceCount": 1,
            "hasPhoto": False, "cards": [],
        }
        record = {
            "name": "Alex Rivera", "uid": "person-1", "source": "source-1",
            "kind": "phone", "modified": 0, "photo": False,
        }
        with mock.patch.object(
            contacts, "selected_card",
            return_value=("+15550100001", key, correct, record, 1, 1),
        ), mock.patch.object(
            contacts, "contact_candidates",
            return_value=("+15550100001", [correct, wrong], {}),
        ), mock.patch.object(contacts, "run_contact_repair") as repair:
            with self.assertRaisesRegex(ValueError, "selected correct contact"):
                contacts.inspect_repair(
                    "+15550100001", "sha256:" + "a" * 64, correct["token"]
                )
        repair.assert_not_called()

    def test_card_edit_requires_revision_preview_and_writes_receipt_before_apply(self):
        detail = {
            "displayName": "Alex Rivera", "firstName": "Alex", "middleName": "",
            "lastName": "Rivera", "nickname": "", "organization": "",
            "department": "", "jobTitle": "", "birthday": "", "note": "",
            "phones": [{"label": "mobile", "value": "+15550100001"}],
            "emails": [], "urls": [], "addresses": [],
        }
        draft = contacts.card_draft({**detail, "nickname": "Lex"})
        token = "sha256:" + "b" * 64
        owner = "sha256:" + "a" * 64
        candidate = {
            "name": "Alex Rivera", "recordCount": 1, "sourceCount": 1,
            "cards": [{"accountNumber": 1, "sourceName": "iCloud"}],
        }
        selected = (
            "+15550100001", "5550100001", candidate,
            [{"uid": "person-1", "source": "source-1"}],
            {"uid": "person-1", "source": "source-1"}, 1, 1,
        )
        events = []
        edited = {**detail, "nickname": "Lex"}
        with mock.patch.object(contacts, "owned_card", return_value=selected), mock.patch.object(
            contacts, "describe_records", return_value=[detail]
        ), mock.patch.object(contacts, "write_gate_enabled", return_value=True):
            preview, _ = contacts.prepare_card_edit(
                "+15550100001", owner, token, contacts.card_revision(detail), draft
            )
        self.assertEqual(preview["changedFields"], ["nickname"])
        self.assertRegex(preview["planHash"], r"^sha256:[0-9a-f]{64}$")

        with mock.patch.object(contacts, "require_write_gate"), mock.patch.object(
            contacts, "prepare_card_edit", return_value=(preview, {
                "personUid": "person-1", "before": detail, "after": draft,
                "handle": "+15550100001", "name": "Alex Rivera", "cardToken": token,
                "planHash": preview["planHash"],
            })
        ), mock.patch.object(
            contacts, "write_undo_receipt",
            side_effect=lambda value: events.append("receipt") or "undo:" + "c" * 32,
        ), mock.patch.object(
            contacts, "run_contact_repair",
            side_effect=lambda value: events.append("automation") or {
                "ok": True, "edited": True, "card": edited,
            },
        ):
            result = contacts.apply_card_edit(
                "+15550100001", owner, token, contacts.card_revision(detail), draft,
                preview["planHash"],
            )
        self.assertEqual(events, ["receipt", "automation"])
        self.assertTrue(result["applied"])

    def test_card_collection_edit_uses_native_contacts_update(self):
        before = {
            "displayName": "Alex Rivera", "firstName": "Alex", "middleName": "",
            "lastName": "Rivera", "nickname": "", "organization": "",
            "department": "", "jobTitle": "", "birthday": "", "note": "",
            "phones": [{"label": "mobile", "value": "+15550100001"}],
            "emails": [], "urls": [], "addresses": [],
        }
        draft = contacts.card_draft({
            **before, "phones": [{"label": "mobile", "value": "+15550100002"}],
        })
        after = {**before, **draft}
        plan = "sha256:" + "d" * 64
        preview = {"planHash": plan, "changedFields": ["phone numbers"]}
        private = {
            "personUid": "person-1", "before": before, "after": draft,
            "handle": "+15550100001", "name": "Alex Rivera",
            "cardToken": "sha256:" + "b" * 64, "planHash": plan,
        }
        events = []
        with mock.patch.object(contacts, "require_write_gate"), mock.patch.object(
            contacts, "prepare_card_edit", return_value=(preview, private),
        ), mock.patch.object(
            contacts, "write_undo_receipt",
            side_effect=lambda value: events.append("receipt") or "undo:" + "c" * 32,
        ), mock.patch.object(
            contacts, "run_contact_update",
            side_effect=lambda uid, card: events.append("native") or {"updated": True},
        ), mock.patch.object(contacts, "describe_records", return_value=[after]), mock.patch.object(
            contacts, "run_contact_repair",
        ) as automation:
            result = contacts.apply_card_edit(
                "+15550100001", "sha256:" + "a" * 64, "sha256:" + "b" * 64,
                contacts.card_revision(before), draft, plan,
            )
        self.assertEqual(events, ["receipt", "native"])
        automation.assert_not_called()
        self.assertTrue(result["applied"])

    def test_consolidation_plan_pins_every_card_and_keeps_raw_ids_private(self):
        base = {
            "displayName": "Alex Rivera", "firstName": "Alex", "middleName": "",
            "lastName": "Rivera", "nickname": "", "organization": "",
            "department": "", "jobTitle": "", "birthday": "", "note": "",
            "phones": [], "emails": [], "urls": [], "addresses": [],
        }
        other = {**base, "emails": [{"label": "home", "value": "alex@example.com"}]}
        key = "5550100001"
        records = [
            {"uid": "private-1", "source": "source-1"},
            {"uid": "private-2", "source": "source-2"},
        ]
        tokens = [contacts.card_token(key, record["source"], record["uid"]) for record in records]
        candidate = {
            "name": "Alex Rivera", "recordCount": 2, "sourceCount": 2,
            "cards": [{"accountNumber": 1, "sourceName": "iCloud"},
                      {"accountNumber": 2, "sourceName": "Google"}],
        }
        revisions = [
            {"token": tokens[0], "revision": contacts.card_revision(base)},
            {"token": tokens[1], "revision": contacts.card_revision(other)},
        ]
        with mock.patch.object(
            contacts, "selected_candidate",
            return_value=("+15550100001", key, candidate, records),
        ), mock.patch.object(
            contacts, "describe_records", return_value=[base, other],
        ), mock.patch.object(contacts, "write_gate_enabled", return_value=True):
            preview, private = contacts.prepare_consolidation(
                "+15550100001", "sha256:" + "a" * 64, tokens[0], revisions,
                contacts.card_draft(other),
            )
        self.assertEqual(preview["action"], "consolidate")
        self.assertEqual(preview["sourceCardCount"], 1)
        self.assertNotIn("private-1", json.dumps(preview))
        self.assertEqual(private["targetUid"], "private-1")

        changed = [dict(item) for item in revisions]
        changed[1]["revision"] = "sha256:" + "f" * 64
        with mock.patch.object(
            contacts, "selected_candidate",
            return_value=("+15550100001", key, candidate, records),
        ), mock.patch.object(contacts, "describe_records", return_value=[base, other]):
            with self.assertRaisesRegex(ValueError, "source card changed"):
                contacts.prepare_consolidation(
                    "+15550100001", "sha256:" + "a" * 64, tokens[0], changed,
                    contacts.card_draft(other),
                )

    def test_consolidation_preflights_then_updates_and_deletes(self):
        before = {
            "displayName": "Alex Rivera", "firstName": "Alex", "middleName": "",
            "lastName": "Rivera", "nickname": "", "organization": "",
            "department": "", "jobTitle": "", "birthday": "", "note": "",
            "phones": [], "emails": [], "urls": [], "addresses": [],
        }
        draft = contacts.card_draft({
            **before, "emails": [{"label": "home", "value": "alex@example.com"}],
        })
        after = {**before, **draft}
        plan = "sha256:" + "d" * 64
        preview = {
            "action": "consolidate", "handle": "+15550100001", "name": "Alex Rivera",
            "cardNumber": 1, "cardCount": 2, "accountNumber": 1, "sourceName": "iCloud",
            "sourceCardCount": 1, "changedFields": ["email addresses"],
            "planHash": plan, "writeEnabled": True,
        }
        private = {
            "targetUid": "person-1", "targetBefore": before, "targetAfter": draft,
            "sources": [{"personUid": "person-2", "card": before}],
            "handle": "+15550100001", "name": "Alex Rivera", "planHash": plan,
        }
        events = []
        with mock.patch.object(contacts, "require_write_gate"), mock.patch.object(
            contacts, "prepare_consolidation", return_value=(preview, private),
        ), mock.patch.object(
            contacts, "describe_records", return_value=[after],
        ), mock.patch.object(
            contacts, "write_undo_receipt",
            side_effect=lambda value: events.append("receipt") or "undo:" + "e" * 32,
        ), mock.patch.object(
            contacts, "run_contact_repair",
            side_effect=lambda value: events.append(value["operation"]) or {
                "ok": True, "readyToConsolidate": True, "sourceCount": 1,
            },
        ), mock.patch.object(
            contacts, "run_contact_consolidation",
            side_effect=lambda target, sources, card: events.append("native") or {
                "ok": True, "updated": True, "deletedCount": len(sources),
            },
        ) as consolidate:
            result = contacts.apply_consolidation(
                "+15550100001", "sha256:" + "a" * 64, "sha256:" + "b" * 64,
                [], draft, plan,
            )
        self.assertEqual(events, ["consolidate", "receipt", "native"])
        consolidate.assert_called_once_with("person-1", ["person-2"], draft)
        self.assertTrue(result["applied"])

    def test_consolidation_never_deletes_a_source_when_survivor_save_fails(self):
        before = {
            "displayName": "Alex Rivera", "firstName": "Alex", "middleName": "",
            "lastName": "Rivera", "nickname": "", "organization": "",
            "department": "", "jobTitle": "", "birthday": "", "note": "",
            "phones": [], "emails": [], "urls": [], "addresses": [],
        }
        draft = contacts.card_draft(before)
        plan = "sha256:" + "d" * 64
        preview = {
            "action": "consolidate", "handle": "+15550100001", "name": "Alex Rivera",
            "cardNumber": 1, "cardCount": 2, "accountNumber": 1, "sourceName": "iCloud",
            "sourceCardCount": 1, "changedFields": ["source-card consolidation"],
            "planHash": plan, "writeEnabled": True,
        }
        private = {
            "targetUid": "person-1", "targetBefore": before, "targetAfter": draft,
            "sources": [{"personUid": "person-2", "card": before}],
            "handle": "+15550100001", "name": "Alex Rivera", "planHash": plan,
        }
        with mock.patch.object(contacts, "require_write_gate"), mock.patch.object(
            contacts, "prepare_consolidation", return_value=(preview, private),
        ), mock.patch.object(
            contacts, "write_undo_receipt", return_value="undo:" + "e" * 32,
        ), mock.patch.object(
            contacts, "run_contact_repair",
            return_value={"ok": True, "readyToConsolidate": True, "sourceCount": 1},
        ), mock.patch.object(
            contacts, "run_contact_consolidation", side_effect=RuntimeError("native save failed"),
        ), mock.patch.object(contacts, "run_contact_delete") as delete:
            with self.assertRaisesRegex(RuntimeError, "native save failed"):
                contacts.apply_consolidation(
                    "+15550100001", "sha256:" + "a" * 64, "sha256:" + "b" * 64,
                    [], draft, plan,
                )
        delete.assert_not_called()



class CrossNameMergeTests(unittest.TestCase):
    def fake_candidates(self):
        gray = {"token": "sha256:" + "a" * 64, "name": "Julia Gray", "recordCount": 1,
                "sourceCount": 1, "hasPhoto": True,
                "cards": [{"token": "sha256:" + "1" * 64, "accountNumber": 1,
                           "sourceName": "iCloud", "hasPhoto": True, "matchCount": 1}]}
        kinney = {"token": "sha256:" + "b" * 64, "name": "Julia Kinney", "recordCount": 1,
                  "sourceCount": 1, "hasPhoto": True,
                  "cards": [{"token": "sha256:" + "2" * 64, "accountNumber": 1,
                             "sourceName": "Gmail", "hasPhoto": True, "matchCount": 1}]}
        by_name = {
            "julia gray": [{"uid": "uid-gray", "source": "s-icloud", "photo": True,
                            "modified": 2, "name": "Julia Gray"}],
            "julia kinney": [{"uid": "uid-kinney", "source": "s-gmail", "photo": True,
                              "modified": 1, "name": "Julia Kinney"}],
        }
        return ("+15550100001", [gray, kinney], by_name)

    def test_pair_combines_both_people_in_global_account_order(self):
        # the union follows the same largest-store-first account order as
        # every other view — NOT selected-person-first
        stores = ["/AB/Sources/s-gmail/AddressBook-v22.abcddb",
                  "/AB/Sources/s-icloud/AddressBook-v22.abcddb"]
        with mock.patch.object(contacts, "contact_candidates", return_value=self.fake_candidates()), \
             mock.patch.object(contacts, "bounded_source_dbs", return_value=stores), \
             mock.patch.object(contacts, "normalize_resolve_handle",
                               return_value=("+15550100001", "5550100001", False)):
            _, _, combined, records = contacts.selected_candidate_pair(
                "+15550100001", "sha256:" + "a" * 64, "sha256:" + "b" * 64)
        self.assertEqual(combined["recordCount"], 2)
        self.assertEqual(combined["sourceCount"], 2)
        # gmail (the bigger store) leads even though iCloud's person was selected
        self.assertEqual([r["uid"] for r in records], ["uid-kinney", "uid-gray"])
        self.assertEqual([c["sourceName"] for c in combined["cards"]], ["Gmail", "iCloud"])
        self.assertEqual([c["accountNumber"] for c in combined["cards"]], [1, 2])

    def test_pair_requires_two_distinct_candidates(self):
        with mock.patch.object(contacts, "contact_candidates", return_value=self.fake_candidates()), \
             mock.patch.object(contacts, "normalize_resolve_handle",
                               return_value=("+15550100001", "5550100001", False)):
            with self.assertRaises(ValueError):
                contacts.selected_candidate_pair(
                    "+15550100001", "sha256:" + "a" * 64, "sha256:" + "a" * 64)


class SourceOrderTests(unittest.TestCase):
    def test_sources_order_largest_account_first(self):
        # the biggest store is always card 1, so compare/merge order is stable
        counts = {
            "/AB/Sources/aaa/AddressBook-v22.abcddb": 5,
            "/AB/Sources/bbb/AddressBook-v22.abcddb": 500,
            "/AB/Sources/ccc/AddressBook-v22.abcddb": 500,
        }
        def fake_open(path):
            connection = mock.MagicMock()
            connection.__enter__.return_value = connection
            connection.__exit__.return_value = False
            connection.execute.return_value.fetchone.return_value = (counts[path],)
            return connection
        with mock.patch.object(contacts, "glob", return_value=sorted(counts)), mock.patch.object(
            contacts.os.path, "exists", return_value=False,
        ), mock.patch.object(contacts, "open_db", side_effect=fake_open):
            ordered = contacts.source_dbs()
        self.assertEqual(ordered, [
            "/AB/Sources/bbb/AddressBook-v22.abcddb",
            "/AB/Sources/ccc/AddressBook-v22.abcddb",
            "/AB/Sources/aaa/AddressBook-v22.abcddb",
        ])


class CardContentComparisonTests(unittest.TestCase):
    DETAIL = {
        "displayName": "Alex Rivera", "firstName": "Alex", "middleName": "",
        "lastName": "Rivera", "nickname": "", "organization": "Example",
        "department": "", "jobTitle": "", "birthday": "--09-02", "note": "",
        "phones": [{"label": "mobile", "value": "+1 555 010 0001"}],
        "emails": [{"label": "Email", "value": "a@example.invalid"},
                   {"label": "Email", "value": "b@example.invalid"}],
        "urls": [], "addresses": [],
    }

    def test_collection_order_never_fails_verification(self):
        # the writer reuses existing rows and appends additions, so a merged
        # card can read back with the same values in a different sequence
        draft = contacts.card_draft(self.DETAIL)
        reordered = dict(draft, emails=list(reversed(draft["emails"])))
        self.assertTrue(contacts.same_card_content(reordered, draft))

    def test_changed_values_still_fail_verification(self):
        draft = contacts.card_draft(self.DETAIL)
        changed = dict(draft, emails=[{"label": "Email", "value": "c@example.invalid"},
                                      {"label": "Email", "value": "b@example.invalid"}])
        self.assertFalse(contacts.same_card_content(changed, draft))
        renamed = dict(draft, organization="Someone Else")
        self.assertFalse(contacts.same_card_content(renamed, draft))


class ConsolidationRecoveryTests(unittest.TestCase):
    DETAIL = {
        "displayName": "Alex Rivera", "firstName": "Alex", "middleName": "",
        "lastName": "Rivera", "nickname": "", "organization": "Example",
        "department": "", "jobTitle": "", "birthday": "--09-02", "note": "",
        "phones": [{"label": "mobile", "value": "+1 555 010 0001"}],
        "emails": [], "urls": [], "addresses": [],
    }

    def private(self):
        after = dict(contacts.card_draft(self.DETAIL), organization="Merged Org")
        return {
            "targetUid": "uid-target", "targetAfter": after,
            "sources": [{"personUid": "uid-source"}],
        }

    def test_native_failures_carry_their_stage(self):
        completed = (1, b'{"ok":false,"error":"boom","stage":"update survivor"}', b"")
        file_info = os.stat_result((stat.S_IFREG | 0o700, 0, 0, 1, os.getuid(), 0, 1, 0, 0, 0))
        with mock.patch.object(contacts.os, "lstat", return_value=file_info), mock.patch.object(
            contacts, "run_bounded_process", return_value=completed,
        ):
            with self.assertRaises(contacts.NativeMutationError) as caught:
                contacts.run_native_contact_mutation({"operation": "consolidate"})
        self.assertEqual(caught.exception.stage, "update survivor")

    def test_survivor_fault_recovers_through_contacts_app_edit(self):
        private = self.private()
        error = contacts.NativeMutationError("boom", "update survivor")
        with mock.patch.object(
            contacts, "describe_records", return_value=[self.DETAIL],
        ), mock.patch.object(
            contacts, "run_contact_repair", return_value={"ok": True, "edited": True},
        ) as repair, mock.patch.object(contacts, "run_contact_delete") as delete:
            contacts.recover_consolidation_via_contacts_app(private, error)
        self.assertEqual(repair.call_args.args[0]["operation"], "edit")
        self.assertEqual(repair.call_args.args[0]["card"], private["targetAfter"])
        delete.assert_called_once_with(["uid-source"])

    def test_delete_fault_falls_back_to_contacts_app_deletion(self):
        private = self.private()
        error = contacts.NativeMutationError("boom", "delete sources")
        with mock.patch.object(
            contacts, "run_contact_delete", side_effect=RuntimeError("still faulting"),
        ), mock.patch.object(
            contacts, "run_contact_repair",
            return_value={"ok": True, "deletedCount": 1},
        ) as repair:
            contacts.recover_consolidation_via_contacts_app(private, error)
        self.assertEqual(repair.call_args.args[0]["operation"], "delete-fallback")
        self.assertEqual(repair.call_args.args[0]["personUids"], ["uid-source"])

    def test_unknown_stage_is_never_recovered(self):
        error = contacts.NativeMutationError("boom", "")
        with self.assertRaises(contacts.NativeMutationError):
            contacts.recover_consolidation_via_contacts_app(self.private(), error)


class StaleDescribeGuardTests(unittest.TestCase):
    DETAIL = {
        "displayName": "Alex Rivera", "firstName": "Alex", "middleName": "",
        "lastName": "Rivera", "nickname": "", "organization": "", "department": "",
        "jobTitle": "", "birthday": "", "note": "",
        "phones": [{"label": "mobile", "value": "+1 555 010 0001"}],
        "emails": [], "urls": [], "addresses": [],
    }

    def test_stale_app_view_retries_until_counts_agree(self):
        # first describe returns a stale empty-collection view; the retry sees
        # the real card
        stale = dict(self.DETAIL, phones=[])
        with mock.patch.object(
            contacts, "native_collection_counts", return_value={"uid-1": (1, 0, 0, 0)},
        ), mock.patch.object(
            contacts, "run_contact_repair",
            side_effect=[{"ok": True, "cards": [stale]}, {"ok": True, "cards": [self.DETAIL]}],
        ) as described, mock.patch.object(contacts.time, "sleep"):
            details = contacts.describe_records([{"uid": "uid-1"}])
        self.assertEqual(len(details[0]["phones"]), 1)
        self.assertEqual(described.call_count, 2)

    def test_persistently_stale_view_fails_honestly(self):
        stale = dict(self.DETAIL, phones=[])
        with mock.patch.object(
            contacts, "native_collection_counts", return_value={"uid-1": (1, 0, 0, 0)},
        ), mock.patch.object(
            contacts, "run_contact_repair", return_value={"ok": True, "cards": [stale]},
        ), mock.patch.object(contacts.time, "sleep"):
            with self.assertRaises(RuntimeError) as caught:
                contacts.describe_records([{"uid": "uid-1"}])
        self.assertIn("stale card data", str(caught.exception))


class SettledReadbackTests(unittest.TestCase):
    DETAIL = {
        "displayName": "Alex Rivera", "firstName": "Alex", "middleName": "",
        "lastName": "Rivera", "nickname": "", "organization": "Example",
        "department": "", "jobTitle": "", "birthday": "--09-02", "note": "",
        "phones": [{"label": "mobile", "value": "+1 555 010 0001"}],
        "emails": [], "urls": [], "addresses": [],
    }

    def test_readback_polls_past_contacts_stale_view(self):
        # Saves go through CNContactStore; describe goes through Contacts.app,
        # whose view refreshes asynchronously. The first read returns the
        # pre-save card, the second the saved one — no error, no false
        # "Contacts changed the card" report.
        stale = dict(self.DETAIL, organization="Old Org")
        draft = contacts.card_draft(self.DETAIL)
        with mock.patch.object(
            contacts, "describe_records", side_effect=[[stale], [self.DETAIL]],
        ) as described, mock.patch.object(contacts.time, "sleep") as slept:
            result = contacts.settled_card_detail("uid-one", draft)
        self.assertEqual(contacts.card_draft(result), draft)
        self.assertEqual(described.call_count, 2)
        slept.assert_called_once()

    def test_readback_returns_last_view_when_the_card_really_changed(self):
        changed = dict(self.DETAIL, organization="Someone Else Edited")
        draft = contacts.card_draft(self.DETAIL)
        with mock.patch.object(
            contacts, "describe_records", return_value=[changed],
        ) as described, mock.patch.object(contacts.time, "sleep"):
            result = contacts.settled_card_detail("uid-one", draft)
        self.assertNotEqual(contacts.card_draft(result), draft)
        self.assertEqual(described.call_count, 10)

    def test_readback_tolerates_transient_describe_failures(self):
        draft = contacts.card_draft(self.DETAIL)
        with mock.patch.object(
            contacts, "describe_records",
            side_effect=[RuntimeError("app view lagging"), [self.DETAIL]],
        ), mock.patch.object(contacts.time, "sleep"):
            result = contacts.settled_card_detail("uid-one", draft)
        self.assertEqual(contacts.card_draft(result), draft)


if __name__ == "__main__":
    unittest.main()
