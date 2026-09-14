"""Run the shipped Swift traversal against synthetic accessibility graphs."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


@unittest.skipUnless(sys.platform == "darwin", "Swift Accessibility types require macOS")
class MessageDeleteSwiftTests(unittest.TestCase):
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
