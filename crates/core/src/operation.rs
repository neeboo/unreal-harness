//! Durable operation values: serialisable, versioned, and inert by construction.
//!
//! An [`Operation`] is a *description of work*, never the work. It is the unit
//! that makes a session's execution replayable: because a translator can only
//! produce operations (see [`crate::translator`]) and because every operation is
//! lossless data, the coordinator can persist what it intends to do before
//! anything happens.
//!
//! # Versions are part of the value
//!
//! An operation carries its own [`Version`]. A reader that meets an operation it
//! does not understand refuses it with [`DecodeError::UnsupportedVersion`]
//! rather than guessing — the same "fail loud, never silently degrade" rule the
//! rest of the harness follows. Because the version travels inside the value, an
//! old record stays readable after the enum grows.

use serde::{Deserialize, Serialize};

/// Stable identity of one operation, allocated by [`crate::translator::Submit`].
///
/// A newtype rather than a bare integer so an operation id can never be passed
/// where a turn, a step, or a session id is expected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct OperationId(u64);

impl OperationId {
    /// Wrap a raw identity. Callers that own allocation use this.
    pub const fn new(raw: u64) -> Self {
        Self(raw)
    }

    /// The raw identity, for storage and diagnostics.
    pub const fn get(self) -> u64 {
        self.0
    }
}

/// What an operation does, as a closed vocabulary.
///
/// The set is small on purpose: a new capability means a new variant AND a new
/// version, so an old reader refuses it instead of misreading it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpName {
    /// Evaluate a pure expression or program.
    Compute,
    /// Create a file with the given contents.
    FileCreate,
    /// Read a file.
    FileRead,
    /// Start a process.
    ProcessStart,
}

/// The schema version of an operation's `state` payload.
///
/// `NonZeroU16` is deliberate: a version of zero is meaningless, and making it
/// unrepresentable removes a whole class of "is this initialised?" bugs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "u16", into = "u16")]
pub struct Version(std::num::NonZeroU16);

impl Version {
    /// The first version of every operation kind.
    pub const V1: Self = Self(match std::num::NonZeroU16::new(1) {
        Some(v) => v,
        None => unreachable!(),
    });

    /// Build a version, rejecting zero.
    pub fn new(raw: u16) -> Result<Self, DecodeError> {
        std::num::NonZeroU16::new(raw)
            .map(Self)
            .ok_or(DecodeError::UnsupportedVersion { found: 0 })
    }

    /// The raw version number.
    pub const fn get(self) -> u16 {
        self.0.get()
    }

    /// The versions this build can execute for one operation kind.
    ///
    /// Kept explicit so "can I run this?" is a answered by a value rather than
    /// by whatever `serde` happens to accept.
    pub const SUPPORTED: &'static [Version] = &[Version::V1];
}

impl TryFrom<u16> for Version {
    type Error = DecodeError;

    fn try_from(raw: u16) -> Result<Self, Self::Error> {
        Self::new(raw)
    }
}

impl From<Version> for u16 {
    fn from(version: Version) -> Self {
        version.get()
    }
}

/// A durable, serialisable description of work to perform.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Operation {
    name: OpName,
    version: Version,
    /// Lossless JSON state. The coordinator stores it verbatim; only the
    /// executor interprets it, and only for a version it recognises.
    state: Vec<u8>,
}

impl Operation {
    /// Build an operation from its kind, version, and JSON state bytes.
    pub fn new(name: OpName, version: Version, state: Vec<u8>) -> Self {
        Self {
            name,
            version,
            state,
        }
    }

    /// Build an operation from a JSON-serialisable payload.
    ///
    /// # Panics
    ///
    /// Panics if the payload does not serialise. A payload that cannot be
    /// recorded cannot be replayed, so failing at construction is the only
    /// honest option — a silently-dropped state would produce an operation that
    /// replays to something different from what ran.
    pub fn from_json<T: Serialize>(name: OpName, version: Version, payload: &T) -> Self {
        let state = serde_json::to_vec(payload)
            .expect("operation state must be losslessly serialisable");
        Self::new(name, version, state)
    }

    /// The operation kind.
    pub const fn name(&self) -> OpName {
        self.name
    }

    /// The schema version of this operation's state.
    pub const fn version(&self) -> Version {
        self.version
    }

    /// The raw JSON state bytes.
    pub fn state(&self) -> &[u8] {
        &self.state
    }

    /// Decode the state as a concrete payload, refusing an unsupported version.
    ///
    /// This is the enforcement point for the versioning rule: a reader that can
    /// only execute `V1` must not quietly deserialise a `V2` payload whose fields
    /// happen to overlap.
    pub fn decode_state<T: for<'de> Deserialize<'de>>(&self) -> Result<T, DecodeError> {
        if !Version::SUPPORTED.contains(&self.version) {
            return Err(DecodeError::UnsupportedVersion {
                found: self.version.get(),
            });
        }
        serde_json::from_slice(&self.state).map_err(|error| DecodeError::MalformedState {
            reason: error.to_string(),
        })
    }
}

