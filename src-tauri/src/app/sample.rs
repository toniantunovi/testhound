//! Seeds a demo project (the "Acme Shop" fixture shown in the Figma design)
//! so the app has realistic content on first run. Purely additive: it writes
//! suites and cases into the file store using the normal serialization path.

use crate::domain::{
    Automation, AutomationState, CaseStatus, CaseType, ConfigOption, Configuration, FrontMatter,
    IncludeMode, Milestone, Priority, ResultSource, ResultStatus, RunState, Section, Suite,
    TestCase,
};
use crate::error::Result;
use crate::repo::runs::{self, CreateRun};
use crate::repo::{self, case_file, Paths};

struct CaseSpec {
    id: &'static str,
    title: &'static str,
    suite: &'static str,
    section: Option<&'static str>,
    priority: Priority,
    kind: CaseType,
    owner: &'static str,
    tags: &'static [&'static str],
    automation: AutomationState,
    steps: &'static [(&'static str, &'static str)],
}

pub fn seed(paths: &Paths) -> Result<()> {
    // Suites mirror the Figma tree: Checkout, Authentication, Cart, Search, Profile.
    let suites = [
        ("checkout", "Checkout", 10),
        ("auth", "Authentication", 20),
        ("cart", "Cart", 30),
        ("search", "Search", 40),
        ("profile", "Profile", 50),
    ];
    for (id, name, order) in suites {
        repo::create_suite(
            paths,
            &Suite {
                id: id.to_string(),
                name: name.to_string(),
                description: None,
                order,
            },
        )?;
    }

    // A couple of sections under Checkout.
    write_section(
        paths,
        "checkout",
        &Section {
            id: "cart".into(),
            name: "Cart".into(),
            parent: None,
            order: 10,
        },
    )?;
    write_section(
        paths,
        "checkout",
        &Section {
            id: "payment".into(),
            name: "Payment".into(),
            parent: None,
            order: 20,
        },
    )?;
    write_section(
        paths,
        "checkout",
        &Section {
            id: "confirmation".into(),
            name: "Confirmation".into(),
            parent: None,
            order: 30,
        },
    )?;

    let cases: &[CaseSpec] = &[
        CaseSpec {
            id: "TC-0007",
            title: "Add item to cart from product page",
            suite: "checkout",
            section: Some("cart"),
            priority: Priority::High,
            kind: CaseType::Functional,
            owner: "priya",
            tags: &["cart", "p1", "checkout"],
            automation: AutomationState::Linked,
            steps: &[
                ("Open the product page for \"Blue Mug\"", "Product details and an \"Add to cart\" button are visible"),
                ("Click \"Add to cart\"", "Cart badge increments to 1; toast \"Added to cart\" appears"),
                ("Open the cart", "\"Blue Mug\" is listed with quantity 1 and correct price"),
            ],
        },
        CaseSpec {
            id: "TC-0008",
            title: "Remove item from cart",
            suite: "checkout",
            section: Some("cart"),
            priority: Priority::Medium,
            kind: CaseType::Functional,
            owner: "marco",
            tags: &["cart", "checkout"],
            automation: AutomationState::Drifted,
            steps: &[
                ("Open the cart with one item", "The item row shows a remove control"),
                ("Click remove", "The row disappears and the cart badge decrements"),
            ],
        },
        CaseSpec {
            id: "TC-0009",
            title: "Increment quantity when re-adding an item",
            suite: "checkout",
            section: Some("cart"),
            priority: Priority::High,
            kind: CaseType::Functional,
            owner: "priya",
            tags: &["cart", "p1"],
            automation: AutomationState::Linked,
            steps: &[
                ("Add \"Blue Mug\" to the cart twice", "Quantity shows 2 rather than two rows"),
            ],
        },
        CaseSpec {
            id: "TC-0010",
            title: "Cart persists across sessions",
            suite: "checkout",
            section: Some("cart"),
            priority: Priority::Medium,
            kind: CaseType::E2e,
            owner: "lena",
            tags: &["cart"],
            automation: AutomationState::None,
            steps: &[
                ("Add an item, then sign out and back in", "The cart still contains the item"),
            ],
        },
        CaseSpec {
            id: "TC-0011",
            title: "Empty cart state renders",
            suite: "checkout",
            section: Some("cart"),
            priority: Priority::Low,
            kind: CaseType::Functional,
            owner: "priya",
            tags: &["cart"],
            automation: AutomationState::Linked,
            steps: &[("Open the cart with no items", "An empty-state message and a \"Browse products\" link are shown")],
        },
        CaseSpec {
            id: "TC-0014",
            title: "Cart totals recalculate with tax",
            suite: "checkout",
            section: Some("payment"),
            priority: Priority::Critical,
            kind: CaseType::Functional,
            owner: "priya",
            tags: &["checkout", "p1", "tax"],
            automation: AutomationState::Linked,
            steps: &[("Add items and enter a taxable address", "Subtotal, tax, and total are correct")],
        },
        CaseSpec {
            id: "TC-0001",
            title: "Login with valid credentials",
            suite: "auth",
            section: None,
            priority: Priority::Critical,
            kind: CaseType::Smoke,
            owner: "marco",
            tags: &["auth", "p1", "smoke"],
            automation: AutomationState::Linked,
            steps: &[
                ("Open the login page", "Email and password fields are visible"),
                ("Enter valid credentials and submit", "User lands on the dashboard"),
            ],
        },
        CaseSpec {
            id: "TC-0002",
            title: "Login with invalid credentials shows an error",
            suite: "auth",
            section: None,
            priority: Priority::High,
            kind: CaseType::Negative,
            owner: "marco",
            tags: &["auth", "negative"],
            automation: AutomationState::None,
            steps: &[("Submit a wrong password", "An inline error is shown and no session is created")],
        },
        CaseSpec {
            id: "TC-0021",
            title: "Search returns relevant products",
            suite: "search",
            section: None,
            priority: Priority::High,
            kind: CaseType::Functional,
            owner: "lena",
            tags: &["search", "p1"],
            automation: AutomationState::Linked,
            steps: &[("Search for \"mug\"", "Results contain products whose title matches")],
        },
        CaseSpec {
            id: "TC-0031",
            title: "Update profile display name",
            suite: "profile",
            section: None,
            priority: Priority::Medium,
            kind: CaseType::Functional,
            owner: "priya",
            tags: &["profile"],
            automation: AutomationState::Drifted,
            steps: &[("Change the display name and save", "The new name appears in the header")],
        },
    ];

    for spec in cases {
        write_case(paths, spec)?;
    }

    // Advance the id counter past the highest seeded id so freshly created
    // cases never collide with the demo data.
    let max = cases
        .iter()
        .filter_map(|c| c.id.strip_prefix("TC-").and_then(|n| n.parse::<u64>().ok()))
        .max()
        .unwrap_or(0);
    let mut project = repo::load_project(paths)?;
    project.next_case_id = max + 1;
    repo::save_project(paths, &project)?;

    seed_runs(paths)?;

    Ok(())
}

