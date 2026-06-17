// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "Backlex",
    platforms: [
        .macOS(.v13),
        .iOS(.v16),
    ],
    products: [
        .library(name: "Backlex", targets: ["Backlex"]),
    ],
    targets: [
        // Zero dependencies: URLSession (Foundation) + Codable. No third-party packages.
        // Language mode 5 keeps the PoC off Swift 6 strict-concurrency for now.
        .target(name: "Backlex", swiftSettings: [.swiftLanguageMode(.v5)]),
        // Self-contained assertion runner (this toolchain — CommandLineTools — ships
        // neither XCTest nor swift-testing for the macOS host). `swift run backlex-tests`.
        .executableTarget(
            name: "backlex-tests",
            dependencies: ["Backlex"],
            path: "TestRunner",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
