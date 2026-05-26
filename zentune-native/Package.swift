// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ZenTuneNative",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "ZenTuneNative", targets: ["ZenTuneNative"])
    ],
    targets: [
        .executableTarget(
            name: "ZenTuneNative",
            path: "Sources"
        )
    ]
)
