using System.Text.Json;

namespace BlipTray;

static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (_, e) => Note(e.Exception);
        AppDomain.CurrentDomain.UnhandledException += (_, e) => Note(e.ExceptionObject as Exception);
        try
        {
            var writeIcon = Arg(args, "--write-icon");
            if (writeIcon != null)
            {
                FaceIcon.SaveIco(writeIcon);
                return;
            }
            var preview = Environment.GetEnvironmentVariable("BLIP_ICON_PREVIEW");
            if (!string.IsNullOrEmpty(preview))
            {
                var dir = Path.GetDirectoryName(preview);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                FaceIcon.SaveSet(preview, 0);
                return;
            }
            if (Arg(args, "--proof") == null && !Instance.Take())
            {
                Mark("show");
                return;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
            TrayIcons.Promote(Environment.ProcessPath);
            var (repo, bun) = LoadLaunch();
            var session = new Session(new Bridge(repo, bun));
            var proof = Arg(args, "--proof");
            if (proof != null)
            {
                RunProof(session, proof);
                return;
            }
            Note(null);
            Application.Run(new TrayHost(session));
        }
        catch (Exception ex)
        {
            Note(ex);
        }
    }

    internal static void Mark(string detail)
    {
        try
        {
            File.AppendAllText(Path.Combine(Path.GetTempPath(), "blip-tray-startup.log"), DateTime.UtcNow.ToString("o") + " " + detail + "\n");
        }
        catch { /* a tray that cannot log still has to exit quietly */ }
    }

    static void Note(Exception? ex)
    {
        var detail = ex == null ? "up" : ex.GetType().Name;
        var message = ex?.Message.Replace("\r", " ").Replace("\n", " ") ?? "";
        if (message.Length > 160) message = message[..160];
        if (message.Length > 0) detail += " " + message;
        Mark(detail);
    }

    static void RunProof(Session session, string dir)
    {
        Directory.CreateDirectory(dir);
        var trace = Path.Combine(dir, "trace.txt");
        void Mark(string step) { try { File.AppendAllText(trace, step + "\n"); } catch { /* trace is best effort */ } }
        try
        {
            RunProofBody(session, dir, Mark);
            Mark("done");
        }
        catch (Exception ex)
        {
            Mark(ex.ToString());
            throw;
        }
    }

    static void RunProofBody(Session session, string dir, Action<string> mark)
    {
        mark("start");
        using var form = new MainForm(session);
        using var icon = new FaceIcon();
        icon.Set("quiet", 0);
        using var tray = new NotifyIcon { Visible = true, Text = "Blip", Icon = icon.Icon };
        icon.ReleaseStale();
        mark("icon");
        form.Show();
        session.TrayAlive = tray.Visible;
        mark("shown");
        var context = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
        SynchronizationContext.SetSynchronizationContext(context);
        session.Changed += () =>
        {
            icon.Set(session.Kind(), session.Unread);
            tray.Icon = icon.Icon;
            icon.ReleaseStale();
        };
        session.Start(context, deep: true);
        mark("started");
        Pump(40000, () => session.Rows().Count > 0 && form.Listed > 0);
        mark("listed " + form.Listed + " rows " + session.Rows().Count + " err " + session.Error);
        form.SelectNamed("Jamie Rivera");
        mark("selected");
        Pump(20000, () => session.Bubbles().Count > 0 || session.Error.Length > 0);
        mark("bubbles " + session.Bubbles().Count);
        var readBefore = session.SawRead;
        form.FocusCompose();
        Application.DoEvents();
        var readAfter = session.SawRead;
        session.MarkAll();
        Pump(20000, () => session.SawFlag("--mark-read"));
        form.Refresh();
        using var bmp = new Bitmap(form.Width, form.Height);
        form.DrawToBitmap(bmp, new Rectangle(0, 0, form.Width, form.Height));
        bmp.Save(Path.Combine(dir, "window.png"));
        FaceIcon.SaveSet(Path.Combine(dir, "faces.png"), session.Unread);
        var names = session.Rows()
            .Select(row => row.Name.Length > 0 ? row.Name : row.Handle)
            .Where(name => name.Length > 0)
            .Take(16)
            .ToArray();
        var proof = new
        {
            online = session.Online,
            ok = session.Ok,
            tray = session.TrayAlive,
            names,
            bubbles = session.Bubbles().Count,
            readOnOpen = readBefore,
            readOnCompose = readAfter,
            markAll = session.SawFlag("--mark-read"),
            error = session.Error.Length > 180 ? session.Error[..180] : session.Error,
        };
        File.WriteAllText(Path.Combine(dir, "proof.json"), JsonSerializer.Serialize(proof));
        form.Remember();
        tray.Visible = false;
        session.Dispose();
    }

    static void Pump(int ms, Func<bool> done)
    {
        var until = Environment.TickCount64 + ms;
        do
        {
            Application.DoEvents();
            if (done()) return;
            Thread.Sleep(40);
        } while (Environment.TickCount64 < until);
    }

    static (string repo, string bun) LoadLaunch()
    {
        var repo = Environment.GetEnvironmentVariable("BLIP_REPO") ?? "";
        var bun = Environment.GetEnvironmentVariable("BLIP_BUN") ?? "";
        var exeDir = Path.GetDirectoryName(Environment.ProcessPath ?? "") ?? "";
        var file = Path.Combine(exeDir, "launch.json");
        if (File.Exists(file))
        {
            try
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(file));
                if (repo.Length == 0 && doc.RootElement.TryGetProperty("repo", out var repoValue))
                    repo = repoValue.GetString() ?? "";
                if (bun.Length == 0 && doc.RootElement.TryGetProperty("bun", out var bunValue))
                    bun = bunValue.GetString() ?? "";
            }
            catch { /* env still wins when the file is junk */ }
        }
        if (bun.Length == 0)
        {
            var guess = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".bun", "bin", "bun.exe");
            if (File.Exists(guess)) bun = guess;
        }
        return (repo, bun);
    }

    static string? Arg(string[] args, string name)
    {
        var index = Array.IndexOf(args, name);
        if (index < 0 || index + 1 >= args.Length) return null;
        return args[index + 1];
    }
}

