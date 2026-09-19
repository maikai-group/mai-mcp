import Foundation

protocol Discovering: Codable {
    func start()
}

class Engine: Base, Discovering {
    init(size: Int) {
        helper()
    }

    func start() {
        helper()
        pump()
    }
}

struct Payload {
    let id: String

    func tag() {
    }
}

enum Mode {
    case idle
    case active
}
