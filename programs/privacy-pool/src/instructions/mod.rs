pub mod deposit;
pub mod exit_public;
pub mod initialize_pool;
pub mod insert_leaf;
pub mod refund_pending_deposit;
pub mod skip_refunded_deposit;
pub mod spend_private;
pub mod update_approved_root;
pub mod update_config;

// Every module exports a `handler`; the program calls them by full path.
#[allow(ambiguous_glob_reexports)]
pub use deposit::*;
#[allow(ambiguous_glob_reexports)]
pub use exit_public::*;
#[allow(ambiguous_glob_reexports)]
pub use initialize_pool::*;
#[allow(ambiguous_glob_reexports)]
pub use insert_leaf::*;
#[allow(ambiguous_glob_reexports)]
pub use refund_pending_deposit::*;
#[allow(ambiguous_glob_reexports)]
pub use skip_refunded_deposit::*;
#[allow(ambiguous_glob_reexports)]
pub use spend_private::*;
#[allow(ambiguous_glob_reexports)]
pub use update_approved_root::*;
#[allow(ambiguous_glob_reexports)]
pub use update_config::*;