/// Why an operation could not be read or accepted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeError {
    /// The version is not one this build can execute.
    UnsupportedVersion {
        /// The version found in the record.
        found: u16,
    },
    /// The state bytes are not the JSON the kind expects.
    MalformedState {
        /// Underlying deserialiser message.
        reason: String,
    },
}

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsupportedVersion { found } => {
                write!(f, "unsupported operation version {found}")
            }
            Self::MalformedState { reason } => {
                write!(f, "malformed operation state: {reason}")
            }
        }
    }
}

impl std::error::Error for DecodeError {}

/// Why an operation was refused by a [`Manager`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AddError {
    /// A different operation already carries this identity.
    ///
    /// Starting it again would mean executing work twice, which is the failure
    /// mode idempotency exists to prevent.
    AlreadyStarted {
        /// The identity that was already used.
        id: OperationId,
    },
}

impl std::fmt::Display for AddError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AlreadyStarted { id } => {
                write!(f, "operation {} has already been started", id.get())
            }
        }
    }
}

impl std::error::Error for AddError {}

/// At-most-once acceptance of operations.
///
/// The manager is the boundary between "the coordinator decided to do this" and
/// "it happens". It guarantees that one identity starts at most once for the
/// manager's lifetime, which is what lets a crash-recovered session re-submit
/// its intent without re-executing anything.
///
/// Deliberately synchronous and I/O-free: an implementation records intent. How
/// work is dispatched — in-process actor, remote sandbox — is a different
/// concern that does not change this contract.
pub trait Manager {
    /// Accept an operation for execution at most once per identity.
    ///
    /// # Errors
    ///
    /// Returns [`AddError::AlreadyStarted`] when the identity was already used.
    fn add(&mut self, id: OperationId, operation: Operation) -> Result<(), AddError>;

    /// Whether this identity has been accepted.
    fn is_started(&self, id: OperationId) -> bool;
}

/// The reference in-memory [`Manager`]: records acceptance, dispatches nothing.
///
/// Useful as a test double and as the shape a durable implementation follows.
#[derive(Debug, Default)]
pub struct RecordingManager {
    accepted: std::collections::BTreeMap<OperationId, Operation>,
}

impl RecordingManager {
    /// An empty manager.
    pub fn new() -> Self {
        Self::default()
    }

    /// Every accepted operation, ordered by identity.
    pub fn accepted(&self) -> &std::collections::BTreeMap<OperationId, Operation> {
        &self.accepted
    }
}

impl Manager for RecordingManager {
    fn add(&mut self, id: OperationId, operation: Operation) -> Result<(), AddError> {
        if self.accepted.contains_key(&id) {
            return Err(AddError::AlreadyStarted { id });
        }
        self.accepted.insert(id, operation);
        Ok(())
    }

    fn is_started(&self, id: OperationId) -> bool {
        self.accepted.contains_key(&id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
    struct ComputeState {
        expr: String,
    }

    #[test]
    fn an_operation_round_trips_through_json() {
        let operation = Operation::from_json(
            OpName::Compute,
            Version::V1,
            &ComputeState {
                expr: "1+1".to_owned(),
            },
        );

        // The description survives serialisation, which is what "durable" means
        // here: a recovered session reads back the same intent.
        let encoded = serde_json::to_vec(&operation).expect("operation must serialise");
        let decoded: Operation = serde_json::from_slice(&encoded).expect("operation must decode");
        assert_eq!(decoded, operation);
        assert_eq!(
            decoded.decode_state::<ComputeState>().expect("known version"),
            ComputeState {
                expr: "1+1".to_owned()
            }
        );
    }

    #[test]
    fn an_unsupported_version_is_refused_rather_than_guessed() {
        let future = Operation::from_json(
            OpName::Compute,
            Version::new(2).expect("2 is a valid version number"),
            &ComputeState {
                expr: "1+1".to_owned(),
            },
        );

        // The payload happens to be decodable, and it is still refused: a newer
        // schema is not a superset of an older one.
        assert_eq!(
            future.decode_state::<ComputeState>(),
            Err(DecodeError::UnsupportedVersion { found: 2 })
        );
    }

    #[test]
    fn version_zero_is_unrepresentable() {
        assert!(matches!(
            Version::new(0),
            Err(DecodeError::UnsupportedVersion { found: 0 })
        ));
        // And it cannot arrive through serde either.
        assert!(serde_json::from_str::<Version>("0").is_err());
    }

    #[test]
    fn malformed_state_reports_the_underlying_reason() {
        let operation = Operation::new(OpName::Compute, Version::V1, b"not json".to_vec());
        match operation.decode_state::<ComputeState>() {
            Err(DecodeError::MalformedState { reason }) => assert!(!reason.is_empty()),
            other => panic!("expected MalformedState, got {other:?}"),
        }
    }

    #[test]
    fn a_manager_starts_each_identity_at_most_once() {
        let mut manager = RecordingManager::new();
        let id = OperationId::new(1);
        let operation = Operation::new(OpName::FileRead, Version::V1, b"{}".to_vec());

        assert!(!manager.is_started(id));
        manager.add(id, operation.clone()).expect("first add wins");
        assert!(manager.is_started(id));

        // Redelivery is expected after a crash. Re-accepting would execute the
        // work twice; refusing is the contract.
        assert_eq!(
            manager.add(id, operation),
            Err(AddError::AlreadyStarted { id })
        );
        assert_eq!(manager.accepted().len(), 1);
    }
}
