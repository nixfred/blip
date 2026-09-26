#!/usr/bin/env python3
"""Classify a change as a one-way or two-way door (rule G2).

The result is a floor: an agent may raise a two-way change to one-way, never lower it.
Rules live in .claude/door-rules.yml (path globs + regexes matched against added lines).
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (
    base_ref,
    collect_changes,
    glob_to_regex,
    load_simple_yaml,
    parse_unified_diff,
    repo_root,
)

DEFAULT_RULES = ".claude/door-rules.yml"


def load_rules(path: Path) -> dict[str, list[str]]:
    data = load_simple_yaml(path.read_text(encoding="utf-8"))
    rules: dict[str, list[str]] = {}
    for key in ("one_way", "content_patterns", "ignore", "content_ignore"):
        value = data.get(key) or []
        if not isinstance(value, list):  # list("x/**") would silently become one-character globs
            raise SystemExit(f"{path}: {key} must be a list of '- item' lines, got {value!r}")
        rules[key] = value
    if data.get("default", "two_way") not in ("two_way", "one_way"):
        raise SystemExit(f"{path}: default must be two_way or one_way")
    rules["default"] = [str(data.get("default", "two_way"))]
    return rules


def classify(changes, rules) -> dict[str, object]:
    path_rules = [(glob, glob_to_regex(glob)) for glob in rules["one_way"]]
    ignore = [glob_to_regex(glob) for glob in rules["ignore"]]
    content_ignore = [glob_to_regex(glob) for glob in rules["content_ignore"]]
    content = [(pattern, re.compile(pattern)) for pattern in rules["content_patterns"]]
    reasons: list[str] = []
    for change in changes.values():
        paths = {p for p in (change.path, change.old_path) if p}
        if any(rx.match(p) for p in paths for rx in ignore):
            continue
        for glob, rx in path_rules:
            hit = next((p for p in sorted(paths) if rx.match(p)), None)
            if hit:
                verb = "deletes" if change.deleted else "touches"
                reasons.append(f"{verb} {hit} (path rule {glob!r})")
        if any(rx.match(change.path) for rx in content_ignore):
            continue
        for lineno, text in sorted(change.added.items()):
            for pattern, rx in content:
                if rx.search(text):
                    reasons.append(f"{change.path}:{lineno} adds {text.strip()[:80]!r} (content rule {pattern!r})")
    door = "one-way" if reasons or rules["default"][0] == "one_way" else "two-way"
    if not reasons and door == "one-way":
        reasons.append("repo default is one_way")
    return {"door": door, "reasons": reasons, "files": len(changes)}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", help="base ref (default: SLOPBRAKE_BASE, CI base, main/master)")
    parser.add_argument("--rules", help=f"rules file (default: {DEFAULT_RULES})")
    parser.add_argument("--diff-file", help="classify this unified diff instead of git")
    parser.add_argument("--working-tree", action="store_true", help="include uncommitted and untracked changes")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    rules_path = Path(args.rules) if args.rules else repo_root() / DEFAULT_RULES
    rules = load_rules(rules_path)
    if args.diff_file:
        changes = parse_unified_diff(Path(args.diff_file).read_text(encoding="utf-8"))
        base = None
    else:
        base = base_ref(args.base)
        if base is None:
            raise SystemExit("door-classify: no base ref found; pass --base")
        changes = collect_changes(base, working_tree=args.working_tree)
    result = classify(changes, rules) | {"base": base}
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"door: {result['door']}")
        for reason in result["reasons"]:
            print(f"  - {reason}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
