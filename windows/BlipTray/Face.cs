using System.ComponentModel;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace BlipTray;

sealed class FaceIcon : IDisposable
{
    static readonly Color InkColor = Color.FromArgb(255, 0x0A, 0x84, 0xFF);

    Icon? _icon;
    IntPtr _handle;
    IntPtr _stale;

    public Icon Icon => _icon ?? SystemIcons.Application;

    public void Set(string kind, int unread)
    {
        using var bmp = Draw(kind, unread, 32);
        var handle = CreateAlphaIcon(bmp);
        var next = Icon.FromHandle(handle);
        var previous = _icon;
        var previousHandle = _handle;
        _icon = next;
        _handle = handle;
        previous?.Dispose();
        if (_stale != IntPtr.Zero) DestroyIcon(_stale);
        _stale = previousHandle;
    }

    public void ReleaseStale()
    {
        if (_stale == IntPtr.Zero) return;
        DestroyIcon(_stale);
        _stale = IntPtr.Zero;
    }

    public static void SaveSet(string path, int unread)
    {
        using var sheet = new Bitmap(32 * 3 + 16, 40, PixelFormat.Format32bppArgb);
        using var g = Graphics.FromImage(sheet);
        g.Clear(Color.FromArgb(243, 243, 243));
        using var quiet = Draw("quiet", 0, 32);
        using var unreadBmp = Draw("unread", unread <= 0 ? 4 : unread, 32);
        using var offline = Draw("offline", 0, 32);
        g.DrawImage(quiet, 4, 4);
        g.DrawImage(unreadBmp, 40, 4);
        g.DrawImage(offline, 76, 4);
        sheet.Save(path, ImageFormat.Png);
    }

    public static void SaveIco(string path)
    {
        int[] sizes = [16, 20, 24, 32, 40, 48, 64, 256];
        var frames = new Bitmap[sizes.Length];
        try
        {
            for (var i = 0; i < sizes.Length; i++) frames[i] = AppImage(sizes[i]);
            WriteIco(path, frames);
        }
        finally
        {
            foreach (var frame in frames) frame?.Dispose();
        }
    }

    public static Bitmap Draw(string kind, int unread, int size)
    {
        _ = kind;
        _ = unread;
        var phone = Emoji(size, solid: true);
        if (Opaque(phone) >= 40) return phone;
        phone.Dispose();
        return Badge(size);
    }

    static Bitmap AppImage(int size)
    {
        var phone = Emoji(size, solid: false);
        if (Opaque(phone) >= 40) return phone;
        phone.Dispose();
        return Badge(size);
    }

