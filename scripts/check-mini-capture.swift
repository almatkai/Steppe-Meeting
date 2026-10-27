// Native smoke test: xcrun swift scripts/check-mini-capture.swift --pid <app-pid>
// Run while the overlay is visible locally and capture protection is enabled.
// Compare unfiltered ScreenCaptureKit capture with explicit app exclusion.
// Screenshots stay in memory: nothing is saved, logged, or uploaded.
import Cocoa
import ScreenCaptureKit
import CoreGraphics

func fail(_ message: String) -> Never {
    fputs("FAIL: \(message)\n", stderr)
    exit(1)
}

@MainActor
func check() async {
    let args = CommandLine.arguments
    guard (args.count == 3 || (args.count == 4 && args[3] == "--visible")), args[1] == "--pid", let pid = Int32(args[2]) else {
        fail("Usage: xcrun swift scripts/check-mini-capture.swift --pid <app-pid> [--visible]")
    }
    let protected = args.count == 3
    do {
        let info = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] ?? []
        let records = info.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid && ($0[kCGWindowLayer as String] as? Int ?? 0) >= 0 }
        guard !records.isEmpty else { fail("No on-screen app window; show Mini first.") }
        for record in records {
            guard let sharing = record[kCGWindowSharingState as String] as? Int, (sharing == 0) == protected else {
                fail("App window \(record[kCGWindowNumber as String] ?? "?") does not match expected capture protection.")
            }
        }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let app = content.applications.first(where: { $0.processID == pid }),
              let window = content.windows.first(where: { $0.owningApplication?.processID == pid && $0.frame.width > 100 && $0.frame.height > 50 }),
              let display = content.displays.first(where: { $0.frame.contains(CGPoint(x: window.frame.midX, y: window.frame.midY)) }) else {
            fail("Unable to locate app window/display in ScreenCaptureKit.")
        }
        let config = SCStreamConfiguration()
        let width = Int(window.frame.width), height = Int(window.frame.height)
        config.width = width; config.height = height; config.showsCursor = false
        config.sourceRect = CGRect(x: window.frame.minX - display.frame.minX, y: window.frame.minY - display.frame.minY, width: window.frame.width, height: window.frame.height)
        func pixels(_ filter: SCContentFilter) async throws -> [UInt8] {
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            var bytes = [UInt8](repeating: 0, count: width * height * 4)
            let ok = bytes.withUnsafeMutableBytes { data -> Bool in
                guard let ctx = CGContext(data: data.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
                ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
                return true
            }
            guard ok else { fail("Unable to compare pixels.") }
            return bytes
        }
        let unfiltered = try await pixels(SCContentFilter(display: display, excludingWindows: []))
        let excluded = try await pixels(SCContentFilter(display: display, excludingApplications: [app], exceptingWindows: []))
        let meanDifference = zip(unfiltered, excluded).reduce(0.0) { $0 + Double(abs(Int($1.0) - Int($1.1))) } / Double(unfiltered.count)
        guard protected ? meanDifference < 1.0 : meanDifference >= 1.0 else { fail("Unexpected capture pixels (difference \(meanDifference)); keep underlying content static and retry.") }
        print("PASS: protection=\(protected); full Mini capture pixel difference from explicit exclusion = \(meanDifference).")
        print("This verifies this capture API on this OS, not every third-party recorder.")
        exit(0)
    } catch { fail("Capture unavailable: \(error)") }
}
Task { @MainActor in await check() }
RunLoop.main.run()
