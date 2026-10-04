using System.Diagnostics;
using System.Text;

namespace BlipTray;

sealed class Bridge
{
    public string Repo { get; }
    public string Bun { get; }

    public Bridge(string repo, string bun)
    {
        Repo = repo;
        Bun = bun;
    }

    public (int code, string stdout, string stderr) Run(string script, IReadOnlyList<string> args, byte[]? stdin, int timeoutMs)
    {
        var scriptPath = Path.GetFullPath(Path.Combine(Repo, script));
        if (Bun.Length == 0 || !File.Exists(Bun)) return (127, "", "bun is not installed");
        if (Repo.Length == 0 || !File.Exists(scriptPath)) return (127, "", "checkout is missing");
        var psi = new ProcessStartInfo(Bun)
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = true,
            WorkingDirectory = Repo,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        psi.ArgumentList.Add(scriptPath);
        foreach (var arg in args) psi.ArgumentList.Add(arg);
        using var proc = Process.Start(psi) ?? throw new InvalidOperationException("bun did not start");
        if (stdin != null && stdin.Length > 0) proc.StandardInput.BaseStream.Write(stdin, 0, stdin.Length);
        proc.StandardInput.Close();
        var stdout = proc.StandardOutput.ReadToEndAsync();
        var stderr = proc.StandardError.ReadToEndAsync();
        if (!proc.WaitForExit(timeoutMs))
        {
            try { proc.Kill(true); } catch { /* already gone */ }
            return (124, "", "timed out");
        }
        return (proc.ExitCode, stdout.GetAwaiter().GetResult(), stderr.GetAwaiter().GetResult());
    }
}