/// Seed configurations, milestones, and a few runs with recorded results so the
/// Runs and Dashboard screens have realistic content on first launch.
fn seed_runs(paths: &Paths) -> Result<()> {
    // A browser × form-factor configuration matrix.
    runs::write_configuration(
        paths,
        &Configuration {
            id: "browsers".into(),
            name: "Browsers".into(),
            options: vec![
                ConfigOption { id: "chromium-desktop".into(), name: "Chromium · Desktop".into() },
                ConfigOption { id: "firefox-desktop".into(), name: "Firefox · Desktop".into() },
                ConfigOption { id: "webkit-mobile".into(), name: "WebKit · Mobile".into() },
            ],
        },
    )?;

    for m in [
        Milestone {
            id: "v2-4-release".into(),
            name: "v2.4 Release".into(),
            description: Some("Checkout rework and auth hardening".into()),
            due: Some("2026-07-31".into()),
            completed: false,
        },
        Milestone {
            id: "v2-5-release".into(),
            name: "v2.5 Release".into(),
            description: None,
            due: Some("2026-09-15".into()),
            completed: false,
        },
    ] {
        runs::write_milestone(paths, &m)?;
    }

    // Regression R3: a filter run, left in progress with one failure and one
    // case still untested.
    let r3 = runs::create_run(
        paths,
        CreateRun {
            name: "Regression R3".into(),
            milestone: Some("v2-4-release".into()),
            configuration: vec!["chromium-desktop".into()],
            description: Some("Full regression before v2.4".into()),
            assignee: Some("marco".into()),
            mode: IncludeMode::Filter,
            query: Some("suite:checkout OR tag:p1".into()),
            suites: vec![],
            cases: vec![],
        },
    )?;
    record(paths, &r3.id, ResultStatus::Passed, "marco", &[
        "TC-0001", "TC-0007", "TC-0009", "TC-0014", "TC-0021",
    ])?;
    record(paths, &r3.id, ResultStatus::Failed, "marco", &["TC-0008"])?;
    // A blocked case and one awaiting retest, so results are not all pass/fail.
    record(paths, &r3.id, ResultStatus::Blocked, "marco", &["TC-0010"])?;
    record(paths, &r3.id, ResultStatus::Retest, "marco", &["TC-0011"])?;

    // Smoke nightly: a completed, all-green smoke pass.
    let smoke = runs::create_run(
        paths,
        CreateRun {
            name: "Smoke nightly".into(),
            milestone: Some("v2-4-release".into()),
            configuration: vec!["chromium-desktop".into(), "webkit-mobile".into()],
            description: None,
            assignee: Some("marco".into()),
            mode: IncludeMode::Filter,
            query: Some("type:smoke OR tag:smoke".into()),
            suites: vec![],
            cases: vec![],
        },
    )?;
    record(paths, &smoke.id, ResultStatus::Passed, "ci", &["TC-0001"])?;
    runs::set_run_state(paths, &smoke.id, RunState::Complete)?;

    // Checkout rework: a completed suite run with a couple of failures.
    let checkout = runs::create_run(
        paths,
        CreateRun {
            name: "Checkout rework".into(),
            milestone: None,
            configuration: vec!["chromium-desktop".into()],
            description: Some("Targeted pass over the checkout suite".into()),
            assignee: Some("priya".into()),
            mode: IncludeMode::Suite,
            query: None,
            suites: vec!["checkout".into()],
            cases: vec![],
        },
    )?;
    // TC-0009 passed in R3 but fails here: a regression, so Reports flags it as
    // flaky (results disagree across runs).
    record(paths, &checkout.id, ResultStatus::Passed, "priya", &[
        "TC-0007", "TC-0011", "TC-0014",
    ])?;
    record(paths, &checkout.id, ResultStatus::Failed, "priya", &[
        "TC-0009", "TC-0008", "TC-0010",
    ])?;
    runs::set_run_state(paths, &checkout.id, RunState::Complete)?;

    Ok(())
}

