import AppKit

final class Launcher: NSObject, NSApplicationDelegate {
    private let server = Process()

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let resources = Bundle.main.resourceURL else {
            NSApp.terminate(nil)
            return
        }
        server.executableURL = resources.appendingPathComponent("node")
        server.currentDirectoryURL = resources
        server.arguments = ["src/server.js"]
        server.terminationHandler = { _ in
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
        do {
            try server.run()
        } catch {
            NSAlert(error: error).runModal()
            NSApp.terminate(nil)
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        let env = ProcessInfo.processInfo.environment
        guard server.isRunning, env["GAMETRAIL_NO_OPEN"] == nil else { return false }
        let root = env["GAMETRAIL_DATA"].map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("GameTrail")
        if let value = try? String(contentsOf: root.appendingPathComponent("address"), encoding: .utf8),
           value.range(of: #"^http://127\.0\.0\.1:[0-9]+$"#, options: .regularExpression) != nil,
           let url = URL(string: value) {
            NSWorkspace.shared.open(url)
        }
        return false
    }

    func applicationWillTerminate(_ notification: Notification) {
        if server.isRunning { server.terminate() }
    }
}

let delegate = Launcher()
let application = NSApplication.shared
application.delegate = delegate
application.run()
