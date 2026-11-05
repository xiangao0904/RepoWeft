fn main() {
    // Recompile when public OAuth build configuration changes between builds.
    for name in ["REPOWEFT_GITHUB_CLIENT_ID", "REPOWEFT_GITHUB_APP_SLUG"] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    tauri_build::build()
}
