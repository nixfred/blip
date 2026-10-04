using System.Text.Json;

namespace BlipTray;

sealed class Row
{
    public string Chat { get; init; } = "";
    public string Name { get; init; } = "";
    public string Handle { get; init; } = "";
    public string Service { get; init; } = "";
    public string Preview { get; init; } = "";
    public string LastTs { get; init; } = "";
    public int Unread { get; init; }
    public bool Pinned { get; init; }
}

sealed class Bubble
{
    public string Text { get; init; } = "";
    public bool FromMe { get; init; }
    public string Name { get; init; } = "";
    public string Ts { get; init; } = "";
    public string SeenTs { get; init; } = "";
    public string Time { get; init; } = "";
    public bool Pending { get; init; }
    public string Failure { get; init; } = "";
}

sealed class Poll
{
    public bool Ok { get; init; }
    public bool Online { get; init; }
    public bool Deep { get; init; }
    public string Error { get; init; } = "";
    public int Unread { get; init; }
    public List<Row> Threads { get; init; } = [];
}

sealed class ThreadView
{
    public bool Ok { get; init; }
    public bool Online { get; init; }
    public string Error { get; init; } = "";
    public List<Bubble> Bubbles { get; init; } = [];
}

static class Wire
{
    public static string Slice(string raw)
    {
        var start = raw.IndexOf('{');
        var end = raw.LastIndexOf('}');
        return start >= 0 && end > start ? raw[start..(end + 1)] : "";
    }

    public static Poll ParsePoll(string raw)
    {
        using var doc = JsonDocument.Parse(Slice(raw));
        var root = doc.RootElement;
        var threads = new List<Row>();
        if (root.TryGetProperty("threads", out var list) && list.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in list.EnumerateArray())
            {
                threads.Add(new Row
                {
                    Chat = Str(item, "chat"),
                    Name = Str(item, "name"),
                    Handle = Str(item, "handle"),
                    Service = Str(item, "service"),
                    Preview = Str(item, "last_text"),
                    LastTs = Str(item, "last_ts"),
                    Unread = Num(item, "unread"),
                    Pinned = item.TryGetProperty("pinned", out var pin) && pin.ValueKind == JsonValueKind.True,
                });
            }
        }
        return new Poll
        {
            Ok = root.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.True,
            Online = root.TryGetProperty("online", out var on) && on.ValueKind == JsonValueKind.True,
            Deep = root.TryGetProperty("deep", out var deep) && deep.ValueKind == JsonValueKind.True,
            Error = Str(root, "error"),
            Unread = Num(root, "unread"),
            Threads = threads,
        };
    }

    public static ThreadView ParseThread(string raw)
    {
        using var doc = JsonDocument.Parse(Slice(raw));
        var root = doc.RootElement;
        var bubbles = new List<Bubble>();
        if (root.TryGetProperty("bubbles", out var list) && list.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in list.EnumerateArray())
            {
                bubbles.Add(new Bubble
                {
                    Text = Str(item, "text"),
                    FromMe = item.TryGetProperty("from_me", out var me) && me.ValueKind == JsonValueKind.True,
                    Name = Str(item, "name"),
                    Ts = Str(item, "ts"),
                    SeenTs = Str(item, "seen_ts"),
                    Time = Str(item, "time"),
                    Pending = item.TryGetProperty("pending", out var pending) && pending.ValueKind == JsonValueKind.True,
                    Failure = Str(item, "failureReason"),
                });
            }
        }
        return new ThreadView
        {
            Ok = root.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.True,
            Online = root.TryGetProperty("online", out var on) && on.ValueKind == JsonValueKind.True,
            Error = Str(root, "error"),
            Bubbles = bubbles,
        };
    }

    static string Str(JsonElement item, string name) =>
        item.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? ""
            : "";

    static int Num(JsonElement item, string name) =>
        item.TryGetProperty(name, out var value) && value.TryGetInt32(out var n) ? n : 0;
}
