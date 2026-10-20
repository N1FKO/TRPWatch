// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Walter Horbert

import AVFoundation
import Foundation

enum Log {
    private static let formatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    static func info(_ message: String) { write("INFO", message) }
    static func error(_ message: String) { write("ERROR", message) }
    private static func write(_ level: String, _ message: String) {
        FileHandle.standardError.write(Data("\(formatter.string(from: Date())) \(level) \(message)\n".utf8))
    }
}

struct Options {
    var port: UInt16 = 8765
    var locale = "en-US"
    var maxQueue = 50
    var maxBodyMB = 64
    var extraOrigins: Set<String> = []
    var onceFiles: [String] = []

    static func parse(_ args: [String]) -> Options {
        var o = Options()
        var i = 1
        func value() -> String {
            i += 1
            guard i < args.count else { usage("missing value for \(args[i - 1])") }
            return args[i]
        }
        while i < args.count {
            switch args[i] {
            case "--port": o.port = UInt16(value()) ?? { usage("bad --port") }()
            case "--locale": o.locale = value()
            case "--max-queue": o.maxQueue = Int(value()) ?? { usage("bad --max-queue") }()
            case "--max-body-mb": o.maxBodyMB = Int(value()) ?? { usage("bad --max-body-mb") }()
            case "--allow-origin": o.extraOrigins.insert(value())
            case "--transcribe": o.onceFiles.append(value())
            case "-h", "--help": usage(nil)
            default: usage("unknown option \(args[i])")
            }
            i += 1
        }
        return o
    }

    static func usage(_ problem: String?) -> Never {
        if let problem { FileHandle.standardError.write(Data("trp-watch-helper: \(problem)\n".utf8)) }
        print("""
        usage: trp-watch-helper [--port 8765] [--locale en-US] [--max-queue 50]
                                [--max-body-mb 64] [--allow-origin http://host:port]...
               trp-watch-helper [--locale en-US] --transcribe file.wav [--transcribe file2.wav ...]
        Transcribes Trunk Recorder Pro call audio with Apple's on-device SpeechTranscriber.
        Listens on loopback only. Pages from http://localhost:* and http://127.0.0.1:* are allowed.
        """)
        exit(problem == nil ? 0 : 2)
    }
}

/// One transcription at a time; at most `limit` waiting behind it.
actor SerialGate {
    private var busy = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private let limit: Int
    init(limit: Int) { self.limit = limit }

    var waiting: Int { waiters.count }
    var isBusy: Bool { busy }

    /// False when the queue is full.
    func enter() async -> Bool {
        if !busy { busy = true; return true }
        guard waiters.count < limit else { return false }
        await withCheckedContinuation { waiters.append($0) }
        return true
    }

    func leave() {
        if waiters.isEmpty { busy = false } else { waiters.removeFirst().resume() }
    }
}

struct TranscribeResult: Codable {
    var status: String               // "ok" | "error"
    var path: String?
    var text: String?
    var confidence: Double?
    var words: Int?
    var audioSeconds: Double?
    var elapsedMs: Int?
    var waitedMs: Int?
    var locale: String?
    var error: String?               // missing_audio, bad_audio, queue_full, unsupported_locale, ...
    var message: String?
}

struct Health: Codable {
    var status: String
    var app = "trp-watch-helper"
    var version = "0.1.0"
    var speech: String
    var locale: String?
    var requestedLocale: String
    var lastError: String?
    var busy: Bool
    var queued: Int
    var completed: Int
    var failed: Int
}

final class Counters: @unchecked Sendable {
    private let lock = NSLock()
    private var _completed = 0, _failed = 0
    func ok() { lock.withLock { _completed += 1 } }
    func fail() { lock.withLock { _failed += 1 } }
    var snapshot: (Int, Int) { lock.withLock { (_completed, _failed) } }
}

