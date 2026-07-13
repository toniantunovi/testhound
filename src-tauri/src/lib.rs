//! TestHound Rust core. See docs/02-architecture.md for the layer breakdown:
//! `domain` (pure types), `repo` (on-disk format), `git` (VCS ops), and `app`
//! (Tauri command handlers + state).

pub mod app;
pub mod assistant;
pub mod automation;
pub mod domain;
pub mod error;
pub mod git;
pub mod lfs;
pub mod merge;
pub mod playwright;
pub mod repo;

use app::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            app::inspect_repo,
            app::clone_repo,
            app::scaffold_project,
            app::open_project,
            app::current_project,
            app::create_suite,
            app::list_suites,
            app::list_cases,
            app::get_case,
            app::save_case,
            app::create_case,
            app::delete_case,
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
            app::get_test_target,
            app::set_test_target,
            app::run_playwright,
            app::run_case_spec,
            app::open_trace,
            app::list_agents,
            app::coverage,
            app::automation_context,
            app::file_diff,
            app::read_spec,
            app::write_spec,
            app::accept_generation,
            app::generate_spec,
            app::triage_failure,
            app::assistant_send,
            app::assistant_stop,
            app::list_conflicts,
            app::resolve_case_conflict,
            app::resolve_case_keep,
            app::resolve_case_delete,
            app::id_collisions,
            app::renumber_case,
            app::lfs_status,
            app::enable_lfs,
            app::disable_lfs,
            app::commit_changes,
            app::push_changes,
            app::sync_repo,
            app::case_history,
            app::case_commit_diff,
            app::case_blame,
            app::restore_case_version,
            app::check_for_update,
            app::install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running TestHound");
}
