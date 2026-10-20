// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Walter Horbert

import Foundation
import Network

struct HTTPRequest: Sendable {
    let method: String
    let path: String
    let query: [String: String]
    let headers: [String: String]   // lowercased names
    let body: Data

    func header(_ name: String) -> String? { headers[name.lowercased()] }
}

struct HTTPResponse: Sendable {
    var status: Int
    var headers: [(String, String)] = []
    var body: Data = Data()

    static func json<T: Encodable>(_ status: Int, _ value: T) -> HTTPResponse {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let data = (try? encoder.encode(value)) ?? Data("{}".utf8)
        return HTTPResponse(status: status, headers: [("Content-Type", "application/json; charset=utf-8")], body: data)
    }

    static func text(_ status: Int, _ text: String) -> HTTPResponse {
        HTTPResponse(status: status, headers: [("Content-Type", "text/plain; charset=utf-8")], body: Data(text.utf8))
    }

    static let reasons: [Int: String] = [
        200: "OK", 204: "No Content", 400: "Bad Request", 403: "Forbidden", 404: "Not Found",
        405: "Method Not Allowed", 411: "Length Required", 413: "Payload Too Large",
        422: "Unprocessable Content", 500: "Internal Server Error", 503: "Service Unavailable",
    ]

    func serialized() -> Data {
        var head = "HTTP/1.1 \(status) \(Self.reasons[status] ?? "Status")\r\n"
        for (name, value) in headers { head += "\(name): \(value)\r\n" }
        head += "Content-Length: \(body.count)\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n"
        var out = Data(head.utf8)
        out.append(body)
        return out
    }
}

/// A deliberately small HTTP/1.1 server on Network.framework: loopback only, one request
/// per connection, Content-Length bodies only (what fetch() and curl send).
final class HTTPServer: @unchecked Sendable {
    typealias Handler = @Sendable (HTTPRequest) async -> HTTPResponse

    private let port: NWEndpoint.Port
    private let maxBodyBytes: Int
    private let handler: Handler
    private let queue = DispatchQueue(label: "trp-watch-helper.http")
    private var listener: NWListener?

    init(port: UInt16, maxBodyBytes: Int, handler: @escaping Handler) {
        self.port = NWEndpoint.Port(rawValue: port)!
        self.maxBodyBytes = maxBodyBytes
        self.handler = handler
    }

    func start() throws {
        let parameters = NWParameters.tcp
        parameters.requiredInterfaceType = .loopback   // never reachable off this Mac
        parameters.allowLocalEndpointReuse = true
        let listener = try NWListener(using: parameters, on: port)
        listener.stateUpdateHandler = { [port] state in
            switch state {
            case .ready: Log.info("HTTP listening on loopback port \(port)")
            case .failed(let error):
                Log.error("HTTP listener failed: \(error)")
                exit(1)
            default: break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { return }
            connection.start(queue: self.queue)
            self.receive(on: connection, buffer: Data())
        }
        listener.start(queue: queue)
        self.listener = listener
    }

    private enum Parse {
        case incomplete
        case invalid(String)
        case tooLarge
        case lengthRequired
        case complete(HTTPRequest)
    }

    private func receive(on connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { [weak self] data, _, isComplete, error in
            guard let self else { connection.cancel(); return }
            var buffer = buffer
            if let data { buffer.append(data) }
            if error != nil { connection.cancel(); return }
            switch self.parse(buffer) {
            case .incomplete:
                if isComplete { connection.cancel() } else { self.receive(on: connection, buffer: buffer) }
            case .invalid(let why):
                self.send(.text(400, why), on: connection)
            case .tooLarge:
                self.send(.text(413, "Body too large"), on: connection)
            case .lengthRequired:
                self.send(.text(411, "Content-Length required"), on: connection)
            case .complete(let request):
                let handler = self.handler
                Task {
                    let response = await handler(request)
                    self.send(response, on: connection)
                }
            }
        }
    }

    private func send(_ response: HTTPResponse, on connection: NWConnection) {
        connection.send(content: response.serialized(), contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    private static let headerEnd = Data("\r\n\r\n".utf8)

    private func parse(_ buffer: Data) -> Parse {
        guard let end = buffer.range(of: Self.headerEnd) else {
            return buffer.count > 64 * 1024 ? .invalid("Header too large") : .incomplete
        }
        guard let head = String(data: buffer[buffer.startIndex..<end.lowerBound], encoding: .utf8) else {
            return .invalid("Unreadable header")
        }
        var lines = head.components(separatedBy: "\r\n")
        let requestLine = lines.removeFirst().split(separator: " ", omittingEmptySubsequences: true)
        guard requestLine.count >= 2 else { return .invalid("Bad request line") }

        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            headers[name] = value
        }

        if headers["transfer-encoding"] != nil { return .lengthRequired }
        let length = Int(headers["content-length"] ?? "0") ?? -1
        guard length >= 0 else { return .invalid("Bad Content-Length") }
        guard length <= maxBodyBytes else { return .tooLarge }
        let bodyStart = end.upperBound
        guard buffer.count - (bodyStart - buffer.startIndex) >= length else { return .incomplete }
        let body = buffer[bodyStart..<(bodyStart + length)]

        let target = String(requestLine[1])
        let components = URLComponents(string: "http://localhost" + (target.hasPrefix("/") ? target : "/" + target))
        var query: [String: String] = [:]
        for item in components?.queryItems ?? [] { query[item.name] = item.value ?? "" }

        return .complete(HTTPRequest(
            method: String(requestLine[0]).uppercased(),
            path: components?.path ?? target,
            query: query,
            headers: headers,
            body: Data(body)
        ))
    }
}
