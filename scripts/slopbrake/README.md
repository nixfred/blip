# Door classifier (vendored from Slopbrake)

`door_classify.py` and `common.py` are copied unmodified from
https://github.com/GreyforgeLabs/slopbrake (`slopbrake/kit/common/scripts/slopbrake/`, MIT, see LICENSE).
Standard-library Python; the only subprocess it runs is `git`.

Run it before merging a PR:

    python3 scripts/slopbrake/door_classify.py --base main

`one-way` means a human reads the diff before merge. The rules for blip live in `.claude/door-rules.yml`.
A PR may be raised to one-way by hand, never lowered.