@main
struct TRPWatchHelper {
    static func main() async {
        let options = Options.parse(CommandLine.arguments)
        let engine = SpeechEngine(localeIdentifier: options.locale)
        let gate = SerialGate(limit: options.maxQueue)
        let counters = Counters()
        let tempDir = FileManager.default.temporaryDirectory.appendingPathComponent("trp-watch-helper", isDirectory: true)
        try? FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)

        if !options.onceFiles.isEmpty {
            // One-shot mode: transcribe the files, print one JSON line each, exit. No server.
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
            var failures = 0
            for file in options.onceFiles {
                let url = URL(fileURLWithPath: (file as NSString).expandingTildeInPath)
                let started = Date()
                var result = TranscribeResult(status: "ok", path: url.path)
                do {
                    let audio = try AVAudioFile(forReading: url)
                    result.audioSeconds = Double(audio.length) / audio.processingFormat.sampleRate
                    let t = try await engine.transcribe(fileURL: url)
                    result.text = t.text; result.confidence = t.confidence; result.words = t.words
                    result.locale = await engine.locale?.identifier
                } catch {
                    failures += 1
                    result.status = "error"; result.error = (error as? SpeechEngine.EngineError)?.code ?? "transcription_failed"
                    result.message = String(describing: error)
                }
                result.elapsedMs = Int(Date().timeIntervalSince(started) * 1000)
                print(String(data: try! encoder.encode(result), encoding: .utf8)!)
            }
            exit(failures == 0 ? 0 : 1)
        }

        let server = HTTPServer(port: options.port, maxBodyBytes: options.maxBodyMB << 20) { request in
            await route(request, options: options, engine: engine, gate: gate, counters: counters, tempDir: tempDir)
        }
        do { try server.start() } catch {
            Log.error("could not listen on port \(options.port): \(error)")
            exit(1)
        }

        // Load the model now, so the first call doesn't wait for it.
        Task {
            do { _ = try await engine.prepare() } catch { Log.error("SPEECH not ready: \(error)") }
        }

