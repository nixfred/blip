using System.Text;
using System.Text.Json;

namespace BlipTray;

sealed class Pending
{
    public string Chat { get; init; } = "";
    public string Text { get; init; } = "";
    public string Ts { get; init; } = "";
    public string LocalId { get; init; } = "";
    public bool Failed { get; init; }
    public string FailureReason { get; init; } = "";
}

sealed class Session : IDisposable
{
    readonly Bridge _bridge;
    readonly object _gate = new();
    readonly SemaphoreSlim _collector = new(1, 1);
    readonly List<Pending> _pending = [];
    readonly List<string[]> _calls = [];
    List<Row> _rows = [];
    List<Bubble> _bubbles = [];
    string _openChat = "";
    string _error = "";
    bool _online = true;
    bool _ok = true;
    int _unread;
    System.Threading.Timer? _timer;
    SynchronizationContext? _ui;

    public event Action? Changed;

    public Session(Bridge bridge) => _bridge = bridge;

    public bool Online { get { lock (_gate) return _online; } }
    public bool Ok { get { lock (_gate) return _ok; } }
    public string Error { get { lock (_gate) return _error; } }
    public int Unread { get { lock (_gate) return _unread; } }
    public string OpenChat { get { lock (_gate) return _openChat; } }
    public bool SawRead { get { lock (_gate) return _calls.Any(call => call.Contains("--read")); } }
    public bool SawFlag(string flag) { lock (_gate) return _calls.Any(call => call.Contains(flag)); }
    public bool TrayAlive { get; set; }

    public List<Row> Rows()
    {
        lock (_gate) return _rows.ToList();
    }

    public List<Bubble> Bubbles()
    {
        lock (_gate) return _bubbles.ToList();
    }

    public void Start(SynchronizationContext ui, bool deep)
    {
        _ui = ui;
        Refresh(deep);
        _timer = new System.Threading.Timer(_ => Refresh(false), null, 6000, 6000);
    }

    public void Refresh(bool deep)
    {
        if (!_collector.Wait(0)) return;
        Task.Run(() => Collect(deep ? ["--deep"] : [], hold: true));
    }

    public void MarkAll()
    {
        Task.Run(() => Collect(["--mark-read", "--deep"], hold: false));
    }

    public void Open(string chat)
    {
        if (chat.Length == 0) return;
        lock (_gate)
        {
            _openChat = chat;
            _bubbles = [];
            _error = "";
        }
        Notify();
        Task.Run(() => LoadThread(chat));
    }

    public void Compose()
    {
        string chat;
        string seen;
        lock (_gate)
        {
            chat = _openChat;
            if (chat.Length == 0) return;
            seen = NewestSeen();
            _calls.Add(seen.Length == 0
                ? ["--read", chat, "--deep"]
                : ["--read", chat, "--seen", seen, "--deep"]);
        }
        string[] args;
        lock (_gate) args = _calls[^1].ToArray();
        Task.Run(() => Collect(args, hold: false));
    }

    public void Send(string chat, string service, string body)
    {
        var text = body.Replace("\r\n", "\n");
        if (chat.Length == 0 || text.Trim().Length == 0) return;
        var pending = new Pending
        {
            Chat = chat,
            Text = text,
            Ts = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ"),
            LocalId = Guid.NewGuid().ToString("N"),
        };
        lock (_gate) _pending.Add(pending);
        Task.Run(() => SendBody(pending, service));
    }

    public string Kind()
    {
        lock (_gate)
        {
            if (!_online) return "offline";
            return _unread > 0 ? "unread" : "quiet";
        }
    }

    public void Dispose()
    {
        _timer?.Dispose();
        _collector.Dispose();
    }

