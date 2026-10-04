using System.Diagnostics;
using System.Text.RegularExpressions;

// Windows stand-in for bridge/linux/blip-shim. The file name is the tool
// (imsg.exe, imsg-send.exe, ...). Exit 69 means the Mac is unreachable.
// Exit 78 means bridge.conf is missing or refused. ssh -n is only the probe.
// A send's stdin is the real ssh, so the probe cannot eat the body.

var tool = Path.GetFileNameWithoutExtension(Environment.ProcessPath ?? "imsg");
var argv = Environment.GetCommandLineArgs().Skip(1).ToArray();
var home = Environment.GetEnvironmentVariable("HOME");
if (string.IsNullOrEmpty(home)) home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
var conf = Conf.Load(home);
if (conf.Host == "fixture") return RunFixture(tool, argv);
if (conf.Host.Length == 0) {
    Console.Error.WriteLine("blip: no Mac configured. Set host= in bridge.conf.");
    return 78;
}
if (!Conf.HostOk(conf.Host) || !conf.PathsOk()) {
    Console.Error.WriteLine("blip: refusing host or path in bridge.conf.");
    return 78;
}
if (tool == "imsg-react" && !Conf.On(conf.Tapbacks)) {
    Console.Error.WriteLine("imsg-react: tapbacks are off. Set tapbacks=on in bridge.conf to enable.");
    return 78;
}
return RunSsh(conf, tool, argv);

static int RunFixture(string tool, string[] args) {
    if (tool is "imsg-send" or "imsg-read" or "imsg-react" or "contacts" or "contact-save") {
        if (tool is "imsg-send" or "contact-save") DrainStdin();
        if (tool == "contacts") Console.WriteLine("[]");
        return 0;
    }
    var script = FixtureScript();
    if (script == null) {
        Console.Error.WriteLine("blip: fixture script missing.");
        return 78;
    }
    var bun = FindBun();
    if (bun == null) {
        Console.Error.WriteLine("blip: bun is not installed.");
        return 69;
    }
    var cmd = new List<string> { script };
    cmd.AddRange(args);
    return Exec(bun, cmd, pipeIn: false);
}

static string? FixtureScript() {
    var env = Environment.GetEnvironmentVariable("BLIP_FIXTURE_SCRIPT");
    string? path = string.IsNullOrWhiteSpace(env) ? null : env.Trim();
    if (path == null) {
        var exeDir = Path.GetDirectoryName(Environment.ProcessPath ?? "");
        if (string.IsNullOrEmpty(exeDir)) return null;
        var beside = Path.Combine(exeDir, "fixture.script");
        if (!File.Exists(beside)) return null;
        path = File.ReadAllText(beside).Trim();
    }
    if (Path.GetFileName(path) != "fake-imsg" || !File.Exists(path)) return null;
    return path;
}

static int RunSsh(Conf conf, string tool, string[] args) {
    var ssh = FindSsh();
    // A confined Blip key answers "ping" with "pong". Tailscale SSH
    // authenticates the tailnet user and runs a normal shell, so ping is
    // the system command and the tools run by path instead.
    var confined = false;
    if (conf.KeyExists) {
        var ping = Probe(ssh, conf, useKey: true, "ping");
        confined = ping.code == 0 && ping.stdout.Trim() == "pong";
    }
    if (!confined) {
        var plain = Probe(ssh, conf, useKey: false, "true");
        if (plain.code != 0) {
            Unreachable(tool, conf.Host, plain.err);
            return 69;
        }
    }
    var call = SshPrefix(conf, confined);
    call.Add("--");
    call.Add(conf.Host);
    call.Add(Remote(conf, tool, args, confined));
    var send = tool is "imsg-send" or "contact-save";
    return Exec(ssh, call, pipeIn: send);
}

static (int code, string stdout, string err) Probe(string ssh, Conf conf, bool useKey, string command) {
    var args = SshPrefix(conf, useKey);
    args.Add("-n");
    args.Add("-o");
    args.Add("ConnectTimeout=5");
    args.Add("-o");
    args.Add("BatchMode=yes");
    args.Add("--");
    args.Add(conf.Host);
    args.Add(command);
    return ExecCapture(ssh, args);
}

static void Unreachable(string tool, string host, string err) {
    var tail = err.ReplaceLineEndings("\n").Trim().Split('\n').LastOrDefault() ?? "";
    if (tail.Length > 180) tail = tail[..180];
    Console.Error.WriteLine($"{tool}: {host} unreachable. The iMessage bridge is offline.{(tail.Length > 0 ? " (" + tail + ")" : "")}");
}

static List<string> SshPrefix(Conf conf, bool useKey) {
    var list = new List<string>();
    if (useKey) {
        list.Add("-i");
        list.Add(conf.Key);
        list.Add("-o");
        list.Add("IdentitiesOnly=yes");
    }
    return list;
}

static string Remote(Conf conf, string tool, string[] args, bool confined) {
    var parts = new List<string>();
    if (tool == "imsg") {
        if (Conf.On(conf.HideSpam)) parts.Add("--hide-spam");
        if (Conf.On(conf.HideUnknown)) parts.Add("--hide-unknown");
    }
    parts.AddRange(args);
    var tail = string.Join(' ', parts.Select(BashQuote));
    if (confined) return string.IsNullOrEmpty(tail) ? tool : tool + " " + tail;
    var head = "PATH=/opt/homebrew/bin:/usr/local/bin:$PATH " + conf.Python + " " + conf.RemoteBin + "/" + tool;
    return string.IsNullOrEmpty(tail) ? head : head + " " + tail;
}

