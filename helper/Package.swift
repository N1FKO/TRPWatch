// swift-tools-version: 6.0
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Walter Horbert

import PackageDescription

let package = Package(
    name: "TRPWatchHelper",
    platforms: [.macOS("27.0")],
    targets: [
        .executableTarget(
            name: "trp-watch-helper",
            path: "Sources/TRPWatchHelper",
            linkerSettings: [
                // Embed Info.plist (bundle id + speech usage string) in the executable,
                // so the Speech framework sees the same declarations an app bundle would.
                .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", "Info.plist"])
            ]
        )
    ],
    swiftLanguageModes: [.v5]
)
