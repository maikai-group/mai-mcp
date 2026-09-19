extension Engine {
    func stop() {
        pump()
    }
}

extension String {
    func slugified() -> String {
        return lowercased()
    }
}
