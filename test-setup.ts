// Tests must never touch the developer's real caches: point XDG_CACHE_HOME at
// a scratch dir before any module computes CACHE_DIR / AVATAR_DIR.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "blip-test-cache-"));

// Labels are rendered in LOCAL time from UTC wire stamps, so an unpinned TZ
// would make every clock/day assertion depend on where the test ran. Pin it;
// the tests that are ABOUT the conversion set their own zone explicitly.
process.env.TZ ||= "UTC";