        while true { try? await Task.sleep(for: .seconds(3600)) }
    }

    // MARK: - Origins

    /// A browser page's origin, if it may use the helper. No Origin header (curl, scripts) is allowed.
    static func originAllowed(_ origin: String?, extra: Set<String>) -> Bool {
        guard let origin else { return true }
        if extra.contains(origin) || extra.contains("*") { return true }
        guard let url = URL(string: origin), url.scheme == "http" || url.scheme == "https", let host = url.host else { return false }
        return host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]"
    }

    static func withCORS(_ response: HTTPResponse, origin: String?, request: HTTPRequest) -> HTTPResponse {
        var r = response
        guard let origin else { return r }
        r.headers.append(("Access-Control-Allow-Origin", origin))
        r.headers.append(("Vary", "Origin"))
        if request.method == "OPTIONS" {
            r.headers.append(("Access-Control-Allow-Methods", "GET, POST, OPTIONS"))
            r.headers.append(("Access-Control-Allow-Headers", "Content-Type"))
            r.headers.append(("Access-Control-Max-Age", "600"))
            if request.header("access-control-request-private-network") == "true" {
                r.headers.append(("Access-Control-Allow-Private-Network", "true"))
            }
        }
        return r
    }

    // MARK: - Routes

    static func route(_ request: HTTPRequest, options: Options, engine: SpeechEngine, gate: SerialGate,
                      counters: Counters, tempDir: URL) async -> HTTPResponse {
        let origin = request.header("origin")
        guard originAllowed(origin, extra: options.extraOrigins) else {
            Log.info("HTTP refused a page from \(origin ?? "?")")
            return .text(403, "Origin not allowed")
        }
        let response: HTTPResponse
        switch (request.method, request.path) {
        case ("OPTIONS", _):
            response = HTTPResponse(status: 204)
        case ("GET", "/health"):
            let (completed, failed) = counters.snapshot
            response = .json(200, Health(
                status: "ok",
                speech: await engine.state.rawValue,
                locale: await engine.locale?.identifier,
                requestedLocale: await engine.requestedLocaleIdentifier,
                lastError: await engine.lastError,
                busy: await gate.isBusy,
                queued: await gate.waiting,
                completed: completed,
                failed: failed
            ))
        case ("POST", "/transcribe"):
            response = await transcribe(request, engine: engine, gate: gate, counters: counters, tempDir: tempDir)
        case (_, "/health"), (_, "/transcribe"):
            response = .text(405, "Method not allowed")
        default:
            response = .text(404, "Not found")
        }
        return withCORS(response, origin: origin, request: request)
    }

    /// POST /transcribe?path=<TRP call path>
    ///   Body: the call's audio (audio/wav, or audio/mp4 for .m4a), as the page fetched it from /calls/.
    ///   Or, for testing: Content-Type application/json, {"path": "...", "file": "/abs/path.wav"}.
    static func transcribe(_ request: HTTPRequest, engine: SpeechEngine, gate: SerialGate,
                           counters: Counters, tempDir: URL) async -> HTTPResponse {
        var path = request.query["path"]
        let contentType = (request.header("content-type") ?? "").lowercased()
        var fileURL: URL
        var temporary = false

        func fail(_ status: Int, _ code: String, _ message: String) -> HTTPResponse {
            counters.fail()
            Log.info("JOB failed path=\(path ?? "-") error=\(code) \(message)")
            return .json(status, TranscribeResult(status: "error", path: path, error: code, message: message))
        }

        if contentType.hasPrefix("application/json") {
            struct Body: Decodable { var path: String?; var file: String? }
            guard let body = try? JSONDecoder().decode(Body.self, from: request.body), let file = body.file else {
                return fail(400, "bad_request", "JSON body needs \"file\"")
            }
            path = path ?? body.path ?? file
            fileURL = URL(fileURLWithPath: (file as NSString).expandingTildeInPath)
            guard FileManager.default.fileExists(atPath: fileURL.path) else {
                return fail(404, "missing_audio", "No file at \(fileURL.path)")
            }
        } else {
            guard !request.body.isEmpty else { return fail(400, "missing_audio", "Empty body") }
            let ext = contentType.contains("mp4") || contentType.contains("m4a") || contentType.contains("aac") ? "m4a" : "wav"
            fileURL = tempDir.appendingPathComponent("\(UUID().uuidString).\(ext)")
            do { try request.body.write(to: fileURL) } catch {
                return fail(500, "io_error", "Could not write temporary file: \(error)")
            }
            temporary = true
        }
        defer { if temporary { try? FileManager.default.removeItem(at: fileURL) } }

        let queuedAt = Date()
        guard await gate.enter() else { return fail(503, "queue_full", "Too many calls waiting") }
        let startedAt = Date()
        defer { Task { await gate.leave() } }

        let audioSeconds: Double? = (try? AVAudioFile(forReading: fileURL)).map { Double($0.length) / $0.processingFormat.sampleRate }
        guard audioSeconds != nil else { return fail(422, "bad_audio", "Not a readable audio file") }

        do {
            let t = try await engine.transcribe(fileURL: fileURL)
            let elapsed = Int(Date().timeIntervalSince(startedAt) * 1000)
            counters.ok()
            Log.info("JOB ok path=\(path ?? "-") audio=\(String(format: "%.1f", audioSeconds ?? 0))s ms=\(elapsed) words=\(t.words)\(t.usedTrailingVolatile ? " trailing-volatile" : "")")
            return .json(200, TranscribeResult(
                status: "ok", path: path, text: t.text, confidence: t.confidence, words: t.words,
                audioSeconds: audioSeconds, elapsedMs: elapsed,
                waitedMs: Int(startedAt.timeIntervalSince(queuedAt) * 1000),
                locale: await engine.locale?.identifier
            ))
        } catch let e as SpeechEngine.EngineError {
            return fail(503, e.code, e.description)
        } catch {
            return fail(500, "transcription_failed", String(describing: error))
        }
    }
}
