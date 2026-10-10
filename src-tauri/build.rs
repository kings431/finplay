fn main() {
    println!("cargo:rerun-if-env-changed=FINPLAY_CRASH_WEBHOOK");
    tauri_build::build()
}
