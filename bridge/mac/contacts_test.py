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


if __name__ == "__main__":
    unittest.main()
