class Engine {
    func start() {
        let p = Payload(id: "x")
        _ = p
    }
}

extension Payload: Discovering {
    func start() {
    }

    func tag(_ count: Int) {
    }

    func tag(_ a: Int, _ b: Int) {
    }
}

extension Mode: Discovering {
}

@main
struct DemoApp {
    @State var count: Int = 0

    static func main() {
        let e = Engine()
        e.start()
    }
}
