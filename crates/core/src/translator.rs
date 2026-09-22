//! A pure translator: the type-level answer to "how do you know a tool call
//! translator cannot perform I/O?"
//!
//! In a language without a capability type, that rule lives in a comment and in
//! review. Here it is a property of the interface: a translator is handed ONLY
//! [`Submit`], a handle that can do exactly one inert thing, and there is no
//! other channel through which it could reach a filesystem, a socket, a clock,
//! or another queue.
//!
//! # Why this shape
//!
//! The tempting alternative — pass the translator a context that "happens to"
//! offer I/O, and document that it must not use it — cannot be enforced. The
//! guarantee this module makes is narrower and real: **a `Translator`
//! implementation cannot name an I/O capability, because none is in scope.**
//!
//! ```
//! use unreal_harness_core::operation::{Operation, OpName, Version};
//! use unreal_harness_core::translator::{CallStatus, Submit, Translator};
//!
//! struct Echo;
//!
//! impl Translator for Echo {
//!     fn translate(&self, ctx: &mut dyn Submit, call: &str) -> CallStatus {
//!         // The only thing the translator can produce is an inert operation.
//!         let id = ctx.submit(Operation::new(OpName::Compute, Version::V1, b"{}".to_vec()));
//!         CallStatus::waiting([id])
//!     }
//! }
//! # assert_eq!(Echo.translate(&mut Recorder::default(), "ignored").is_waiting(), true);
//! # #[derive(Default)] struct Recorder(Vec<Operation>);
//! # impl Submit for Recorder {
//! #     fn submit(&mut self, op: Operation) -> OperationId { self.0.push(op); OperationId::new(1) }
//! # }
//! # use unreal_harness_core::operation::OperationId;
//! ```

use crate::operation::{Operation, OperationId};

/// The only capability a [`Translator`] receives.
///
/// `Submit` deliberately exposes exactly one method, and that method does one
/// inert thing: it records a serialisable operation and returns its identity.
/// There is no `spawn`, no `fs`, no `sleep`, no channel. A translator that wants
/// to read a file has nothing to call.
///
/// This is the whole point of the type. `submit` must not perform I/O itself —
/// that obligation belongs to the *implementor*, which is the coordinator, and
/// the contract is stated on the method so an implementor cannot miss it.
pub trait Submit {
    /// Record an operation as inert data and return its identity.
    ///
    /// # Contract for implementors
    ///
    /// This method MUST NOT perform I/O, block, or hand the operation to a
    /// worker. It allocates an id and stores the description. Execution happens
    /// later, on another actor, after the coordinator has committed the call
    /// status alongside the operation — which is what makes replay a matter of
    /// re-reading records rather than re-running anything.
    fn submit(&mut self, operation: Operation) -> OperationId;
}

/// The outcome of translating one model tool call.
///
/// A translation either failed validation, or it references the operations it
/// submitted. It never reports execution state: whether an operation succeeded
/// is a different fact, recorded separately, and conflating the two is what
/// makes a translator impure in practice.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallStatus {
    /// The call was rejected before any operation was created.
    Invalid {
        /// Model-facing reason, already truncated by the caller if needed.
        error: String,
    },
    /// The call produced operations that are not finished yet.
    Waiting {
        /// Operations this call is waiting on, in submission order.
        waiting_for: Vec<OperationId>,
    },
    /// The call produced no work at all — a no-op tool.
    Done,
}

impl CallStatus {
    /// Build a waiting status from anything iterable of ids.
    pub fn waiting(ids: impl IntoIterator<Item = OperationId>) -> Self {
        Self::Waiting {
            waiting_for: ids.into_iter().collect(),
        }
    }

    /// Build a validation failure.
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::Invalid {
            error: message.into(),
        }
    }

    /// Whether this status is waiting on operations.
    pub fn is_waiting(&self) -> bool {
        matches!(self, Self::Waiting { .. })
    }

    /// The operations this call awaits, empty for the other variants.
    pub fn waiting_for(&self) -> &[OperationId] {
        match self {
            Self::Waiting { waiting_for } => waiting_for,
            _ => &[],
        }
    }
}

/// Validate one model tool call and produce inert operations for it.
///
/// Implementations are synchronous and must not perform I/O. The signature is
/// the enforcement: `&dyn Submit` is the whole world available to a translator,
/// and it cannot do anything that would make translation observable to the
/// outside.
pub trait Translator {
    /// Translate one call. Receives no clock, no paths, no network.
    fn translate(&self, ctx: &mut dyn Submit, call: &str) -> CallStatus;
}

/// A translator that always fails validation, useful as a null implementation.
pub struct RejectAll {
    reason: String,
}

impl RejectAll {
    /// Build a rejecting translator with a fixed reason.
    pub fn new(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
        }
    }
}

impl Translator for RejectAll {
    fn translate(&self, _ctx: &mut dyn Submit, _call: &str) -> CallStatus {
        CallStatus::invalid(self.reason.clone())
    }
}

/// A translator that does nothing — the shape a read-only tool with no side
/// effect takes.
pub struct NoOp;

impl Translator for NoOp {
    fn translate(&self, _ctx: &mut dyn Submit, _call: &str) -> CallStatus {
        CallStatus::Done
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::operation::{OpName, Version};

    /// A `Submit` that records what it was handed, so tests can assert on the
    /// operations a translator produced without any executor existing.
    #[derive(Default)]
    struct Recorder {
        submitted: Vec<Operation>,
        next: u64,
    }

    impl Submit for Recorder {
        fn submit(&mut self, operation: Operation) -> OperationId {
            self.next += 1;
            self.submitted.push(operation);
            OperationId::new(self.next)
        }
    }

    struct SubmitOnce;

    impl Translator for SubmitOnce {
        fn translate(&self, ctx: &mut dyn Submit, _call: &str) -> CallStatus {
            let id = ctx.submit(Operation::new(
                OpName::Compute,
                Version::V1,
                br#"{"expr":"1+1"}"#.to_vec(),
            ));
            CallStatus::waiting([id])
        }
    }

    #[test]
    fn a_translator_can_only_submit_inert_operations() {
        let mut recorder = Recorder::default();
        let status = SubmitOnce.translate(&mut recorder, "ignored");

        assert!(status.is_waiting());
        assert_eq!(status.waiting_for().len(), 1);
        // Translation produced a *description*, not an effect: nothing ran, and
        // the operation is fully serialisable data.
        assert_eq!(recorder.submitted.len(), 1);
        assert_eq!(recorder.submitted[0].name(), OpName::Compute);
    }

    #[test]
    fn translation_is_repeatable_and_side_effect_free() {
        // Two translations of the same call produce identical operations apart
        // from identity — this is what makes a recorded status replayable.
        let mut first = Recorder::default();
        let mut second = Recorder::default();
        SubmitOnce.translate(&mut first, "same");
        SubmitOnce.translate(&mut second, "same");

        assert_eq!(first.submitted, second.submitted);
    }

    #[test]
    fn invalid_calls_reference_no_operations() {
        let mut recorder = Recorder::default();
        let status = RejectAll::new("bad arguments").translate(&mut recorder, "call");

        assert_eq!(
            status,
            CallStatus::Invalid {
                error: "bad arguments".to_owned()
            }
        );
        assert!(recorder.submitted.is_empty());
    }

    #[test]
    fn a_no_op_tool_submits_nothing() {
        let mut recorder = Recorder::default();
        assert_eq!(NoOp.translate(&mut recorder, "call"), CallStatus::Done);
        assert!(recorder.submitted.is_empty());
    }
}
