// subjectmask <in> <labels.png> (IMG-OPS-07): Vision foreground instances with person/animal classification.
import Foundation
import Vision
import CoreImage
import ImageIO
import UniformTypeIdentifiers
let a = CommandLine.arguments
guard a.count >= 3 else { exit(2) }
guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: a[1]) as CFURL, nil), let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) else { exit(3) }
let h = VNImageRequestHandler(cgImage: cg, options: [:])
let foreground = VNGenerateForegroundInstanceMaskRequest()
let people = VNGeneratePersonInstanceMaskRequest()
let animals = VNRecognizeAnimalsRequest()
animals.usesCPUOnly = true
// Run instance segmentation first; classification requests are best effort and never prevent returning object instances.
do { try h.perform([foreground, people, animals]) } catch { exit(4) }
guard let obs = foreground.results?.first, obs.allInstances.count > 0 else { print("[]"); exit(5) }
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
func boxes(_ rects: [CGRect]) -> [(Int, Int, Int, Int)] { rects.map { r in (max(0, Int(r.minX * CGFloat(w))), max(0, Int((1-r.maxY) * CGFloat(hh))), min(w, Int(ceil(r.maxX * CGFloat(w)))), min(hh, Int(ceil((1-r.minY) * CGFloat(hh))))) } }
let personLabels = people.results?.first.map { obs -> [UInt8] in
    let mask = obs.instanceMask
    CVPixelBufferLockBaseAddress(mask, .readOnly)
    let mw = CVPixelBufferGetWidth(mask), mh = CVPixelBufferGetHeight(mask), stride = CVPixelBufferGetBytesPerRow(mask)
    let ptr = CVPixelBufferGetBaseAddress(mask)!.assumingMemoryBound(to: UInt8.self)
    var result = [UInt8](repeating: 0, count: w * hh)
    for y in 0..<hh { for x in 0..<w {
        let sx = min(mw-1, x * mw / w), sy = min(mh-1, y * mh / hh)
        if ptr[sy * stride + sx] > 0 { result[y * w + x] = 1 }
    } }
    CVPixelBufferUnlockBaseAddress(mask, .readOnly)
    return result
} ?? []
let animalRects = boxes((animals.results ?? []).map { $0.boundingBox })
let cs = CGColorSpaceCreateDeviceGray()
let prov = CGDataProvider(data: Data(data) as CFData)!
let img = CGImage(width: w, height: hh, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: w, space: cs, bitmapInfo: CGBitmapInfo(rawValue: 0), provider: prov, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
let dst = CGImageDestinationCreateWithURL(URL(fileURLWithPath: a[2]) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dst, img, nil); _ = CGImageDestinationFinalize(dst)
func overlap(_ id: Int, _ rect: (Int,Int,Int,Int)) -> Int { var n = 0; for y in max(miny[id]!, rect.1)..<min(maxy[id]!+1, rect.3) { for x in max(minx[id]!, rect.0)..<min(maxx[id]!+1, rect.2) where Int(data[y * w + x]) == id { n += 1 } }; return n }
func personOverlap(_ id: Int) -> Int { var n = 0; for y in miny[id]!..<maxy[id]!+1 { for x in minx[id]!..<maxx[id]!+1 where Int(data[y * w + x]) == id && personLabels[y * w + x] > 0 { n += 1 } }; return n }
for id in cnt.keys.sorted() {
    let r = (minx[id]!, miny[id]!, maxx[id]!+1, maxy[id]!+1)
    let area = max(1, (r.2-r.0)*(r.3-r.1))
    let pc = personOverlap(id)
    let ac = animalRects.map { overlap(id, $0) }.max() ?? 0
    let kind = pc * 4 >= area ? "person" : (ac * 4 >= area ? "animal" : "object")
    print("{\"id\":\(id),\"kind\":\"\(kind)\",\"x\":\(Double(r.0)/Double(w)),\"y\":\(Double(r.1)/Double(hh)),\"w\":\(Double(r.2-r.0)/Double(w)),\"h\":\(Double(r.3-r.1)/Double(hh)),\"area\":\(Double(cnt[id]!)/Double(w*hh))}")
}

