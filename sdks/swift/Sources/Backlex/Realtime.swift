import Foundation

/// Handle for an active realtime subscription. `cancel()` unsubscribes — the same
/// contract as the TS SDK's returned unsubscribe function.
public final class BacklexSubscription {
    private let task: Task<Void, Never>

    init(_ task: Task<Void, Never>) {
        self.task = task
    }

    public func cancel() {
        task.cancel()
    }
}

extension BacklexClient {
    /// Subscribe to a realtime channel (e.g. "items:posts"). Returns a
    /// ``BacklexSubscription``; `cancel()` unsubscribes. The reader runs on a Task
    /// and auto-reconnects on a dropped stream (3s back-off), replaying via
    /// Last-Event-ID. `onError` may be nil.
    public func subscribe<T: Decodable>(
        _ channel: String,
        as type: T.Type,
        onEvent: @escaping (ItemEvent<T>) -> Void,
        onError: ((Error) -> Void)? = nil
    ) -> BacklexSubscription {
        let task = Task { [weak self] in
            guard let self else { return }
            await self.sseLoop(channel, as: type, onEvent: onEvent, onError: onError)
        }
        return BacklexSubscription(task)
    }

    private func sseLoop<T: Decodable>(
        _ channel: String,
        as type: T.Type,
        onEvent: @escaping (ItemEvent<T>) -> Void,
        onError: ((Error) -> Void)?
    ) async {
        var lastId: String?
        while !Task.isCancelled {
            do {
                guard let u = URL(string: url + "/api/realtime/\(channel)/subscribe") else { return }
                var req = URLRequest(url: u)
                req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                applyAuth(&req)
                if let lastId { req.setValue(lastId, forHTTPHeaderField: "Last-Event-ID") }

                let (bytes, resp) = try await session.bytes(for: req)
                if let http = resp as? HTTPURLResponse, http.statusCode != 200 {
                    onError?(BacklexError(status: http.statusCode, code: "UNKNOWN", message: "HTTP \(http.statusCode)", details: nil))
                } else {
                    var data: [String] = []
                    for try await line in bytes.lines {
                        if Task.isCancelled { return }
                        if line.isEmpty {
                            if !data.isEmpty {
                                let payload = data.joined(separator: "\n")
                                data.removeAll()
                                if let d = payload.data(using: .utf8) {
                                    do {
                                        onEvent(try JSONDecoder().decode(ItemEvent<T>.self, from: d))
                                    } catch {
                                        onError?(error)
                                    }
                                }
                            }
                        } else if line.hasPrefix(":") {
                            // Comment / heartbeat frame.
                        } else if line.hasPrefix("id:") {
                            lastId = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                        } else if line.hasPrefix("data:") {
                            var d = String(line.dropFirst(5))
                            if d.hasPrefix(" ") { d.removeFirst() }
                            data.append(d)
                        }
                    }
                }
            } catch {
                if !Task.isCancelled { onError?(error) }
            }
            if Task.isCancelled { return }
            try? await Task.sleep(nanoseconds: 3_000_000_000)
        }
    }
}