/// Record the same status for several cases in a run (demo convenience).
fn record(paths: &Paths, run_id: &str, status: ResultStatus, by: &str, cases: &[&str]) -> Result<()> {
    for case in cases {
        runs::set_result(
            paths,
            run_id,
            case,
            status,
            None,
            Some(by.to_string()),
            ResultSource::Manual,
        )?;
    }
    Ok(())
}

fn write_section(paths: &Paths, suite: &str, section: &Section) -> Result<()> {
    let dir = paths.th.join("suites").join(suite).join("sections");
    std::fs::create_dir_all(&dir)?;
    let yaml = serde_yaml::to_string(section)?;
    std::fs::write(dir.join(format!("{}.yml", section.id)), yaml)?;
    Ok(())
}

fn write_case(paths: &Paths, spec: &CaseSpec) -> Result<()> {
    let mut body = String::from("## Preconditions\n- User is on the Acme Shop storefront\n\n## Steps\n");
    for (i, (action, expected)) in spec.steps.iter().enumerate() {
        body.push_str(&format!(
            "{}. {}\n   - **Expected:** {}\n",
            i + 1,
            action,
            expected
        ));
    }

    let source_hash = case_file::content_hash(&body);
    let (state, specs, last_synced, generator, source) = match spec.automation {
        AutomationState::Linked => (
            AutomationState::Linked,
            vec![format!("tests/{}/{}.spec.ts", spec.suite, slugish(spec.title))],
            Some("2026-07-05T10:22:00Z".to_string()),
            Some("claude-code".to_string()),
            Some(source_hash.clone()),
        ),
        AutomationState::Drifted => (
            AutomationState::Drifted,
            vec![format!("tests/{}/{}.spec.ts", spec.suite, slugish(spec.title))],
            Some("2026-07-01T08:00:00Z".to_string()),
            Some("claude-code".to_string()),
            // Different hash than current body -> drifted.
            Some("000000".to_string()),
        ),
        _ => (AutomationState::None, vec![], None, None, None),
    };

    let front = FrontMatter {
        id: spec.id.to_string(),
        title: spec.title.to_string(),
        suite: spec.suite.to_string(),
        section: spec.section.map(str::to_string),
        priority: spec.priority,
        kind: spec.kind,
        status: CaseStatus::Active,
        owner: Some(spec.owner.to_string()),
        tags: spec.tags.iter().map(|s| s.to_string()).collect(),
        references: vec![],
        estimate: None,
        automation: Automation {
            state,
            specs,
            last_synced,
            source_hash: source,
            generator,
        },
        custom: Default::default(),
        created: Some("2026-06-01T09:00:00Z".to_string()),
        updated: Some("2026-07-05T10:22:00Z".to_string()),
    };

    let parsed = crate::domain::parse_body(&body);
    let case = TestCase {
        front,
        body,
        steps: parsed.steps,
        preconditions: parsed.preconditions,
    };
    repo::save_case(paths, &case)?;
    Ok(())
}

fn slugish(title: &str) -> String {
    slug::slugify(title)
}
