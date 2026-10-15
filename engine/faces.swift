// faces <proxy.mp4> <out.jsonl>
// Reads every frame of a (low-fps, small) proxy, runs Apple Vision face landmarks,
// writes one JSON line per frame: {"t":sec,"f":[[x,y,w,h,mouthIn,mouthOut,yaw,conf],...]}
// x,y,w,h normalized, origin top-left. mouthIn/Out = inner/outer lip height / face height.
import Foundation
import AVFoundation
import Vision

let args = CommandLine.arguments
let url = URL(fileURLWithPath: args[1])
let asset = AVURLAsset(url: url)
guard let track = asset.tracks(withMediaType: .video).first else { print("no video"); exit(1) }
let reader = try! AVAssetReader(asset: asset)
let out = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
reader.add(out)
reader.startReading()
FileManager.default.createFile(atPath: args[2], contents: nil)
let fh = FileHandle(forWritingAtPath: args[2])!

func span(_ r: VNFaceLandmarkRegion2D?) -> Double {
    guard let r = r, r.pointCount > 0 else { return -1 }
    let ys = r.normalizedPoints.map { Double($0.y) }
    return ys.max()! - ys.min()!
}
while let sb = out.copyNextSampleBuffer() {
    guard let pb = CMSampleBufferGetImageBuffer(sb) else { continue }
    let t = CMSampleBufferGetPresentationTimeStamp(sb).seconds
    let req = VNDetectFaceLandmarksRequest()
    try? VNImageRequestHandler(cvPixelBuffer: pb, options: [:]).perform([req])
    var faces: [[Double]] = []
    for f in (req.results ?? []) {
        let b = f.boundingBox
        faces.append([b.minX, 1 - b.maxY, b.width, b.height,
                      span(f.landmarks?.innerLips), span(f.landmarks?.outerLips),
                      f.yaw?.doubleValue ?? 0, Double(f.confidence)].map { ($0 * 1000).rounded() / 1000 })
    }
    let line = try! JSONSerialization.data(withJSONObject: ["t": (t * 1000).rounded() / 1000, "f": faces])
    fh.write(line); fh.write("\n".data(using: .utf8)!)
}
fh.closeFile()
