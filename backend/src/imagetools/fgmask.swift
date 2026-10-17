// fgmask <in> <out.png> (IMAGETOOLS-01): Apple Vision foreground instance mask, written as an RGBA PNG with a transparent background.
// Exit codes: 2 usage, 3 unreadable image, 4 Vision failed, 5 no foreground found, 6 to 9 encode failures. On-device only; no network.
import Foundation
import Vision
import CoreImage
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count >= 3 else { FileHandle.standardError.write(Data("usage: fgmask in out.png\n".utf8)); exit(2) }
let url = URL(fileURLWithPath: args[1])
guard let src = CGImageSourceCreateWithURL(url as CFURL, nil), let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
    FileHandle.standardError.write(Data("cannot read image\n".utf8)); exit(3) }
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
let req = VNGenerateForegroundInstanceMaskRequest()
do { try handler.perform([req]) } catch { FileHandle.standardError.write(Data("vision failed: \(error)\n".utf8)); exit(4) }
guard let obs = req.results?.first else { FileHandle.standardError.write(Data("no foreground found\n".utf8)); exit(5) }
do {
    let buf = try obs.generateMaskedImage(ofInstances: obs.allInstances, from: handler, croppedToInstancesExtent: false)
    let ci = CIImage(cvPixelBuffer: buf)
    let ctx = CIContext()
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    guard let out = ctx.createCGImage(ci, from: ci.extent, format: .RGBA8, colorSpace: space) else { exit(6) }
    guard let dst = CGImageDestinationCreateWithURL(URL(fileURLWithPath: args[2]) as CFURL, UTType.png.identifier as CFString, 1, nil) else { exit(7) }
    CGImageDestinationAddImage(dst, out, nil)
    if !CGImageDestinationFinalize(dst) { exit(8) }
} catch { FileHandle.standardError.write(Data("mask failed: \(error)\n".utf8)); exit(9) }
