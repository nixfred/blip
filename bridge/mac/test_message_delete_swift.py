"""Run the shipped Swift traversal against synthetic accessibility graphs."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


@unittest.skipUnless(sys.platform == "darwin", "Swift Accessibility types require macOS")
class MessageDeleteSwiftTests(unittest.TestCase):
    def test_closed_locked_and_non_english_messages_refuse_without_delete(self):
        source = Path(__file__).with_name("message-delete.swift").read_text().split("\ndo {\n", 1)[0]
        start = source.index("    var value: CFTypeRef?")
        end = source.index("\n}\nfunc string", start)
        source = source[:start] + '    fixtureAttribute(element, name)' + source[end:]
        start = source.index("    var names: CFArray?")
        end = source.index("\n}\nfunc selected", start)
        source = source[:start] + '    fixtureActions(element)' + source[end:]
        source = source.replace("AXIsProcessTrusted()", "fixtureTrusted")
        source = source.replace('guard let process = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.MobileSMS").first else {', 'guard fixtureRunning else {')
        source = source.replace('let app = AXUIElementCreateApplication(process.processIdentifier)', 'let app = fixtureNodes[0]')
        source = source.replace('AXUIElementSetMessagingTimeout(app, 2)', '')
        source = source.replace('AXUIElementPerformAction(', 'fixturePerform(')
        source = source.replace('NSWorkspace.shared.open(url)', 'fixtureOpen(url)')
        for delay in ['0.15', '0.1']:
            source = source.replace('Thread.sleep(forTimeInterval: ' + delay + ')', '')
        harness = r'''
let fixtureNodes = (0..<5).map { AXUIElementCreateApplication(pid_t(100000 + $0)) }
var fixtureTrusted = true, fixtureRunning = true, fixtureLocked = false, fixtureOpened = false
var fixtureLanguage = "English", fixturePresses = 0, fixtureDeletes = 0
func fixtureIndex(_ element: AXUIElement) -> Int { fixtureNodes.firstIndex { CFEqual($0, element) }! }
func fixtureAttribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    let index = fixtureIndex(element)
    if name == "AXChildren" {
        if fixtureLocked { return [fixtureNodes[0]] as CFArray }
        let graph = [0:[1,2], 2:[3], 3:[4]]
        return (graph[index] ?? []).map { fixtureNodes[$0] } as CFArray
    }
    if name == "AXIdentifier" { return ([1:"messageBodyField",2:"TranscriptCollectionView",4:"CKBalloonTextView"][index] ?? "") as CFString }
    if name == "AXSelected" { return NSNumber(value: index == 3 && fixtureOpened) }
    if name == "AXValue" && index == 4 { return "Synthetic message" as CFString }
    return nil
}
func fixtureActions(_ element: AXUIElement) -> [String] {
    guard fixtureIndex(element) == 3 else { return [] }
    return [fixtureLanguage == "English" ? "Name:Delete…\nTarget:0" : "Name:Supprimer…\nTarget:0"]
}
func fixturePerform(_ element: AXUIElement, _ action: CFString) -> AXError {
    if fixtureIndex(element) == 1 && action as String == "AXPress" { fixturePresses += 1; return .success }
    fixtureDeletes += 1
    return .success
}
func fixtureOpen(_ url: URL) -> Bool { fixtureOpened = true; return true }
let request = Request(guid:"11111111-2222-4333-8444-555555555555", text:"Synthetic message", attachments:0)
func refusal(_ expected: String) {
    do { try perform(request); print("unexpected success"); exit(1) }
    catch Failure.reason(let code) { if code != expected { print("wrong refusal: \(code)"); exit(1) } }
    catch { print("unexpected failure"); exit(1) }
    if fixtureDeletes != 0 { print("destructive action attempted"); exit(1) }
}
fixtureRunning = false; refusal("unavailable")
fixtureRunning = true; fixtureLocked = true; refusal("selection")
fixtureLocked = false; fixtureLanguage = "French"; refusal("selection")
if fixturePresses != 1 { print("unexpected composer actions"); exit(1) }
fixtureTrusted = false; refusal("permission")
print("Closed, locked, non-English, and denied permission all refused without deletion")
'''
        with tempfile.TemporaryDirectory(prefix="blip-delete-refusal-") as directory:
            script = Path(directory) / "probe.swift"
            script.write_text(source + harness)
            result = subprocess.run(["/usr/bin/swift", str(script)], capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        print(result.stdout.strip())

    def test_cycles_shared_children_and_limits(self):
        source = Path(__file__).with_name("message-delete.swift").read_text().split("\ndo {\n", 1)[0]
        # Replace only the AX child lookup. No live application is inspected or acted on.
        original = 'attribute(element, "AXChildren") as? [AXUIElement] ?? []'
        self.assertEqual(source.count(original), 1)
        source = source.replace(original, "fixtureChildren(element)")
        harness = r'''
let nodes = (0..<2100).map { AXUIElementCreateApplication(pid_t(100000 + $0)) }
var graph = [Int: [Int]]()
func fixtureChildren(_ element: AXUIElement) -> [AXUIElement] {
    let index = nodes.firstIndex { CFEqual($0, element) }!
    return (graph[index] ?? []).map { nodes[$0] }
}
func check(_ condition: Bool, _ message: String) {
    if !condition { print(message); exit(1) }
}
func refuses(_ message: String) {
    do { _ = try descendants(nodes[0]); check(false, message) }
    catch Failure.reason(let code) { check(code == "unsupported", "wrong limit error") }
    catch { check(false, "unexpected error") }
}
// A locked desktop can expose the application as its own child.
graph = [0: [0, 1], 1: [2], 2: [1]]
do { check(try descendants(nodes[0]).count == 3, "cycle visits each element once") }
catch { print("cycle incorrectly refused: \(error)"); exit(1) }
graph = [0: [1, 2], 1: [3], 2: [3]]
check(try descendants(nodes[0]).count == 4, "shared children appear once")
graph = [0: Array(1..<2000)]
check(try descendants(nodes[0]).count == 2000, "exact node bound is accepted")
graph = [0: Array(1..<2001)]
refuses("over-limit graph was accepted")
graph = Dictionary(uniqueKeysWithValues: (0..<31).map { ($0, [$0 + 1]) })
refuses("over-depth graph was accepted")
print("Swift traversal: cycle, shared child, node and depth bounds passed")
'''
        with tempfile.TemporaryDirectory(prefix="blip-delete-swift-") as directory:
            script = Path(directory) / "probe.swift"
            script.write_text(source + harness)
            result = subprocess.run(["/usr/bin/swift", str(script)], capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        print(result.stdout.strip())


if __name__ == "__main__":
    unittest.main()
