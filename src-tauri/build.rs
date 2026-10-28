fn main() {
    // CI selects a full Xcode toolchain; local development may use CLT. Resolve
    // the active toolchain rather than borrowing libraries from another SDK.
    let output = std::process::Command::new("/usr/bin/xcrun")
        .args(["--find", "swiftc"])
        .output()
        .expect("Xcode tools are required to locate Swift compatibility libraries");
    assert!(output.status.success(), "xcrun could not locate swiftc");
    let swiftc = String::from_utf8(output.stdout).expect("Invalid swiftc path");
    let libraries = std::path::Path::new(swiftc.trim())
        .parent()
        .and_then(std::path::Path::parent)
        .expect("Unexpected Swift toolchain layout")
        .join("lib/swift/macosx");
    for name in [
        "swiftCompatibility56",
        "swiftCompatibilityConcurrency",
        "swiftCompatibilityPacks",
    ] {
        assert!(
            libraries.join(format!("lib{name}.a")).is_file(),
            "Missing {name} in {}",
            libraries.display()
        );
    }
    println!("cargo:rerun-if-env-changed=DEVELOPER_DIR");
    println!("cargo:rustc-link-search=native={}", libraries.display());
    println!("cargo:rustc-link-lib=static=swiftCompatibility56");
    println!("cargo:rustc-link-lib=static=swiftCompatibilityConcurrency");
    println!("cargo:rustc-link-lib=static=swiftCompatibilityPacks");
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    tauri_build::build()
}
