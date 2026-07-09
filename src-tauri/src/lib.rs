//! TestHound Rust core. See docs/02-architecture.md for the layer breakdown:
//! `domain` (pure types), `repo` (on-disk format), `git` (VCS ops), and `app`
//! (Tauri command handlers + state).

pub mod app;
pub mod domain;
pub mod error;
pub mod git;
pub mod playwright;
pub mod repo;

use app::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            app::inspect_repo,
            app::clone_repo,
            app::scaffold_project,
            app::open_project,
            app::current_project,
            app::list_suites,
            app::list_cases,
            app::get_case,
            app::save_case,
            app::create_case,
            app::git_status,
            app::list_branches,
            app::switch_branch,
            app::dashboard,
            app::list_runs,
            app::get_run,
            app::preview_run,
            app::create_run,
            app::set_result,
            app::set_run_state,
            app::list_milestones,
            app::list_configurations,
            app::playwright_info,
            app::run_playwright,
            app::open_trace,
        ])
        .run(tauri::generate_context!())
        .expect("error while running TestHound");
}