static string BashQuote(string value) => "'" + value.Replace("'", "'\\''") + "'";

static int Exec(string file, List<string> args, bool pipeIn) {
    var psi = StartInfo(file, args);
    psi.RedirectStandardOutput = true;
    psi.RedirectStandardError = true;
    psi.RedirectStandardInput = pipeIn;
    using var proc = Process.Start(psi)!;
    if (pipeIn) {
        Console.OpenStandardInput().CopyTo(proc.StandardInput.BaseStream);
        proc.StandardInput.Close();
    }
    var stdout = proc.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
    var stderr = proc.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
    proc.WaitForExit();
    stdout.Wait();
    stderr.Wait();
    return proc.ExitCode;
}

static (int code, string stdout, string err) ExecCapture(string file, List<string> args) {
    var psi = StartInfo(file, args);
    psi.RedirectStandardOutput = true;
    psi.RedirectStandardError = true;
    using var proc = Process.Start(psi)!;
    var stdout = proc.StandardOutput.ReadToEndAsync();
    var err = proc.StandardError.ReadToEndAsync();
    proc.WaitForExit();
    return (proc.ExitCode, stdout.GetAwaiter().GetResult(), err.GetAwaiter().GetResult());
}

static ProcessStartInfo StartInfo(string file, List<string> args) {
    var psi = new ProcessStartInfo(file) { UseShellExecute = false };
    foreach (var arg in args) psi.ArgumentList.Add(arg);
    return psi;
}

static void DrainStdin() {
    using var stdin = Console.OpenStandardInput();
    var buf = new byte[8192];
    while (stdin.Read(buf, 0, buf.Length) > 0) { }
}

static string? FindBun() {
    var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    var local = Path.Combine(home, ".bun", "bin", "bun.exe");
    if (File.Exists(local)) return local;
    return Which("bun.exe");
}

static string FindSsh() {
    var win = Path.Combine(Environment.SystemDirectory, "OpenSSH", "ssh.exe");
    if (File.Exists(win)) return win;
    return Which("ssh.exe") ?? "ssh";
}

static string? Which(string name) {
    var path = Environment.GetEnvironmentVariable("PATH") ?? "";
    foreach (var dir in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)) {
        var candidate = Path.Combine(dir.Trim(), name);
        if (File.Exists(candidate)) return candidate;
    }
    return null;
}

sealed record Conf {
    public string Host { get; init; } = "";
    public string RemoteBin { get; init; } = "$HOME/.blip/bin";
    public string Python { get; init; } = "python3";
    public string Key { get; init; } = "";
    public string HideSpam { get; init; } = "";
    public string HideUnknown { get; init; } = "";
    public string Tapbacks { get; init; } = "";
    public bool KeyExists => Key.Length > 0 && File.Exists(Key);

    public static bool On(string value) => value.ToLowerInvariant() is "on" or "yes" or "true" or "1";

    public static bool HostOk(string host) => Regex.IsMatch(host, @"^([A-Za-z0-9._-]+@)?[A-Za-z0-9._:-]+$");

    public bool PathsOk() =>
        Regex.IsMatch(Python, @"^[A-Za-z0-9._/-]+$")
        && Regex.IsMatch(RemoteBin, @"^[A-Za-z0-9._/\$-]+$")
        && (Regex.IsMatch(Key, @"^[A-Za-z0-9._/-]+$") || Regex.IsMatch(Key, @"^[A-Za-z]:[\\/][A-Za-z0-9._\\/-]+$"));

    public static Conf Load(string home) {
        var key = Path.Combine(home, ".ssh", "blip_ed25519");
        var conf = new Conf { Key = key };
        var path = Environment.GetEnvironmentVariable("BLIP_BRIDGE_CONF");
        if (string.IsNullOrEmpty(path)) path = Path.Combine(home, ".config", "blip", "bridge.conf");
        if (!File.Exists(path)) {
            var forced = Environment.GetEnvironmentVariable("BLIP_MAC_HOST");
            return string.IsNullOrEmpty(forced) ? conf : conf with { Host = forced };
        }
        var host = "";
        var remote = conf.RemoteBin;
        var python = conf.Python;
        var hideSpam = "";
        var hideUnknown = "";
        var tapbacks = "";
        foreach (var raw in File.ReadAllLines(path)) {
            var line = raw.Split('#')[0].Replace(" ", "").Replace("\t", "");
            var eq = line.IndexOf('=');
            if (eq <= 0) continue;
            var k = line[..eq];
            var v = line[(eq + 1)..].Trim().Trim('"').Trim('\'');
            switch (k) {
                case "host": host = v; break;
                case "remote_bin": remote = v; break;
                case "python": python = v; break;
                case "key": key = v; break;
                case "hide_spam": hideSpam = v; break;
                case "hide_unknown": hideUnknown = v; break;
                case "tapbacks": tapbacks = v; break;
            }
        }
        var mac = Environment.GetEnvironmentVariable("BLIP_MAC_HOST");
        if (!string.IsNullOrEmpty(mac)) host = mac;
        return new Conf {
            Host = host, RemoteBin = remote, Python = python, Key = key,
            HideSpam = hideSpam, HideUnknown = hideUnknown, Tapbacks = tapbacks,
        };
    }
}