    void Collect(string[] args, bool hold)
    {
        if (!hold) _collector.Wait();
        try
        {
            lock (_gate) _calls.Add(args.ToArray());
            var run = _bridge.Run("collector.ts", args, null, 120000);
            Poll? poll = null;
            try { if (run.stdout.Contains('{')) poll = Wire.ParsePoll(run.stdout); }
            catch { poll = null; }
            lock (_gate)
            {
                if (poll == null)
                {
                    _ok = false;
                    _online = run.code != 69 && run.code != 255 && run.code != 127;
                    _error = run.code == 127 ? run.stderr : "collector returned nothing";
                }
                else
                {
                    _ok = poll.Ok;
                    _online = poll.Online;
                    _error = poll.Error;
                    _unread = poll.Unread;
                    if (poll.Online && (poll.Deep || _rows.Count == 0)) _rows = poll.Threads;
                    else if (poll.Online && poll.Threads.Count > 0) Merge(poll.Threads);
                }
            }
        }
        catch (Exception ex)
        {
            lock (_gate) { _ok = false; _error = ex.Message; }
        }
        finally
        {
            _collector.Release();
        }
        Notify();
    }

    void Merge(List<Row> incoming)
    {
        var byChat = incoming.ToDictionary(row => row.Chat, row => row);
        _rows = _rows.Select(row => byChat.TryGetValue(row.Chat, out var next) ? next : row).ToList();
        foreach (var row in incoming)
        {
            if (_rows.All(kept => kept.Chat != row.Chat)) _rows.Add(row);
        }
    }

    void LoadThread(string chat)
    {
        List<Pending> mine;
        lock (_gate) mine = _pending.Where(item => item.Chat == chat).ToList();
        var args = new List<string> { chat, "80" };
        byte[]? stdin = null;
        if (mine.Count > 0)
        {
            args.Add("--pending-stdin");
            stdin = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(mine, JsonCamel));
        }
        var run = _bridge.Run("thread.ts", args, stdin, 30000);
        ThreadView? view = null;
        try { if (run.stdout.Contains('{')) view = Wire.ParseThread(run.stdout); }
        catch { view = null; }
        lock (_gate)
        {
            if (_openChat != chat) return;
            if (view == null)
            {
                _bubbles = [];
                _error = "thread returned nothing";
            }
            else
            {
                _bubbles = view.Bubbles;
                if (!view.Ok) _error = view.Error;
                if (!view.Online) { _online = false; _error = view.Error.Length == 0 ? "Mac unreachable" : view.Error; }
            }
        }
        Notify();
    }

    void SendBody(Pending pending, string service)
    {
        var run = _bridge.Run(
            Path.Combine("windows", "text-send.ts"),
            ["--chat", pending.Chat, "--service", service.Length == 0 ? "iMessage" : service],
            Encoding.UTF8.GetBytes(pending.Text),
            180000);
        var ok = false;
        var error = "send returned nothing";
        try
        {
            if (run.stdout.Contains('{'))
            {
                using var doc = JsonDocument.Parse(Wire.Slice(run.stdout));
                ok = doc.RootElement.TryGetProperty("ok", out var flag) && flag.ValueKind == JsonValueKind.True;
                if (doc.RootElement.TryGetProperty("error", out var err) && err.ValueKind == JsonValueKind.String)
                    error = err.GetString() ?? error;
                if (doc.RootElement.TryGetProperty("online", out var online) && online.ValueKind == JsonValueKind.False)
                {
                    lock (_gate) { _online = false; _error = error; }
                }
            }
        }
        catch { ok = false; }
        lock (_gate)
        {
            var found = _pending.FirstOrDefault(item => item.LocalId == pending.LocalId);
            if (!ok && found != null)
            {
                _pending.Remove(found);
                _pending.Add(new Pending
                {
                    Chat = found.Chat,
                    Text = found.Text,
                    Ts = found.Ts,
                    LocalId = found.LocalId,
                    Failed = true,
                    FailureReason = error,
                });
            }
        }
        LoadThread(pending.Chat);
    }

    static readonly JsonSerializerOptions JsonCamel = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    string NewestSeen()
    {
        var best = "";
        foreach (var bubble in _bubbles)
        {
            if (bubble.Pending) continue;
            var stamp = bubble.SeenTs.Length > 0 ? bubble.SeenTs : bubble.Ts;
            if (stamp.Length > 0 && string.CompareOrdinal(stamp, best) > 0) best = stamp;
        }
        return best;
    }

    void Notify()
    {
        var ui = _ui;
        if (ui == null) Changed?.Invoke();
        else ui.Post(_ => Changed?.Invoke(), null);
    }
}
