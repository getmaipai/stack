// facefind <in> (TALK-06): Apple Vision face rectangles, printed as one JSON line:
// {"width":W,"height":H,"faces":[{"x":..,"y":..,"w":..,"h":..},...]} in pixels of the oriented picture, origin top left, largest face first.
// This is the licence-clean replacement for the face finder LivePortrait ships (a non-commercial research model the Stack never installs):
// a system API, no model file, on-device, no network.
// Exit codes: 2 usage, 3 unreadable image, 4 Vision failed. No face is not an error: the list is empty.
import Foundation
import Vision
import ImageIO

let args = CommandLine.arguments
guard args.count >= 2 else { FileHandle.standardError.write(Data("usage: facefind in\n".utf8)); exit(2) }
let url = URL(fileURLWithPath: args[1])
guard let src = CGImageSourceCreateWithURL(url as CFURL, nil), let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
    FileHandle.standardError.write(Data("cannot read image\n".utf8)); exit(3) }
let width = Double(cg.width), height = Double(cg.height)
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
let req = VNDetectFaceRectanglesRequest()
do { try handler.perform([req]) } catch { FileHandle.standardError.write(Data("vision failed: \(error)\n".utf8)); exit(4) }
var faces: [[String: Double]] = []
for obs in (req.results ?? []).sorted(by: { $0.boundingBox.width * $0.boundingBox.height > $1.boundingBox.width * $1.boundingBox.height }) {
    let b = obs.boundingBox  // normalised, origin bottom left
    faces.append(["x": b.minX * width, "y": (1.0 - b.maxY) * height, "w": b.width * width, "h": b.height * height])
}
let out: [String: Any] = ["width": width, "height": height, "faces": faces]
if let data = try? JSONSerialization.data(withJSONObject: out), let text = String(data: data, encoding: .utf8) { print(text) } else { exit(4) }
