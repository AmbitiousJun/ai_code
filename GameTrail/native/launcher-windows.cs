using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Windows.Forms;

internal static class Launcher
{
    [STAThread]
    private static int Main()
    {
        string runtime = Path.Combine(Path.GetTempPath(), "GameTrail-" + Guid.NewGuid().ToString("N"));
        try
        {
            Directory.CreateDirectory(runtime);
            using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("runtime.zip"))
            using (var archive = new ZipArchive(stream, ZipArchiveMode.Read))
            {
                archive.ExtractToDirectory(runtime);
            }
            var start = new ProcessStartInfo(Path.Combine(runtime, "node.exe"), "src/server.js")
            {
                WorkingDirectory = runtime,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardError = true
            };
            using (var server = Process.Start(start))
            {
                string error = server.StandardError.ReadToEnd();
                server.WaitForExit();
                if (server.ExitCode == 1 && error.Contains("该数据目录已有 GameTrail 进程"))
                    return 0;
                if (server.ExitCode != 0)
                    throw new Exception(error.Trim().Length > 0 ? error.Trim() : "GameTrail 服务启动失败。");
            }
            return 0;
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "GameTrail", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        finally
        {
            try { Directory.Delete(runtime, true); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }
}
