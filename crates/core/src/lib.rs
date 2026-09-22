//! # unreal-harness-core
//!
//! The type-discipline half of RSI-Harness: pure, synchronous, I/O-free decision
//! types. Nothing in this crate performs I/O, spawns a task, or reads a clock.
//!
//! # Why this is Rust and the rest is TypeScript
//!
//! The dsh plugins ([`packages/`](../../packages)) host the agent: sessions,
//! tools, sandbox, UI. That work is TypeScript because the host is. This crate
//! exists for a different reason: **one guarantee that TypeScript cannot
//! express.**
//!
//! A tool-call translator must validate a call and describe the work it implies
//! without doing anything. In a language where "do nothing" is a comment, that
//! rule survives only as long as reviewers do. Here the translator receives
//! [`translator::Submit`] and nothing else — a handle whose only method records
//! inert data — so performing I/O is not forbidden, it is *unnameable*.
//!
//! # The three invariants
//!
//! | Invariant | Where | Enforced by |
//! |---|---|---|
//! | A translator cannot perform I/O | [`translator`] | the capability it receives has no I/O to call |
//! | An operation is durable, versioned, inert data | [`operation`] | a version travels inside the value; an unknown one is refused, not guessed |
//! | A context build accounts for every reduction | [`context`] | a reduction cannot be performed without recording a reason |
//!
//! Each is verified by tests in its own module, including the negative case:
//! an unsupported version is refused even when its payload would happen to
//! decode, and a truncation that changes nothing is not recorded as a change.
//!
//! # What is deliberately absent
//!
//! No async runtime, no executor, no filesystem, no clock. Execution belongs to
//! a host that has one; this crate is the part that must be identical whether it
//! runs beside the agent, inside a recorded replay, or in a test that never
//! touches a disk.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod context;
pub mod operation;
pub mod translator;

pub use context::{Builder, Change, ChangeKind, Item, Report};
pub use operation::{
    AddError, DecodeError, Manager, OpName, Operation, OperationId, RecordingManager, Version,
};
pub use translator::{CallStatus, NoOp, RejectAll, Submit, Translator};
