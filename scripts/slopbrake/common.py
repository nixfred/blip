"""Shared helpers for Slopbrake's checks: git base discovery, diff parsing, globs.

Standard library only, so every check runs in CI without an install step.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path


def git(*args: str, cwd: Path | None = None, check: bool = True) -> str:
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=False)
    if check and result.returncode != 0:
        raise SystemExit(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout


def repo_root() -> Path:
    return Path(git("rev-parse", "--show-toplevel").strip())


def _ref_exists(ref: str) -> bool:
    return subprocess.run(["git", "rev-parse", "--verify", "-q", ref + "^{commit}"],
                          capture_output=True, check=False).returncode == 0


def base_ref(explicit: str | None = None) -> str | None:
    """The ref a change is measured against: flag, env, CI base, then main/master."""
    for ref in (explicit, os.environ.get("SLOPBRAKE_BASE")):
        if ref:
            return ref
    if os.environ.get("GITHUB_BASE_REF"):
        return "origin/" + os.environ["GITHUB_BASE_REF"]
    for ref in ("origin/HEAD", "main", "master", "origin/main", "origin/master"):
        if _ref_exists(ref):
            return ref
    return None


@dataclass
class FileChange:
    path: str
    old_path: str | None = None
    deleted: bool = False
    added: dict[int, str] = field(default_factory=dict)  # new line number -> text


def parse_unified_diff(text: str) -> dict[str, FileChange]:
    """Parse `git diff --unified=0` output into per-file added lines."""
    changes: dict[str, FileChange] = {}
    current: FileChange | None = None
    new_line = 0
    for line in text.splitlines():
        if line.startswith("diff --git "):
            match = re.match(r'diff --git "?a/(.+?)"? "?b/(.+?)"?$', line)
            old, new = (match.group(1), match.group(2)) if match else (None, None)
            current = FileChange(path=new or "", old_path=old)
            changes[current.path] = current
        elif current is None:
            continue
        elif line.startswith("deleted file mode"):
            current.deleted = True
        elif line.startswith("@@"):
            match = re.match(r"@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@", line)
            new_line = int(match.group(1)) if match else 0
        elif line.startswith("+") and not line.startswith("+++"):
            current.added[new_line] = line[1:]
            new_line += 1
    return changes


def untracked_files() -> list[str]:
    out = git("ls-files", "--others", "--exclude-standard", "-z")
    return [p for p in out.split("\0") if p]


def collect_changes(base: str | None, working_tree: bool) -> dict[str, FileChange]:
    """Changes since the merge-base with `base`.

    working_tree=False: committed changes only (merge-base...HEAD), the PR view.
    working_tree=True: also uncommitted and untracked files, the local-gate view.
    """
    if base is None:
        return {}
    merge_base = git("merge-base", base, "HEAD").strip()
    args = ["diff", "--no-color", "--no-ext-diff", "--unified=0", "--find-renames",
            "--src-prefix=a/", "--dst-prefix=b/", merge_base]
    if not working_tree:
        args.append("HEAD")
    changes = parse_unified_diff(git(*args))
    if working_tree:
        root = repo_root()
        for path in untracked_files():
            try:
                lines = (root / path).read_text(encoding="utf-8").splitlines()
            except (UnicodeDecodeError, OSError):
                lines = []
            changes[path] = FileChange(path=path, added={i + 1: t for i, t in enumerate(lines)})
    return changes


def glob_to_regex(pattern: str) -> re.Pattern[str]:
    """Gitignore-style glob: `**/` spans zero or more directories, `*` stays in one."""
    out, i = "", 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out += "(?:.*/)?"
            i += 3
        elif pattern.startswith("/**", i) and i + 3 == len(pattern):
            out += "(?:/.*)?"
            i += 3
        elif pattern.startswith("**", i):
            out += ".*"
            i += 2
        elif pattern[i] == "*":
            out += "[^/]*"
            i += 1
        elif pattern[i] == "?":
            out += "[^/]"
            i += 1
        else:
            out += re.escape(pattern[i])
            i += 1
    return re.compile("^" + out + "$")


def load_simple_yaml(text: str) -> dict[str, object]:
    """Parse the YAML subset the rule files use: `key: scalar` and `key:` + `- item` lists.

    Kept dependency-free so CI needs no PyYAML. Double-quoted scalars use JSON escapes.
    """
    data: dict[str, object] = {}
    key: str | None = None
    for raw in text.splitlines():
        line = _strip_comment(raw).rstrip()
        if not line.strip():
            continue
        if not line.startswith((" ", "\t", "-")):
            name, _, value = line.partition(":")
            key = name.strip()
            data[key] = _scalar(value.strip()) if value.strip() else []
        elif line.strip().startswith("- ") and key is not None:
            items = data.setdefault(key, [])
            if not isinstance(items, list):
                raise ValueError(f"key {key!r} mixes a scalar and a list")
            items.append(_scalar(line.strip()[2:].strip()))
        else:
            raise ValueError(f"unsupported YAML line: {raw!r}")
    return data


def _strip_comment(line: str) -> str:
    quote, i = None, 0
    while i < len(line):
        char = line[i]
        if quote == '"' and char == "\\":
            i += 2  # skip the escaped character
            continue
        if quote:
            if char == quote:
                quote = None
        elif char in "\"'":
            quote = char
        elif char == "#" and (i == 0 or line[i - 1].isspace()):
            return line[:i]
        i += 1
    return line


def _scalar(value: str) -> str:
    if value.startswith('"') and value.endswith('"'):
        return json.loads(value)
    if value.startswith("'") and value.endswith("'"):
        return value[1:-1].replace("''", "'")
    return value
