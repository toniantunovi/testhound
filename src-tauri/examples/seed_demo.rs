//! Dev tool: scaffold and seed a demo TestHound project into a target dir.
//! Usage: cargo run --example seed_demo -- <path> [project-name]

use testhound_lib::app::sample;
use testhound_lib::repo::{self, Paths};

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("usage: seed_demo <path> [name]");
    let name = args.next().unwrap_or_else(|| "Acme Shop".to_string());

    let root = std::path::PathBuf::from(&path);
    std::fs::create_dir_all(&root).unwrap();
    git2::Repository::init(&root).unwrap();

    repo::scaffold(&root, &name, "testhound").unwrap();
    let paths = Paths::new(&root, "testhound");
    sample::seed(&paths).unwrap();

    println!("Seeded '{name}' into {}", root.display());
}
