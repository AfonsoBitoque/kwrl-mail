use std::fs;
use std::path::Path;

fn main() {
    println!("cargo:rerun-if-changed=../.env");

    let env_path = Path::new("../.env");
    if let Ok(contents) = fs::read_to_string(env_path) {
        for raw_line in contents.lines() {
            let line = raw_line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((k, v)) = line.split_once('=') {
                let key = k.trim();
                let val = v.trim().trim_matches('"').trim_matches('\'');
                if (key == "KWRL_GOOGLE_CLIENT_ID"
                    || key == "KWRL_GOOGLE_CLIENT_SECRET"
                    || key == "CORVO_GOOGLE_CLIENT_ID"
                    || key == "CORVO_GOOGLE_CLIENT_SECRET")
                    && !val.is_empty()
                {
                    println!("cargo:rustc-env={}={}", key, val);
                }
            }
        }
    }

    tauri_build::build()
}
