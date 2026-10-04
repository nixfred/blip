namespace BlipTray;

sealed class MainForm : Form
{
    readonly Session _session;
    readonly ListView _list = new();
    readonly Panel _thread = new();
    readonly Label _title = new();
    readonly Label _status = new();
    readonly TextBox _compose = new();
    readonly Button _send = new();
    bool _binding;
    string _shown = "";

    public MainForm(Session session)
    {
        _session = session;
        Text = "Blip";
        try
        {
            var exe = Environment.ProcessPath;
            if (!string.IsNullOrEmpty(exe))
            {
                var icon = Icon.ExtractAssociatedIcon(exe);
                if (icon != null) Icon = icon;
            }
        }
        catch { /* the window still opens if the exe has no icon resource */ }
        BackColor = Color.FromArgb(28, 28, 30);
        ForeColor = Color.White;
        Font = new Font("Segoe UI", 10f);
        ClientSize = new Size(1040, 720);
        MinimumSize = new Size(760, 480);
        StartPosition = FormStartPosition.CenterScreen;

        var split = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 2,
            RowCount = 1,
            BackColor = BackColor,
        };
        split.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 320));
        split.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));

        _list.Dock = DockStyle.Fill;
        _list.View = View.Details;
        _list.FullRowSelect = true;
        _list.HeaderStyle = ColumnHeaderStyle.None;
        _list.MultiSelect = false;
        _list.HideSelection = false;
        _list.BackColor = Color.FromArgb(22, 22, 24);
        _list.ForeColor = Color.White;
        _list.BorderStyle = BorderStyle.None;
        _list.Columns.Add("name", 250);
        _list.Columns.Add("dot", 50);
        _list.SelectedIndexChanged += (_, _) => OnSelect();

        var right = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 3,
            BackColor = BackColor,
        };
        right.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));
        right.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        right.RowStyles.Add(new RowStyle(SizeType.Absolute, 56));

        _title.Dock = DockStyle.Fill;
        _title.TextAlign = ContentAlignment.MiddleLeft;
        _title.Padding = new Padding(12, 0, 0, 0);
        _title.Font = new Font("Segoe UI", 12f, FontStyle.Bold);

        _thread.Dock = DockStyle.Fill;
        _thread.AutoScroll = true;
        _thread.BackColor = Color.FromArgb(18, 18, 20);

        var composeRow = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 2,
            BackColor = BackColor,
            Padding = new Padding(8, 8, 8, 8),
        };
        composeRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        composeRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 88));
        _compose.Dock = DockStyle.Fill;
        _compose.BackColor = Color.FromArgb(44, 44, 46);
        _compose.ForeColor = Color.White;
        _compose.BorderStyle = BorderStyle.FixedSingle;
        _compose.Enter += (_, _) => _session.Compose();
        _compose.KeyDown += OnComposeKey;
        _send.Text = "Send";
        _send.Dock = DockStyle.Fill;
        _send.FlatStyle = FlatStyle.Flat;
        _send.BackColor = Color.FromArgb(0x0a, 0x84, 0xff);
        _send.ForeColor = Color.White;
        _send.Click += (_, _) => Submit();
        composeRow.Controls.Add(_compose, 0, 0);
        composeRow.Controls.Add(_send, 1, 0);

        right.Controls.Add(_title, 0, 0);
        right.Controls.Add(_thread, 0, 1);
        right.Controls.Add(composeRow, 0, 2);
        split.Controls.Add(_list, 0, 0);
        split.Controls.Add(right, 1, 0);

        _status.Dock = DockStyle.Bottom;
        _status.Height = 24;
        _status.TextAlign = ContentAlignment.MiddleLeft;
        _status.Padding = new Padding(8, 0, 0, 0);
        _status.BackColor = Color.FromArgb(36, 36, 38);

        Controls.Add(split);
        Controls.Add(_status);
        _session.Changed += Bind;
        Load += (_, _) => Place();
    }

    public int Listed => _list.Items.Count;

    public bool SelectNamed(string name)
    {
        foreach (ListViewItem item in _list.Items)
        {
            if (!string.Equals(item.Text, name, StringComparison.Ordinal)) continue;
            item.Selected = true;
            item.Focused = true;
            return true;
        }
        return false;
    }

    public void FocusCompose() => _compose.Focus();

    void Place()
    {
        var path = WindowFile();
        try
        {
            if (!File.Exists(path)) return;
            using var doc = System.Text.Json.JsonDocument.Parse(File.ReadAllText(path));
            var root = doc.RootElement;
            if (!root.TryGetProperty("w", out var w) || !root.TryGetProperty("h", out var h)) return;
            var width = w.GetInt32();
            var height = h.GetInt32();
            if (width < 760 || height < 480) return;
            StartPosition = FormStartPosition.Manual;
            var x = root.TryGetProperty("x", out var xp) ? xp.GetInt32() : Left;
            var y = root.TryGetProperty("y", out var yp) ? yp.GetInt32() : Top;
            Bounds = new Rectangle(x, y, width, height);
        }
        catch { /* a bad geometry file just keeps the default */ }
    }

    public void Remember()
    {
        try
        {
            var path = WindowFile();
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            var json = System.Text.Json.JsonSerializer.Serialize(new { x = Left, y = Top, w = Width, h = Height });
            File.WriteAllText(path, json);
        }
        catch { /* the window still closes */ }
    }

    static string WindowFile()
    {
        var home = Environment.GetEnvironmentVariable("HOME");
        if (string.IsNullOrEmpty(home)) home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        return Path.Combine(home, ".local", "state", "blip", "window.json");
    }

    void OnSelect()
    {
        if (_binding || _list.SelectedItems.Count == 0) return;
        var chat = _list.SelectedItems[0].Tag as string ?? "";
        if (chat.Length == 0 || chat == _session.OpenChat) return;
        _session.Open(chat);
    }

    void OnComposeKey(object? sender, KeyEventArgs e)
    {
        if (e.KeyCode != Keys.Enter || e.Shift) return;
        e.SuppressKeyPress = true;
        Submit();
    }

    void Submit()
    {
        var row = Current();
        if (row == null) return;
        var text = _compose.Text;
        _compose.Clear();
        _session.Send(row.Chat, row.Service, text);
    }

    Row? Current()
    {
        var chat = _session.OpenChat;
        return _session.Rows().FirstOrDefault(row => row.Chat == chat);
    }

    void Bind()
    {
        if (IsDisposed) return;
        var rows = _session.Rows();
        var bubbles = _session.Bubbles();
        var open = _session.OpenChat;
        _binding = true;
        try
        {
            if (ListChanged(rows))
            {
                _list.BeginUpdate();
                _list.Items.Clear();
                foreach (var row in rows.OrderByDescending(row => row.Pinned).ThenByDescending(row => row.LastTs, StringComparer.Ordinal))
                {
                    var label = row.Name.Length > 0 ? row.Name : row.Handle;
                    if (label.Length == 0) label = row.Chat;
                    var item = new ListViewItem(label) { Tag = row.Chat };
                    item.SubItems.Add(row.Unread > 0 ? "●" : "");
                    if (row.Chat == open) item.Selected = true;
                    _list.Items.Add(item);
                }
                _list.EndUpdate();
            }
        }
        finally { _binding = false; }

        var current = rows.FirstOrDefault(row => row.Chat == open);
        _title.Text = current == null ? "Blip" : (current.Name.Length > 0 ? current.Name : current.Handle);
        var signature = open + "\n" + string.Join("\n", bubbles.Select(bubble => bubble.Ts + bubble.Pending + bubble.Text.Length));
        if (signature != _shown)
        {
            _shown = signature;
            _thread.SuspendLayout();
            _thread.Controls.Clear();
            var y = 8;
            var width = Math.Max(280, _thread.ClientSize.Width - 24);
            foreach (var bubble in bubbles)
            {
                var who = bubble.FromMe ? "You" : (bubble.Name.Length > 0 ? bubble.Name : "Them");
                var body = bubble.Text;
                if (bubble.Pending && bubble.Failure.Length == 0) body += "\nSending…";
                if (bubble.Failure.Length > 0) body += "\n" + bubble.Failure;
                var label = new Label
                {
                    AutoSize = true,
                    MaximumSize = new Size(width - (bubble.FromMe ? 80 : 16), 0),
                    Text = who + (bubble.Time.Length > 0 ? "  " + bubble.Time : "") + "\n" + body,
                    BackColor = bubble.Failure.Length > 0
                        ? Color.FromArgb(90, 32, 32)
                        : bubble.FromMe ? Color.FromArgb(0x0a, 0x84, 0xff) : Color.FromArgb(44, 44, 46),
                    ForeColor = Color.White,
                    Padding = new Padding(8),
                    Location = new Point(bubble.FromMe ? 72 : 8, y),
                };
                _thread.Controls.Add(label);
                y += label.Height + 6;
            }
            _thread.ResumeLayout();
            _thread.AutoScrollPosition = new Point(0, y);
        }
        _status.Text = !_session.Online
            ? "Offline. The Mac bridge is not reachable."
            : (_session.Ok ? "" : _session.Error);
    }

    bool ListChanged(List<Row> rows)
    {
        if (_list.Items.Count != rows.Count) return true;
        var ordered = rows.OrderByDescending(row => row.Pinned).ThenByDescending(row => row.LastTs, StringComparer.Ordinal).ToList();
        for (var i = 0; i < ordered.Count; i++)
        {
            var row = ordered[i];
            var item = _list.Items[i];
            var label = row.Name.Length > 0 ? row.Name : (row.Handle.Length > 0 ? row.Handle : row.Chat);
            var dot = row.Unread > 0 ? "●" : "";
            if ((item.Tag as string) != row.Chat || item.Text != label || item.SubItems[1].Text != dot) return true;
        }
        return false;
    }
}
