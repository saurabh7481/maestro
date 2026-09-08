// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|argument| argument == "--daybook-run") {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("create Daybook runtime");
        match runtime.block_on(maestro_lib::run_daybook_headless()) {
            Ok(path) => println!("{path}"),
            Err(error) => {
                eprintln!("Daybook failed: {error}");
                std::process::exit(1);
            }
        }
    } else {
        maestro_lib::run()
    }
}
