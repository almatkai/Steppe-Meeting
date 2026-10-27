// macOS native regression test. Requires a running Steppe desktop app,
// Accessibility permission for the terminal, and Xcode Command Line Tools.
// Run: node tests/native-mini-window-smoke.mjs
// Exercises the actual WebView buttons and native windows, not browser mocks.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

assert.equal(process.platform, "darwin", "This native UI test requires macOS");
const temporary = mkdtempSync(join(tmpdir(), "steppe-native-test-"));
const apple = (body) => execFileSync("osascript", ["-e", `
  tell application "System Events"
    tell process "steppe-desktop"
      ${body}
    end tell
  end tell
`], { encoding: "utf8", timeout: 15000 }).trim();
const windows = () => apple("return name of every window");
const click = (windowTitle, buttonName) => apple(`
  set frontmost to true
  set elements to entire contents of window "${windowTitle}"
  set clicked to false
  repeat with el in elements
    try
      if role of el is "AXButton" and name of el is "${buttonName}" then
        perform action "AXPress" of el
        set clicked to true
        exit repeat
      end if
    end try
  end repeat
  if not clicked then error "Button not found: ${buttonName}"
  delay 1
`);
const position = () => apple('return position of window "Steppe Mini"')
  .split(", ").map(Number);

try {
  if (!windows().includes("Steppe Meeting")) {
    click("Steppe Mini", "Развернуть основное окно");
  }
  click("Steppe Meeting", "Mini Mode");
  assert.ok(!windows().includes("Steppe Meeting"), "Main must be hidden, not covered by an HTML panel");
  assert.ok(windows().includes("Steppe Mini"), "A separate native mini window must be visible");
  const [width, height] = apple('return size of window "Steppe Mini"').split(", ").map(Number);
  assert.ok(width <= 600 && height <= 160, `Not compact: ${width}×${height}`);

  const grip = apple(`
    set elements to entire contents of window "Steppe Mini"
    repeat with el in elements
      if role of el is "AXButton" and name of el is "Перетащить мини-окно" then
        set p to position of el
        return p
      end if
    end repeat
    error "Drag grip not found"
  `).split(", ").map(Number);
  const before = position();
  const swift = join(temporary, "drag.swift");
  writeFileSync(swift, `
    import CoreGraphics
    import Foundation
    let x = Double(CommandLine.arguments[1])!
    let y = Double(CommandLine.arguments[2])!
    let source = CGEventSource(stateID: .combinedSessionState)!
    func mouse(_ type: CGEventType, _ x: Double, _ y: Double) {
      CGEvent(mouseEventSource: source, mouseType: type,
        mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)!
        .post(tap: .cghidEventTap)
    }
    mouse(.mouseMoved, x, y)
    Thread.sleep(forTimeInterval: 0.1)
    mouse(.leftMouseDown, x, y)
    Thread.sleep(forTimeInterval: 0.25)
    for i in 1...20 {
      mouse(.leftMouseDragged, x + Double(i) * 8, y + Double(i) * 4)
      Thread.sleep(forTimeInterval: 0.02)
    }
    mouse(.leftMouseUp, x + 160, y + 80)
    Thread.sleep(forTimeInterval: 0.3)
  `);
  execFileSync("swift", [swift, String(grip[0] + 8), String(grip[1] + 12)], { timeout: 60000 });
  const after = position();
  assert.ok(Math.abs(after[0] - before[0] - 160) <= 2 && Math.abs(after[1] - before[1] - 80) <= 2,
    `Drag did not move the native window: ${before} → ${after}`);
  console.log(`PASS: separate compact window; main hidden; drag ${before} → ${after}`);

  click("Steppe Mini", "Развернуть основное окно");
  assert.ok(windows().includes("Steppe Meeting"), "Restore must show main");
  assert.ok(!windows().includes("Steppe Mini"), "Restore must hide mini");
  click("Steppe Meeting", "Mini Mode");
  assert.ok(!windows().includes("Steppe Meeting"), "Reopening must hide main again");
  assert.deepEqual(position(), after, "Reopening should keep the dragged position");
  click("Steppe Mini", "Развернуть основное окно");
  console.log("PASS: restore main and reopen mini; position preserved");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
