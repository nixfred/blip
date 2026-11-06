import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8");
const widget = readFileSync(new URL("./BarWidget.qml", import.meta.url), "utf8");
// Exercise the actual documented shell command and QML launch command, including
// their different quoting layers. Every external action is intercepted below.
const shortcut = readme.split('"Blip messages", [[')[1].split("]])")[0];
const showApp = widget.split("function showApp() {")[1].split("\n  }")[0];
const args = showApp.split("Quickshell.execDetached(")[1].trim().slice(0, -1);
const launch = runInNewContext(args) as string[];

const impostors = [
  { class: "chromium", title: "Messages", address: "0x10" },
  { class: "org.quickshell", title: "Messages documentation", address: "0x15" },
  { class: "codex", title: "Blip plugin missing", address: "0x11" },
  { class: "chromium", title: "Blip", address: "0x12" },
  { class: "org.quickshell", title: "Blip documentation", address: "0x13" },
  { class: "org.quickshell", title: "Blip (3) documentation", address: "0x14" },
];

function run(command: string[], title: string | null, focused: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "blip-launch-"));
  try {
    const client = { class: "org.quickshell", title, address: "0x20" };
    writeFileSync(join(dir, "clients.json"), JSON.stringify([...impostors, ...(title ? [client] : [])]));
    writeFileSync(join(dir, "active.json"), JSON.stringify(focused ? client : impostors[0]));
    writeFileSync(join(dir, "hyprctl"), `#!/bin/sh
case "$1" in
  clients) cat "$FIXTURE/clients.json" ;;
  activewindow) cat "$FIXTURE/active.json" ;;
  dispatch) printf '%s\\n' "$2" >> "$FIXTURE/actions" ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
    writeFileSync(join(dir, "omarchy-shell"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FIXTURE/actions"\n', { mode: 0o755 });
    writeFileSync(join(dir, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(dir, "actions"), "");
    const result = Bun.spawnSync(command, {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FIXTURE: dir },
    });
    expect(result.stderr.toString()).toBe("");
    return readFileSync(join(dir, "actions"), "utf8").trim().split("\n").filter(Boolean);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("Blip window launch identity", () => {
  for (const title of ["Messages", "Blip", "Blip (3)"]) {
    test(`shortcut focuses ${title}, not an earlier title match`, () => {
      expect(run(["sh", "-c", shortcut], title, false)).toEqual([
        'hl.dsp.focus({ window = "address:0x20" })',
      ]);
    });
    test(`shortcut still closes the focused ${title} window`, () => {
      expect(run(["sh", "-c", shortcut], title, true)).toEqual([
        'hl.dsp.window.close({ window = "address:0x20" })',
      ]);
    });
    test(`app IPC focuses ${title}, not an earlier title match`, () => {
      expect(run(launch, title, false)).toEqual([
        'hl.dsp.focus({ window = "address:0x20" })',
      ]);
    });
  }
  test("shortcut requests the app when only unrelated windows exist", () => {
    expect(run(["sh", "-c", shortcut], null, false)).toEqual(["nixfred.blip app"]);
  });
  test("app IPC never focuses an unrelated window if Blip does not map", () => {
    expect(run(launch, null, false)).toEqual([]);
  });
});
