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

/// GUI apps launched from Finder/Dock inherit launchd's minimal PATH
/// (`/usr/bin:/bin:...`), which lacks node, npx, and agent CLIs. Git hooks
/// (husky runs `npx lint-staged`) and spawned agents then fail with "command
/// not found" even though they work fine in a terminal. Resolve the user's
/// login-shell PATH once at startup and merge it in, so every process we shell
/// out to sees the same environment a terminal would.
#[cfg(unix)]
fn adopt_login_shell_path() {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    // Interactive login shell so nvm/rbenv-style rc-file setup applies.
    // Markers isolate the value from any greeting the rc files print.
    let out = std::process::Command::new(&shell)
        .args(["-ilc", "printf '__PATH__%s__PATH__' \"$PATH\""])
        .output();
    let login_path = match out {
        Ok(o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout).to_string();
            stdout
                .split("__PATH__")
                .nth(1)
                .map(str::to_string)
                .unwrap_or_default()
        }
        _ => String::new(),
    };
    if login_path.is_empty() {
        return;
    }
    // Keep existing entries first so a dev-mode PATH keeps its precedence.
    let current = std::env::var("PATH").unwrap_or_default();
    let mut merged: Vec<String> = Vec::new();
    for dir in current.split(':').chain(login_path.split(':')) {
        if !dir.is_empty() && !merged.iter().any(|d| d == dir) {
            merged.push(dir.to_string());
        }
    }
    std::env::set_var("PATH", merged.join(":"));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(unix)]
    adopt_login_shell_path();

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
            app::rename_suite,
            app::delete_suite,
            app::rename_section,
            app::delete_section,
            app::list_suites,
            app::list_cases,
            app::get_case,
            app::save_case,
            app::create_case,
            app::delete_case,
            app::move_case,
            app::duplicate_case,
            app::git_status,
            app::list_branches,
            app::switch_branch,
            app::create_branch,
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
            app::open_url,
            app::open_in_editor,
            app::list_agents,
            app::coverage,
            app::automation_context,
            app::generation_prompt,
            app::automation_setup,
            app::save_automation_setup,
            app::file_diff,
            app::read_spec,
            app::write_spec,
            app::accept_generation,
            app::link_generated_specs,
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
            app::merge_remote,
            app::stash_pop,
            app::complete_merge,
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
