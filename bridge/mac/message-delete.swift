import AppKit
import ApplicationServices
import Foundation

// Content arrives on stdin and never enters arguments, logs, or persistent state.
struct Request: Decodable { let guid: String; let text: String; let attachments: Int }
enum Failure: Error { case reason(String) }
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func string(_ element: AXUIElement, _ name: String) -> String {
    attribute(element, name) as? String ?? ""
}
func children(_ element: AXUIElement) -> [AXUIElement] {
    attribute(element, "AXChildren") as? [AXUIElement] ?? []
}
func descendants(_ root: AXUIElement) throws -> [AXUIElement] {
    var result = [AXUIElement](), queue = [(root, 0)], index = 0
    var callbacks = kCFTypeSetCallBacks
    let visited = CFSetCreateMutable(nil, 0, &callbacks)!
    while index < queue.count {
        let (element, depth) = queue[index]; index += 1
        // A locked desktop can expose the application as its own child.
        // Deduplicate by AX identity, preserving the bounds on distinct nodes.
        let pointer = Unmanaged.passUnretained(element).toOpaque()
        if CFSetContainsValue(visited, pointer) { continue }
        if result.count >= 2000 || depth > 30 { throw Failure.reason("unsupported") }
        CFSetAddValue(visited, pointer)
        result.append(element)
        queue.append(contentsOf: children(element).map { ($0, depth+1) })
    }
    return result
}
func actions(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
    return names as? [String] ?? []
}
func selected(_ element: AXUIElement) -> Bool {
    (attribute(element, "AXSelected") as? NSNumber)?.boolValue == true
}
func normalized(_ value: String) -> String {
    value.replacingOccurrences(of: "\u{fffc}", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
}
func deleteAction(_ element: AXUIElement) -> String? {
    // Custom action names are localized by Messages. Unknown locales fail closed.
    let found = actions(element).filter { $0.hasPrefix("Name:Delete…\n") || $0.hasPrefix("Name:Delete...\n") }
    return found.count == 1 ? found[0] : nil
}
func transcript(_ app: AXUIElement) throws -> AXUIElement {
    let found = try descendants(app).filter { string($0, "AXIdentifier") == "TranscriptCollectionView" }
    guard found.count == 1 else { throw Failure.reason("selection") }
    return found[0]
}
func selection(_ app: AXUIElement, _ request: Request) throws -> AXUIElement {
    let entries = try descendants(transcript(app)).filter { selected($0) && deleteAction($0) != nil }
    // Some releases expose the selected state on both the balloon and its text.
    let outer = entries.filter { candidate in
        !entries.contains { other in
            !CFEqual(candidate, other) && ((try? descendants(other).dropFirst().contains { CFEqual($0, candidate) }) ?? false)
        }
    }
    guard outer.count == 1 else { throw Failure.reason("selection") }
    let target = outer[0]
    let texts = try descendants(target).filter { string($0, "AXIdentifier") == "CKBalloonTextView" }
        .map { normalized(string($0, "AXValue")) }.filter { !$0.isEmpty }
    let expected = normalized(request.text)
    guard expected.isEmpty ? (request.attachments > 0 && texts.isEmpty) : texts == [expected] else {
        throw Failure.reason("selection")
    }
    return target
}
func perform(_ request: Request) throws {
    guard AXIsProcessTrusted() else { throw Failure.reason("permission") }
    guard request.guid.range(of: "^[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$", options: .regularExpression) != nil,
          request.text.utf8.count <= 96*1024, request.attachments >= 0 else { throw Failure.reason("invalid") }
    guard let process = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.MobileSMS").first else {
        throw Failure.reason("unavailable")
    }
    let app = AXUIElementCreateApplication(process.processIdentifier)
    AXUIElementSetMessagingTimeout(app, 2)
    let before = try descendants(app)
    guard !before.contains(where: { string($0, "AXRole") == "AXSheet" }) else { throw Failure.reason("busy") }
    // Focus the empty-or-drafted composer without changing its value. Verify the
    // previous selection cleared, so an unsupported link cannot delete a stale one.
    let composers = before.filter { string($0, "AXIdentifier") == "messageBodyField" }
    guard composers.count == 1,
          AXUIElementPerformAction(composers[0], "AXPress" as CFString) == .success else { throw Failure.reason("selection") }
    Thread.sleep(forTimeInterval: 0.15)
    guard try !descendants(transcript(app)).contains(where: { selected($0) && deleteAction($0) != nil }) else {
        throw Failure.reason("selection")
    }
    var link = URLComponents()
    link.scheme = "sms"; link.host = "open"
    link.queryItems = [URLQueryItem(name: "message-guid", value: request.guid)]
    guard let url = link.url, NSWorkspace.shared.open(url) else { throw Failure.reason("selection") }
    var item: AXUIElement?
    for _ in 0..<30 {
        if let candidate = try? selection(app, request) { item = candidate; break }
        Thread.sleep(forTimeInterval: 0.1)
    }
    guard let item = item, let action = deleteAction(item),
          let current = try? selection(app, request), CFEqual(current, item) else { throw Failure.reason("selection") }
    guard AXUIElementPerformAction(item, action as CFString) == .success else { throw Failure.reason("unverified") }
    // Messages may delete immediately, show a confirmation, or explain Recently
    // Deleted on first use. The caller verifies the exact row after this action.
    for _ in 0..<30 {
        let sheets = try descendants(app).filter { string($0, "AXRole") == "AXSheet" }
        if sheets.count == 1 {
            let elements = try descendants(sheets[0])
            let buttons = elements.filter { string($0, "AXRole") == "AXButton" }
            let deleteButtons = buttons.filter { string($0, "AXTitle") == "Delete" }
            let cancelButtons = buttons.filter { string($0, "AXTitle") == "Cancel" }
            let notice = elements.contains {
                string($0, "AXRole") == "AXStaticText" &&
                string($0, "AXValue").replacingOccurrences(of: "\u{00a0}", with: " ") ==
                    "Deleted messages are moved to Recently Deleted."
            }
            if notice && buttons.count == 1 && string(buttons[0], "AXTitle") == "OK" {
                guard AXUIElementPerformAction(buttons[0], "AXPress" as CFString) == .success else {
                    throw Failure.reason("unverified")
                }
                return
            }
            guard deleteButtons.count == 1, cancelButtons.count == 1, buttons.count == 2 else {
                throw Failure.reason("unverified")
            }
            guard AXUIElementPerformAction(deleteButtons[0], "AXPress" as CFString) == .success else {
                throw Failure.reason("unverified")
            }
            return
        }
        if sheets.count > 1 { throw Failure.reason("unverified") }
        Thread.sleep(forTimeInterval: 0.1)
    }
    // No dialog is normal after the first-use notice has been acknowledged.
    // This reports only that the action ran, never that deletion was verified.
    return
}
do {
    let data = FileHandle.standardInput.readData(ofLength: 128*1024+1)
    guard data.count <= 128*1024 else { throw Failure.reason("invalid") }
    let request = try JSONDecoder().decode(Request.self, from: data)
    try perform(request)
    print("{\"ok\":true}")
} catch Failure.reason(let code) {
    print("{\"ok\":false,\"code\":\"\(code)\"}")
} catch {
    print("{\"ok\":false,\"code\":\"unverified\"}")
}
