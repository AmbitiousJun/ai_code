import Foundation
import Vision
import AppKit

// Reads a PNG from stdin. Coordinates are normalized to a top-left origin.
do {
    let bytes = FileHandle.standardInput.readDataToEndOfFile()
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]
    try VNImageRequestHandler(data: bytes).perform([request])
    let result: [[String: Any]] = (request.results ?? []).compactMap { observation in
        guard let candidate = observation.topCandidates(1).first, candidate.confidence >= 0.75 else { return nil }
        let box = observation.boundingBox
        return ["text": candidate.string, "x": box.midX, "y": 1-box.midY]
    }
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result))
} catch { exit(1) }
