// T1029 — the Vision person-segmentation worker: a persistent child process the
// bridge helper spawns, speaking length-prefixed frames over stdio.
//
// Protocol: stdin  = [u32 LE width][u32 LE height][width*height*4 bytes RGBA]
//           stdout = [u32 LE maskWidth][u32 LE maskHeight][maskW*maskH bytes, 0..255]
// One request per frame, loop until EOF; errors go to stderr and exit non-zero, which
// the host surfaces verbatim (fail loud, never a silent black mask).
//
// Compiled on first use by vision-host.ts (swiftc, cached by source hash) because an
// interpreted `swift file.swift` start costs seconds every session while a compiled
// binary starts in milliseconds. The FIRST segmentation still pays Vision's own model
// load (~2 s measured); every one after runs in the tens of milliseconds.
import Foundation
import Vision
import CoreVideo
import CoreImage

func readExactly(_ n: Int) -> Data? {
  var data = Data(capacity: n)
  while data.count < n {
    let chunk = FileHandle.standardInput.readData(ofLength: n - data.count)
    if chunk.isEmpty { return nil }
    data.append(chunk)
  }
  return data
}

func u32(_ d: Data, _ at: Int) -> UInt32 {
  return d.subdata(in: at..<(at+4)).withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }
}

let request = VNGeneratePersonSegmentationRequest()
request.qualityLevel = .balanced
request.outputPixelFormat = kCVPixelFormatType_OneComponent8

var out = FileHandle.standardOutput

while true {
  guard let header = readExactly(8) else { break }
  let width = Int(u32(header, 0))
  let height = Int(u32(header, 4))
  guard width > 0, height > 0, width <= 8192, height <= 8192,
        let rgba = readExactly(width * height * 4) else {
    FileHandle.standardError.write("bad frame header\n".data(using: .utf8)!)
    exit(1)
  }

  var pixelBuffer: CVPixelBuffer?
  CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_32BGRA, nil, &pixelBuffer)
  guard let buffer = pixelBuffer else { exit(1) }
  CVPixelBufferLockBaseAddress(buffer, [])
  let base = CVPixelBufferGetBaseAddress(buffer)!
  let stride = CVPixelBufferGetBytesPerRow(buffer)
  rgba.withUnsafeBytes { (src: UnsafeRawBufferPointer) in
    let s = src.bindMemory(to: UInt8.self).baseAddress!
    for row in 0..<height {
      let dst = base.advanced(by: row * stride).assumingMemoryBound(to: UInt8.self)
      let srow = s.advanced(by: row * width * 4)
      for col in 0..<width {
        dst[col*4+0] = srow[col*4+2] // B
        dst[col*4+1] = srow[col*4+1] // G
        dst[col*4+2] = srow[col*4+0] // R
        dst[col*4+3] = srow[col*4+3] // A
      }
    }
  }
  CVPixelBufferUnlockBaseAddress(buffer, [])

  let handler = VNImageRequestHandler(cvPixelBuffer: buffer, options: [:])
  do {
    try handler.perform([request])
  } catch {
    FileHandle.standardError.write("vision: \(error)\n".data(using: .utf8)!)
    exit(1)
  }
  guard let observation = request.results?.first else {
    FileHandle.standardError.write("no observation\n".data(using: .utf8)!)
    exit(1)
  }
  let mask = observation.pixelBuffer
  CVPixelBufferLockBaseAddress(mask, .readOnly)
  let mw = CVPixelBufferGetWidth(mask)
  let mh = CVPixelBufferGetHeight(mask)
  let mstride = CVPixelBufferGetBytesPerRow(mask)
  let mbase = CVPixelBufferGetBaseAddress(mask)!.assumingMemoryBound(to: UInt8.self)
  var payload = Data(capacity: 8 + mw * mh)
  var w32 = UInt32(mw).littleEndian
  var h32 = UInt32(mh).littleEndian
  payload.append(Data(bytes: &w32, count: 4))
  payload.append(Data(bytes: &h32, count: 4))
  for row in 0..<mh {
    payload.append(Data(bytes: mbase.advanced(by: row * mstride), count: mw))
  }
  CVPixelBufferUnlockBaseAddress(mask, .readOnly)
  out.write(payload)
}
