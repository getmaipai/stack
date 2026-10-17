// personmask <in> <labels.png> (IMGEDIT-01): Apple Vision person instance mask (macOS 14+). Writes an 8-bit PNG, 0 = background, 1..N = person N,
// and prints one JSON line per person: {"id":1,"x":0.1,"y":0.2,"w":0.3,"h":0.5,"area":0.08} (normalised, origin top-left).
import Foundation
import Vision
import CoreImage
import ImageIO
import UniformTypeIdentifiers
let a = CommandLine.arguments
guard a.count >= 3 else { exit(2) }
guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: a[1]) as CFURL, nil), let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) else { exit(3) }
let h = VNImageRequestHandler(cgImage: cg, options: [:])
let req = VNGeneratePersonInstanceMaskRequest()
do { try h.perform([req]) } catch { exit(4) }
guard let obs = req.results?.first, obs.allInstances.count > 0 else { print("[]"); exit(5) }
let pb = obs.instanceMask
CVPixelBufferLockBaseAddress(pb, .readOnly)
let w = CVPixelBufferGetWidth(pb), hh = CVPixelBufferGetHeight(pb), bpr = CVPixelBufferGetBytesPerRow(pb)
let base = CVPixelBufferGetBaseAddress(pb)!.assumingMemoryBound(to: UInt8.self)
var data = [UInt8](repeating: 0, count: w * hh)
var minx = [Int: Int](), maxx = [Int: Int](), miny = [Int: Int](), maxy = [Int: Int](), cnt = [Int: Int]()
for y in 0..<hh { for x in 0..<w {
    let v = Int(base[y * bpr + x]); data[y * w + x] = UInt8(v)
    if v > 0 { cnt[v, default: 0] += 1; minx[v] = min(minx[v] ?? x, x); maxx[v] = max(maxx[v] ?? x, x); miny[v] = min(miny[v] ?? y, y); maxy[v] = max(maxy[v] ?? y, y) }
} }
CVPixelBufferUnlockBaseAddress(pb, .readOnly)
let cs = CGColorSpaceCreateDeviceGray()
let prov = CGDataProvider(data: Data(data) as CFData)!
let img = CGImage(width: w, height: hh, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: w, space: cs, bitmapInfo: CGBitmapInfo(rawValue: 0), provider: prov, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
let dst = CGImageDestinationCreateWithURL(URL(fileURLWithPath: a[2]) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dst, img, nil); _ = CGImageDestinationFinalize(dst)
for id in cnt.keys.sorted() {
    print("{\"id\":\(id),\"x\":\(Double(minx[id]!)/Double(w)),\"y\":\(Double(miny[id]!)/Double(hh)),\"w\":\(Double(maxx[id]! - minx[id]! + 1)/Double(w)),\"h\":\(Double(maxy[id]! - miny[id]! + 1)/Double(hh)),\"area\":\(Double(cnt[id]!)/Double(w*hh))}")
}