static class Instance
{
    const string MutexName = @"Local\Nixfred.Blip";
    const string EventName = @"Local\Nixfred.Blip.Show";
    static readonly object Gate = new();
    static Mutex? _mutex;
    static EventWaitHandle? _show;
    static Action? _onShow;
    static bool _pending;

    public static bool Take()
    {
        var mutex = new Mutex(false, MutexName);
        var owned = false;
        try
        {
            owned = mutex.WaitOne(0);
        }
        catch (AbandonedMutexException)
        {
            owned = true;
        }
        if (!owned)
        {
            mutex.Dispose();
            Signal();
            return false;
        }
        _mutex = mutex;
        _show = new EventWaitHandle(false, EventResetMode.AutoReset, EventName);
        new Thread(Watch) { IsBackground = true, Name = "blip-show" }.Start();
        return true;
    }

    public static void WhenShown(Action show)
    {
        bool fire;
        lock (Gate)
        {
            _onShow = show;
            fire = _pending;
            _pending = false;
        }
        if (fire) show();
    }

    static void Signal()
    {
        for (var i = 0; i < 25; i++)
        {
            try
            {
                using var ev = EventWaitHandle.OpenExisting(EventName);
                ev.Set();
                return;
            }
            catch (WaitHandleCannotBeOpenedException)
            {
                Thread.Sleep(100);
            }
        }
    }

    static void Watch()
    {
        var ev = _show;
        if (ev == null || _mutex == null) return;
        while (ev.WaitOne())
        {
            Action? show;
            lock (Gate)
            {
                show = _onShow;
                if (show == null) _pending = true;
            }
            show?.Invoke();
        }
    }
}

sealed class TrayHost : ApplicationContext
{
    readonly Session _session;
    readonly FaceIcon _icon = new();
    readonly NotifyIcon _tray;
    readonly MainForm _form;
    bool _quit;

    public TrayHost(Session session)
    {
        _session = session;
        _form = new MainForm(session);
        _form.FormClosing += OnClose;
        _icon.Set("quiet", 0);
        _tray = new NotifyIcon { Visible = true, Text = "Blip", Icon = _icon.Icon };
        _icon.ReleaseStale();
        var menu = new ContextMenuStrip();
        menu.Items.Add("Open", null, (_, _) => ShowForm());
        menu.Items.Add("Mark all read", null, (_, _) => session.MarkAll());
        menu.Items.Add("Refresh", null, (_, _) => session.Refresh(_form.Visible));
        menu.Items.Add("Quit", null, (_, _) => Quit());
        _tray.ContextMenuStrip = menu;
        _tray.MouseClick += (_, e) =>
        {
            if (e.Button == MouseButtons.Left) ShowForm();
            if (e.Button == MouseButtons.Middle) session.Refresh(_form.Visible);
        };
        session.Changed += ApplyIcon;
        session.TrayAlive = _tray.Visible;
        var context = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
        Instance.WhenShown(() => context.Post(_ =>
        {
            Program.Mark("shown");
            ShowForm();
        }, null));
        session.Start(context, deep: false);
        ApplyIcon();
        var nudge = new System.Windows.Forms.Timer { Interval = 400 };
        nudge.Tick += (_, _) =>
        {
            nudge.Stop();
            nudge.Dispose();
            // Windows 11 keeps a new NotifyIcon in the overflow until this flag is set.
            TrayIcons.Promote(Environment.ProcessPath);
            _tray.Visible = false;
            _tray.Visible = true;
            TrayIcons.Promote(Environment.ProcessPath);
        };
        nudge.Start();
    }

    void ApplyIcon()
    {
        _icon.Set(_session.Kind(), _session.Unread);
        _tray.Icon = _icon.Icon;
        _icon.ReleaseStale();
        var count = _session.Unread;
        _tray.Text = !_session.Online ? "Blip offline" : count > 0 ? $"Blip {Math.Min(count, 99)}" : "Blip";
    }

    void ShowForm()
    {
        _session.Refresh(true);
        if (!_form.Visible) _form.Show();
        _form.Activate();
    }

    void OnClose(object? sender, FormClosingEventArgs e)
    {
        if (_quit) return;
        e.Cancel = true;
        _form.Remember();
        _form.Hide();
    }

    void Quit()
    {
        _quit = true;
        _form.Remember();
        _tray.Visible = false;
        _icon.Dispose();
        _session.Dispose();
        _form.Close();
        ExitThread();
    }
}

static class TrayIcons
{
    public static void Promote(string? exe)
    {
        if (string.IsNullOrEmpty(exe)) return;
        try
        {
            using var root = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Control Panel\NotifyIconSettings", writable: true);
            if (root == null) return;
            foreach (var name in root.GetSubKeyNames())
            {
                using var sub = root.OpenSubKey(name, writable: true);
                if (sub == null) continue;
                var path = sub.GetValue("ExecutablePath") as string;
                if (path == null || !path.Equals(exe, StringComparison.OrdinalIgnoreCase)) continue;
                sub.SetValue("IsPromoted", 1, Microsoft.Win32.RegistryValueKind.DWord);
            }
        }
        catch { /* the icon still exists in the overflow if the key is locked */ }
    }
}
