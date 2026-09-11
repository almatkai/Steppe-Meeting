fn main() {
    println!("cargo:rustc-link-search=native=/Library/Developer/CommandLineTools/usr/lib/swift/macosx");
    println!("cargo:rustc-link-lib=static=swiftCompatibility56");
    println!("cargo:rustc-link-lib=static=swiftCompatibilityConcurrency");
    println!("cargo:rustc-link-lib=static=swiftCompatibilityPacks");
    tauri_build::build()
}
