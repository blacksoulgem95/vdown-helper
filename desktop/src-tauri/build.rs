//! Tauri's build step. The window's files come from `desktop/ui` (`npm run desktop:ui`); a placeholder page stands in
//! when they have not been built, so `cargo check`/`clippy`/`test` work without Node.

fn main() {
    let ui = std::path::Path::new("../ui/dist");
    if !ui.join("index.html").exists() {
        std::fs::create_dir_all(ui).expect("desktop/ui/dist");
        std::fs::write(
            ui.join("index.html"),
            "<!doctype html><meta charset=\"utf-8\"><title>vdown-helper</title>\
             <p>The window was not built: run <code>npm run desktop:ui</code>.</p>",
        )
        .expect("placeholder page");
    }
    tauri_build::build();
}