    static Bitmap Emoji(int size, bool solid)
    {
        var canvas = Math.Max(180, size * 2);
        using var big = new Bitmap(canvas, canvas, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(big))
        {
            g.Clear(Color.Transparent);
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
            using var font = new Font("Segoe UI Emoji", canvas * 108f / 180f, FontStyle.Regular, GraphicsUnit.Pixel);
            using var brush = new SolidBrush(Color.Black);
            g.DrawString("\U0001F4F2", font, brush, canvas * -4f / 180f, canvas * -8f / 180f);
        }
        var bounds = Ink(big);
        var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp))
        {
            g.Clear(Color.Transparent);
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            var pad = Math.Max(1, size / (solid ? 16 : 8));
            g.DrawImage(big, new Rectangle(pad, pad, size - pad * 2, size - pad * 2), bounds, GraphicsUnit.Pixel);
        }
        if (solid) Solid(bmp);
        else Tint(bmp);
        return bmp;
    }

    static Bitmap Badge(int size)
    {
        var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using var g = Graphics.FromImage(bmp);
        g.Clear(Color.Transparent);
        g.SmoothingMode = SmoothingMode.None;
        using var blue = new SolidBrush(InkColor);
        using var white = new SolidBrush(Color.White);
        var body = new Rectangle(size * 2 / 16, size / 16, size * 8 / 16, size * 14 / 16);
        g.FillRectangle(blue, body);
        g.FillRectangle(white, new Rectangle(body.X + size / 16, body.Y + size * 2 / 16, Math.Max(1, body.Width - size * 2 / 16), Math.Max(1, body.Height - size * 5 / 16)));
        var mid = size / 2;
        var left = body.Right;
        g.FillRectangle(blue, left, mid - Math.Max(1, size / 16), Math.Max(1, size * 3 / 16), Math.Max(1, size / 8));
        g.FillPolygon(blue, new[]
        {
            new Point(left + size * 2 / 16, mid - size * 3 / 16),
            new Point(size - size / 16, mid),
            new Point(left + size * 2 / 16, mid + size * 3 / 16),
        });
        return bmp;
    }

    static void WriteIco(string path, Bitmap[] frames)
    {
        var pngs = new byte[frames.Length][];
        for (var i = 0; i < frames.Length; i++)
        {
            using var stream = new MemoryStream();
            frames[i].Save(stream, ImageFormat.Png);
            pngs[i] = stream.ToArray();
        }
        using var file = new MemoryStream();
        using (var writer = new BinaryWriter(file))
        {
            writer.Write((ushort)0);
            writer.Write((ushort)1);
            writer.Write((ushort)frames.Length);
            var offset = 6 + 16 * frames.Length;
            for (var i = 0; i < frames.Length; i++)
            {
                var dim = frames[i].Width >= 256 ? 0 : frames[i].Width;
                writer.Write((byte)dim);
                writer.Write((byte)dim);
                writer.Write((byte)0);
                writer.Write((byte)0);
                writer.Write((ushort)1);
                writer.Write((ushort)32);
                writer.Write(pngs[i].Length);
                writer.Write(offset);
                offset += pngs[i].Length;
            }
            foreach (var png in pngs) writer.Write(png);
            writer.Flush();
            var dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            File.WriteAllBytes(path, file.ToArray());
        }
    }

    static void Tint(Bitmap bmp)
    {
        var data = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
        try
        {
            var stride = data.Stride;
            var bytes = new byte[stride * bmp.Height];
            Marshal.Copy(data.Scan0, bytes, 0, bytes.Length);
            for (var y = 0; y < bmp.Height; y++)
            {
                var row = y * stride;
                for (var x = 0; x < bmp.Width; x++)
                {
                    var i = row + x * 4;
                    var alpha = bytes[i + 3];
                    if (alpha <= 8)
                    {
                        bytes[i] = 0;
                        bytes[i + 1] = 0;
                        bytes[i + 2] = 0;
                        bytes[i + 3] = 0;
                        continue;
                    }
                    bytes[i] = InkColor.B;
                    bytes[i + 1] = InkColor.G;
                    bytes[i + 2] = InkColor.R;
                    bytes[i + 3] = alpha;
                }
            }
            Marshal.Copy(bytes, 0, data.Scan0, bytes.Length);
        }
        finally
        {
            bmp.UnlockBits(data);
        }
    }

    static void Solid(Bitmap bmp)
    {
        var data = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
        try
        {
            var stride = data.Stride;
            var bytes = new byte[stride * bmp.Height];
            Marshal.Copy(data.Scan0, bytes, 0, bytes.Length);
            for (var y = 0; y < bmp.Height; y++)
            {
                var row = y * stride;
                for (var x = 0; x < bmp.Width; x++)
                {
                    var i = row + x * 4;
                    if (bytes[i + 3] > 80)
                    {
                        bytes[i] = InkColor.B;
                        bytes[i + 1] = InkColor.G;
                        bytes[i + 2] = InkColor.R;
                        bytes[i + 3] = 255;
                    }
                    else
                    {
                        bytes[i] = 0;
                        bytes[i + 1] = 0;
                        bytes[i + 2] = 0;
                        bytes[i + 3] = 0;
                    }
                }
            }
            Marshal.Copy(bytes, 0, data.Scan0, bytes.Length);
        }
        finally
        {
            bmp.UnlockBits(data);
        }
    }

    static int Opaque(Bitmap bmp)
    {
        var data = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            var stride = data.Stride;
            var bytes = new byte[stride * bmp.Height];
            Marshal.Copy(data.Scan0, bytes, 0, bytes.Length);
            var count = 0;
            for (var i = 3; i < bytes.Length; i += 4)
                if (bytes[i] > 80) count++;
            return count;
        }
        finally
        {
            bmp.UnlockBits(data);
        }
    }

    static Rectangle Ink(Bitmap bmp)
    {
        var data = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            var minX = bmp.Width;
            var minY = bmp.Height;
            var maxX = 0;
            var maxY = 0;
            var stride = data.Stride;
            var bytes = new byte[stride * bmp.Height];
            Marshal.Copy(data.Scan0, bytes, 0, bytes.Length);
            for (var y = 0; y < bmp.Height; y++)
            {
                var row = y * stride;
                for (var x = 0; x < bmp.Width; x++)
                {
                    if (bytes[row + x * 4 + 3] <= 40) continue;
                    if (x < minX) minX = x;
                    if (y < minY) minY = y;
                    if (x > maxX) maxX = x;
                    if (y > maxY) maxY = y;
                }
            }
            if (maxX < minX || maxY < minY) return new Rectangle(0, 0, bmp.Width, bmp.Height);
            return new Rectangle(minX, minY, maxX - minX + 1, maxY - minY + 1);
        }
        finally
        {
            bmp.UnlockBits(data);
        }
    }

    // Bottom-up DIB. A top-down section is what made the shell drop the glyph.
    static IntPtr CreateAlphaIcon(Bitmap src)
    {
        var width = src.Width;
        var height = src.Height;
        var info = new BITMAPINFO();
        info.bmiHeader.biSize = 40;
        info.bmiHeader.biWidth = width;
        info.bmiHeader.biHeight = height;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = 0;
        var hdc = GetDC(IntPtr.Zero);
        var color = CreateDIBSection(hdc, ref info, 0, out var bits, IntPtr.Zero, 0);
        ReleaseDC(IntPtr.Zero, hdc);
        if (color == IntPtr.Zero) throw new Win32Exception();
        var locked = src.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            var stride = locked.Stride;
            var raw = new byte[stride * height];
            Marshal.Copy(locked.Scan0, raw, 0, raw.Length);
            var premul = new byte[width * height * 4];
            for (var y = 0; y < height; y++)
            {
                var srcRow = (height - 1 - y) * stride;
                var dst = y * width * 4;
                for (var x = 0; x < width; x++)
                {
                    var i = srcRow + x * 4;
                    var a = raw[i + 3];
                    premul[dst + x * 4] = (byte)(raw[i] * a / 255);
                    premul[dst + x * 4 + 1] = (byte)(raw[i + 1] * a / 255);
                    premul[dst + x * 4 + 2] = (byte)(raw[i + 2] * a / 255);
                    premul[dst + x * 4 + 3] = a;
                }
            }
            Marshal.Copy(premul, 0, bits, premul.Length);
        }
        finally
        {
            src.UnlockBits(locked);
        }
        var mask = CreateBitmap(width, height, 1, 1, new byte[((width + 31) / 32) * 4 * height]);
        var iconInfo = new ICONINFO { fIcon = 1, hbmMask = mask, hbmColor = color };
        var icon = CreateIconIndirect(ref iconInfo);
        DeleteObject(color);
        DeleteObject(mask);
        if (icon == IntPtr.Zero) throw new Win32Exception();
        return icon;
    }

    public void Dispose()
    {
        _icon?.Dispose();
        if (_handle != IntPtr.Zero) DestroyIcon(_handle);
        if (_stale != IntPtr.Zero) DestroyIcon(_stale);
        _icon = null;
        _handle = IntPtr.Zero;
        _stale = IntPtr.Zero;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ICONINFO
    {
        public int fIcon;
        public int xHotspot;
        public int yHotspot;
        public IntPtr hbmMask;
        public IntPtr hbmColor;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct BITMAPINFOHEADER
    {
        public int biSize;
        public int biWidth;
        public int biHeight;
        public short biPlanes;
        public short biBitCount;
        public int biCompression;
        public int biSizeImage;
        public int biXPelsPerMeter;
        public int biYPelsPerMeter;
        public int biClrUsed;
        public int biClrImportant;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct BITMAPINFO
    {
        public BITMAPINFOHEADER bmiHeader;
        public int bmiColors;
    }

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool DestroyIcon(IntPtr handle);

    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr CreateIconIndirect(ref ICONINFO icon);

    [DllImport("gdi32.dll", SetLastError = true)]
    static extern IntPtr CreateDIBSection(IntPtr hdc, ref BITMAPINFO pbmi, uint usage, out IntPtr bits, IntPtr section, uint offset);

    [DllImport("gdi32.dll")]
    static extern IntPtr CreateBitmap(int width, int height, uint planes, uint bitCount, byte[] bits);

    [DllImport("gdi32.dll")]
    static extern bool DeleteObject(IntPtr ho);

    [DllImport("user32.dll")]
    static extern IntPtr GetDC(IntPtr hwnd);

    [DllImport("user32.dll")]
    static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);
}
