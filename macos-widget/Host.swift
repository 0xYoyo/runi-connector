import AppKit
import WidgetKit

final class HostDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    DispatchQueue.global(qos: .utility).async {
      _ = CourseHost.refresh()
      DispatchQueue.main.async { NSApp.terminate(nil) }
    }
  }
  func application(_ application: NSApplication, open urls: [URL]) {
    for url in urls where url.scheme == "https" && url.host == "moodle.runi.ac.il" {
      NSWorkspace.shared.open(url)
    }
  }
}
@main
struct CourseHost {
  static func refresh() -> Bool {
    guard let script = Bundle.main.url(forResource: "refresh", withExtension: "py") else {
      return false
    }
    let proc = Process()
    let pipe = Pipe()
    proc.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
    proc.arguments = [script.path]
    proc.standardOutput = pipe
    proc.standardError = FileHandle.nullDevice
    do {
      try proc.run()
      let data = pipe.fileHandleForReading.readDataToEndOfFile()
      proc.waitUntilExit()
      guard proc.terminationStatus == 0 else { return false }
      let snap = try JSONDecoder().decode(Summary.self, from: data)
      let folder = Summary.file.deletingLastPathComponent()
      try FileManager.default.createDirectory(
        at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      try JSONEncoder().encode(snap).write(to: Summary.file, options: .atomic)
      WidgetCenter.shared.reloadTimelines(ofKind: widgetKind)
      return true
    } catch { return false }
  }
  static func main() {
    // A user opening the containing app can refresh even before adding a widget.
    if !CommandLine.arguments.contains("--if-added") {
      let application = NSApplication.shared
      let delegate = HostDelegate()
      application.delegate = delegate
      application.setActivationPolicy(.accessory)
      withExtendedLifetime(delegate) { application.run() }
      return
    }
    WidgetCenter.shared.getCurrentConfigurations { result in
      switch result {
      case .success(let widgets):
        if widgets.contains(where: { $0.kind == widgetKind }) {
          DispatchQueue.global().async { exit(refresh() ? 0 : 1) }
        } else {
          exit(0)
        }
      case .failure: exit(1)
      }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 200) { exit(1) }
    dispatchMain()
  }
}
