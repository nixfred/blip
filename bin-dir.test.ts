import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBinDir } from "./bin-dir";
import { shimPath } from "./shim-path";

const H = "/home/u";

test("no bin_dir keeps ~/bin", () => {
  expect(parseBinDir("", H)).toBe("/home/u/bin");
  expect(parseBinDir("host=me@mac\nautomation=off\n", H)).toBe("/home/u/bin");
});

test("bin_dir expands ~ and $HOME locally and drops quotes and trailing slashes", () => {
  expect(parseBinDir("bin_dir=~/.local/bin", H)).toBe("/home/u/.local/bin");
  expect(parseBinDir("bin_dir='$HOME/.local/bin'", H)).toBe("/home/u/.local/bin");
  expect(parseBinDir('bin_dir="${HOME}/tools/"', H)).toBe("/home/u/tools");
  expect(parseBinDir("  bin_dir = /opt/blip ", H)).toBe("/opt/blip");
  expect(parseBinDir("bin_dir=~", H)).toBe("/home/u");
});

test("anything but a plain absolute path falls back to ~/bin", () => {
  for (const v of ["", "relative/bin", "/a/../b", "..", "/tmp/$(id)", "/x;rm", "~other/bin", "$XDG_BIN"])
    expect(parseBinDir(`bin_dir=${v}`, H)).toBe("/home/u/bin");
});

test("a commented-out bin_dir is ignored", () => {
  expect(parseBinDir("# bin_dir=/opt/blip\n", H)).toBe("/home/u/bin");
});

test("a Windows drive path is accepted and a climb is not", () => {
  const home = "C:/Users/example";
  expect(parseBinDir("bin_dir=~/.local/bin", home)).toBe("C:/Users/example/.local/bin");
  expect(parseBinDir("bin_dir=C:/Tools/blip", home)).toBe("C:/Tools/blip");
  expect(parseBinDir("bin_dir=C:/Tools/../blip", home)).toBe("C:/Users/example/bin");
  expect(parseBinDir("bin_dir=C:/Tools/$(id)", home)).toBe("C:/Users/example/bin");
});

test("shimPath reads bin_dir from the user's bridge.conf", () => {
  const ext = process.platform === "win32" ? ".exe" : "";
  const home = mkdtempSync(join(tmpdir(), "blip-bin-"));
  expect(shimPath("imsg", home)).toBe(`${home}/bin/imsg${ext}`);
  mkdirSync(join(home, ".config", "blip"), { recursive: true });
  writeFileSync(join(home, ".config", "blip", "bridge.conf"), "host=me@mac\nbin_dir=~/.local/bin\n");
  expect(shimPath("imsg-send", home)).toBe(`${home}/.local/bin/imsg-send${ext}`);
});

test("the deployed QML module agrees with bin-dir.ts", async () => {
  const runtime = await import("./BinDir.mjs");
  for (const conf of ["", "bin_dir=~/.local/bin", "bin_dir=/a/../b", "bin_dir='$HOME/x/'"])
    expect(runtime.parseBinDir(conf, H)).toBe(parseBinDir(conf, H));
});

test("no spawner hard-codes ~/bin", () => {
  const dir = import.meta.dir;
  for (const f of readdirSync(dir).filter(n => /\.(ts|qml)$/.test(n) && !n.endsWith(".test.ts"))) {
    const src = readFileSync(join(dir, f), "utf8");
    expect({ f, hit: /["`'/]bin\/(imsg|imsg-send|imsg-read|imsg-react|contacts|contact-save)\b|["`']bin["`']\s*,\s*["`'](imsg|imsg-send|imsg-read|imsg-react|contacts|contact-save)["`']/.test(src.replace(/^\s*(\/\/|\*).*$/gm, "")) })
      .toEqual({ f, hit: false });
  }
});
