// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Walter Horbert

import AVFoundation
import Foundation
import Speech

/// On-device SpeechTranscriber, the same configuration ICOMSingleRadioCapture uses:
/// - public AssetInventory API to reserve the locale and install the model,
/// - the model kept loaded for the life of the process (`.processLifetime`),
/// - per-word transcription confidence,
/// - no volatile reporting, but a trailing volatile result is kept if one arrives,
/// - `analyzeSequence(from: AVAudioFile)` directly on TRP's 8 kHz mono WAVs.
/// No custom vocabulary, no post-processing.
actor SpeechEngine {
    enum EngineError: Error, CustomStringConvertible {
        case transcriberUnavailable
        case unsupportedLocale(String)
        case assetsNotInstalled(String)

        var code: String {
            switch self {
            case .transcriberUnavailable: return "transcriber_unavailable"
            case .unsupportedLocale: return "unsupported_locale"
            case .assetsNotInstalled: return "assets_not_installed"
            }
        }

        var description: String {
            switch self {
            case .transcriberUnavailable: return "SpeechTranscriber is not available on this Mac"
            case .unsupportedLocale(let id): return "No on-device speech model supports \(id)"
            case .assetsNotInstalled(let why): return "Speech model not installed: \(why)"
            }
        }
    }

    struct Word: Sendable {
        let text: String
        let confidence: Double?
    }

    struct Transcript: Sendable {
        let text: String
        let confidence: Double?
        let words: Int
        let usedTrailingVolatile: Bool
    }

    enum State: String, Sendable {
        case starting, preparing, downloading, ready, failed
    }

    private let requestedLocale: Locale
    private(set) var locale: Locale?
    private(set) var state: State = .starting
    private(set) var lastError: String?
    private var preparationTask: Task<Locale, any Error>?

    init(localeIdentifier: String) {
        requestedLocale = Locale(identifier: localeIdentifier)
    }

    var requestedLocaleIdentifier: String { requestedLocale.identifier }

    /// Resolves, reserves and installs once; concurrent callers share the same work.
    func prepare() async throws -> Locale {
        if let locale { return locale }
        if let preparationTask { return try await preparationTask.value }
        let task = Task { try await self.performPreparation() }
        preparationTask = task
        defer { preparationTask = nil }
        do {
            let resolved = try await task.value
            locale = resolved
            state = .ready
            lastError = nil
            return resolved
        } catch {
            state = .failed
            lastError = String(describing: error)
            throw error
        }
    }

    private func performPreparation() async throws -> Locale {
        state = .preparing
        guard SpeechTranscriber.isAvailable else { throw EngineError.transcriberUnavailable }
        guard let resolved = await SpeechTranscriber.supportedLocale(equivalentTo: requestedLocale) else {
            throw EngineError.unsupportedLocale(requestedLocale.identifier)
        }

        Log.info("SPEECH reserving locale \(resolved.identifier)")
        do {
            try await AssetInventory.reserve(locale: resolved)
        } catch {
            // Not fatal by itself: the locale may already be reserved.
            Log.info("SPEECH reserve failed locale=\(resolved.identifier) error=\(error)")
        }

        let modules: [any SpeechModule] = [Self.makeTranscriber(locale: resolved)]
        let status = await AssetInventory.status(forModules: modules)
        Log.info("SPEECH assets locale=\(resolved.identifier) status=\(status)")
        switch status {
        case .unsupported:
            throw EngineError.unsupportedLocale(resolved.identifier)
        case .installed:
            break
        case .supported, .downloading:
            state = .downloading
            if let request = try await AssetInventory.assetInstallationRequest(supporting: modules) {
                Log.info("SPEECH downloading model for \(resolved.identifier)")
                try await request.downloadAndInstall()
            }
        @unknown default:
            if let request = try await AssetInventory.assetInstallationRequest(supporting: modules) {
                try await request.downloadAndInstall()
            }
        }
        let after = await AssetInventory.status(forModules: modules)
        guard after == .installed else { throw EngineError.assetsNotInstalled("status \(after)") }
        Log.info("SPEECH ready locale=\(resolved.identifier) on-device")
        return resolved
    }

    private static func makeTranscriber(locale: Locale) -> SpeechTranscriber {
        SpeechTranscriber(
            locale: locale,
            transcriptionOptions: [],
            reportingOptions: [],
            attributeOptions: [.transcriptionConfidence]
        )
    }

    /// Transcribes one audio file. Not reentrant by design: the caller (JobQueue) runs one at a time.
    func transcribe(fileURL: URL) async throws -> Transcript {
        let locale = try await prepare()
        let audioFile = try AVAudioFile(forReading: fileURL)
        let transcriber = Self.makeTranscriber(locale: locale)

        let collector = Task { () throws -> (words: [Word], trailing: Bool) in
            var finalized: [Word] = []
            var pendingVolatile: [Word]?
            for try await result in transcriber.results {
                let words = Self.words(from: result.text)
                if result.isFinal {
                    finalized.append(contentsOf: words)
                    pendingVolatile = nil
                } else if !words.isEmpty {
                    pendingVolatile = words
                }
            }
            if let pendingVolatile {
                finalized.append(contentsOf: pendingVolatile)
                return (finalized, true)
            }
            return (finalized, false)
        }

        let analyzer = SpeechAnalyzer(
            modules: [transcriber],
            options: SpeechAnalyzer.Options(priority: .userInitiated, modelRetention: .processLifetime)
        )

        do {
            if let lastSampleTime = try await analyzer.analyzeSequence(from: audioFile) {
                try await analyzer.finalizeAndFinish(through: lastSampleTime)
            } else {
                await analyzer.cancelAndFinishNow()
            }
        } catch {
            collector.cancel()
            await analyzer.cancelAndFinishNow()
            // If the locale reservation was lost, prepare again next time.
            if let speechError = error as? SFSpeechError,
               speechError.code == .assetLocaleNotAllocated || speechError.code == .noModel {
                self.locale = nil
                self.state = .starting
            }
            throw error
        }

        let (words, trailing) = try await collector.value
        let confidences = words.compactMap(\.confidence)
        let mean = confidences.isEmpty ? nil : confidences.reduce(0, +) / Double(confidences.count)
        return Transcript(text: Self.joined(words), confidence: mean, words: words.count, usedTrailingVolatile: trailing)
    }

    /// Splits a result's attributed text into runs carrying transcription confidence.
    private static func words(from text: AttributedString) -> [Word] {
        var words: [Word] = []
        for run in text.runs {
            let piece = String(text[run.range].characters)
            guard !piece.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
            words.append(Word(text: piece, confidence: run.transcriptionConfidence))
        }
        return words
    }

    /// Runs within one result carry their own spacing; separate results are joined with one space.
    private static func joined(_ words: [Word]) -> String {
        var text = ""
        for word in words {
            if !text.isEmpty, !text.hasSuffix(" "), !word.text.hasPrefix(" ") {
                if let first = word.text.first, !first.isPunctuation { text += " " }
            }
            text += word.text
        }
        return text
            .replacingOccurrences(of: #"\s{2,}"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
