// The whole Rust surface: read the vault, write a note, run git. Everything
// else — parsing, search, the graph — lives in shared TypeScript so the mobile
// PWA reuses it. Keeping this layer thin is what makes that possible.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

#[derive(Serialize)]
struct GitOutput {
    stdout: String,
    stderr: String,
    code: i32,
}

/// Every path from the frontend is joined onto the vault root and must stay
/// inside it. Without this, a note id of `../../.ssh/id_rsa` would read or
/// overwrite anything the user can — and note ids will eventually come from
/// synced data, not just local files.
fn safe_join(root: &str, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel);
    if rel_path.is_absolute()
        || rel_path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::Prefix(_)))
    {
        return Err(format!("unsafe path: {rel}"));
    }
    Ok(Path::new(root).join(rel_path))
}

fn walk(dir: &Path, root: &Path, out: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue; // .git, .obsidian, .agents — not vault content
        }
        if path.is_dir() {
            walk(&path, root, out);
        } else if name.ends_with(".md") {
            if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
}

/// Where the vault lives by default. The frontend cannot read $HOME itself, and
/// guessing wrong means an empty window on first launch with no explanation.
#[tauri::command]
fn default_vault() -> String {
    std::env::var("HOME")
        .map(|h| format!("{h}/Documents/KnowledgeBase"))
        .unwrap_or_default()
}

#[tauri::command]
fn list_notes(vault: String) -> Result<Vec<String>, String> {
    let root = Path::new(&vault);
    if !root.is_dir() {
        return Err(format!("not a directory: {vault}"));
    }
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out.sort();
    Ok(out)
}

#[tauri::command]
fn read_note(vault: String, path: String) -> Result<String, String> {
    fs::read_to_string(safe_join(&vault, &path)?).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_note(vault: String, path: String, content: String) -> Result<(), String> {
    let full = safe_join(&vault, &path)?;
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(full, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_note(vault: String, path: String) -> Result<(), String> {
    fs::remove_file(safe_join(&vault, &path)?).map_err(|e| e.to_string())
}

/// Shelling out to system git means macOS keychain credentials work as they
/// already do — no token handling, and no second place for one to live.
#[tauri::command]
fn run_git(vault: String, args: Vec<String>) -> Result<GitOutput, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(&vault)
        .args(&args)
        .output()
        .map_err(|e| e.to_string())?;
    Ok(GitOutput {
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        code: out.status.code().unwrap_or(-1),
    })
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            default_vault,
            list_notes,
            read_note,
            write_note,
            delete_note,
            run_git
        ])
        .run(tauri::generate_context!())
        .expect("error while running application");
}
