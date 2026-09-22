//! I/O-free context construction with a typed account of every omission.
//!
//! A context builder decides what the model sees. That makes it the most
//! consequential component in a harness and, without a record, the least
//! auditable: a builder that silently drops a tool result, truncates a diff, or
//! compacts a turn leaves no trace of the decision.
//!
//! This module fixes that at the type level. Build a context, and you get back
//! not just the items but a [`Report`] naming every [`Change`] you made —
//! omitted, truncated, compacted, or demoted — with the source and the reason.
//!
//! # What the report is for
//!
//! It is not logging. It is the input to a decision the harness has to make
//! afterwards: replay must reproduce the model input, and an audit must be able
//! to answer "why isn't this file in the context?". A builder that cannot
//! answer that has not actually built a context, it has guessed at one.
//!
//! ```
//! use unreal_harness_core::context::{Builder, ChangeKind, Item};
//!
//! let mut builder = Builder::new();
//! builder.push(Item::new("read", "short content"));
//! let (items, report) = builder.finish();
//!
//! assert_eq!(items.len(), 1);
//! assert!(report.is_clean());
//! ```

/// The kind of change a builder made to one piece of context.
///
/// A closed set. "Somehow reduced" is not a category that can be audited, so it
/// is not expressible.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ChangeKind {
    /// The item was left out entirely.
    Omitted,
    /// The item is present but shorter than its source.
    Truncated,
    /// The item was replaced by a summary.
    Compacted,
    /// The item is present in full, but at a lower fidelity tier than its source
    /// carried — the case a scoring layer produces.
    Demoted,
}

impl ChangeKind {
    /// Whether the change lost information relative to the source.
    ///
    /// A demotion may or may not, which is exactly why it is its own kind: a
    /// caller that must not lose information needs to treat it as suspicious
    /// while a caller that must not lose *the item* can accept it.
    pub const fn loses_information(self) -> bool {
        matches!(self, Self::Omitted | Self::Truncated | Self::Compacted)
    }

    /// A stable machine-readable name, for records that outlive the enum.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Omitted => "omitted",
            Self::Truncated => "truncated",
            Self::Compacted => "compacted",
            Self::Demoted => "demoted",
        }
    }
}

/// One recorded change, with enough detail to justify it later.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Change {
    /// What was done.
    pub kind: ChangeKind,
    /// Which item it was done to.
    pub source: String,
    /// Why, in a form a reader can act on.
    pub reason: String,
}

impl Change {
    /// Record one change.
    pub fn new(kind: ChangeKind, source: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            kind,
            source: source.into(),
            reason: reason.into(),
        }
    }

    /// A short human-readable line, for diagnostics and transcripts.
    pub fn describe(&self) -> String {
        format!(
            "{} {}: {}",
            self.kind.as_str(),
            self.source,
            self.reason
        )
    }
}

/// Every change a build made, in the order it made them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Report {
    changes: Vec<Change>,
}

impl Report {
    /// An empty report — a build that changed nothing.
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a change.
    pub fn record(&mut self, change: Change) {
        self.changes.push(change);
    }

    /// Record a change from its parts.
    pub fn note(&mut self, kind: ChangeKind, source: impl Into<String>, reason: impl Into<String>) {
        self.record(Change::new(kind, source, reason));
    }

    /// Every change, in order.
    pub fn changes(&self) -> &[Change] {
        &self.changes
    }

    /// Whether nothing was changed.
    pub fn is_clean(&self) -> bool {
        self.changes.is_empty()
    }

    /// Whether any change lost information.
    pub fn lost_information(&self) -> bool {
        self.changes.iter().any(|change| change.kind.loses_information())
    }

    /// The changes made to one item, in order.
    pub fn changes_to<'a>(&'a self, source: &'a str) -> impl Iterator<Item = &'a Change> + 'a {
        self.changes
            .iter()
            .filter(move |change| change.source == source)
    }

    /// A multi-line account, for a transcript or a failure message.
    pub fn describe(&self) -> String {
        if self.changes.is_empty() {
            return "no changes".to_owned();
        }
        self.changes
            .iter()
            .map(Change::describe)
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// One piece of context, before or after the builder's decisions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    /// Stable identity, used as a change's `source`.
    pub source: String,
    /// The content itself.
    pub content: String,
}

impl Item {
    /// Build an item.
    pub fn new(source: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            source: source.into(),
            content: content.into(),
        }
    }

    /// Content length in bytes.
    pub fn len(&self) -> usize {
        self.content.len()
    }

    /// Whether the content is empty.
    pub fn is_empty(&self) -> bool {
        self.content.is_empty()
    }
}

/// Assemble context in memory, recording every reduction as it happens.
///
/// The builder never performs I/O and never removes a change from the report: a
/// build either kept an item whole or said what it did to it. That property is
/// what lets a later reader reconstruct the input from the record alone.
#[derive(Debug, Default)]
pub struct Builder {
    items: Vec<Item>,
    report: Report,
}

impl Builder {
    /// An empty builder.
    pub fn new() -> Self {
        Self::default()
    }

    /// Keep an item in full.
    pub fn push(&mut self, item: Item) {
        self.items.push(item);
    }

    /// Keep an item in full, from its parts.
    pub fn push_parts(&mut self, source: impl Into<String>, content: impl Into<String>) {
        self.push(Item::new(source, content));
    }

    /// Account for an item that was left out.
    ///
    /// Recorded rather than ignored: "we never considered it" and "we decided
    /// against it" are different facts, and only one of them is defensible.
    pub fn omit(&mut self, source: impl Into<String>, reason: impl Into<String>) {
        self.report.note(ChangeKind::Omitted, source, reason);
    }

    /// Keep the first `keep` bytes of an item, recording the truncation.
    ///
    /// # Panics
    ///
    /// Panics if `keep` does not fall on a UTF-8 character boundary. A cut that
    /// splits a character would produce content the model cannot read, so it is
    /// a programming error rather than a runtime condition.
    pub fn push_truncated(&mut self, item: Item, keep: usize, reason: impl Into<String>) {
        let reason = reason.into();
        let total = item.content.len();
        if keep >= total {
            self.push(item);
            return;
        }
        assert!(
            item.content.is_char_boundary(keep),
            "truncation must fall on a UTF-8 boundary"
        );
        let source = item.source.clone();
        self.items.push(Item {
            source: item.source,
            content: item.content[..keep].to_owned(),
        });
        self.report.note(
            ChangeKind::Truncated,
            source,
            format!("{reason} ({keep}/{total} bytes kept)"),
        );
    }

    /// Replace an item with a summary, recording the compaction.
    pub fn push_compacted(
        &mut self,
        source: impl Into<String>,
        summary: impl Into<String>,
        reason: impl Into<String>,
    ) {
        let source = source.into();
        self.items.push(Item::new(source.clone(), summary));
        self.report.note(ChangeKind::Compacted, source, reason);
    }

    /// Keep an item, but record that it arrived at a lower fidelity tier.
    pub fn push_demoted(
        &mut self,
        item: Item,
        reason: impl Into<String>,
    ) {
        let source = item.source.clone();
        self.items.push(item);
        self.report.note(ChangeKind::Demoted, source, reason);
    }

    /// The items as built so far.
    pub fn items(&self) -> &[Item] {
        &self.items
    }

    /// The changes recorded so far.
    pub fn report(&self) -> &Report {
        &self.report
    }

    /// Finish the build, returning the items and the account of the decisions.
    pub fn finish(self) -> (Vec<Item>, Report) {
        (self.items, self.report)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_clean_build_reports_nothing() {
        let mut builder = Builder::new();
        builder.push(Item::new("read:main.rs", "fn main() {}"));
        let (items, report) = builder.finish();

        assert_eq!(items.len(), 1);
        assert!(report.is_clean());
        assert!(!report.lost_information());
        assert_eq!(report.describe(), "no changes");
    }

    #[test]
    fn every_reduction_is_accounted_for_with_a_reason() {
        let mut builder = Builder::new();
        builder.omit("read:huge.log", "exceeds the context budget");
        builder.push_truncated(
            Item::new("grep:hits", "abcdefghij"),
            4,
            "only the head is relevant",
        );
        builder.push_compacted("turn:3", "[summary]", "compaction threshold reached");
        builder.push_demoted(Item::new("read:notes.md", "# Notes"), "scored tier 2");

        let (items, report) = builder.finish();
        // The omitted item produced no content but a full account; the other
        // three produced content AND an account.
        assert_eq!(items.len(), 3);
        assert_eq!(report.changes().len(), 4);
        assert!(report.lost_information());

        let kinds: Vec<_> = report.changes().iter().map(|c| c.kind).collect();
        assert_eq!(
            kinds,
            vec![
                ChangeKind::Omitted,
                ChangeKind::Truncated,
                ChangeKind::Compacted,
                ChangeKind::Demoted,
            ]
        );
        // Reasons survive, so an audit can answer "why isn't this in context?".
        assert!(report
            .changes()
            .iter()
            .all(|change| !change.reason.is_empty()));
    }

    #[test]
    fn a_truncation_records_the_exact_budget_it_kept() {
        let mut builder = Builder::new();
        builder.push_truncated(Item::new("read:long", "0123456789"), 3, "head only");
        let (items, report) = builder.finish();

        assert_eq!(items[0].content, "012");
        assert!(report.changes()[0].reason.contains("3/10 bytes"));
    }

    #[test]
    fn a_budget_that_keeps_everything_is_not_a_change() {
        let mut builder = Builder::new();
        builder.push_truncated(Item::new("read:short", "abc"), 99, "head only");
        let (items, report) = builder.finish();

        assert_eq!(items[0].content, "abc");
        // Asking to truncate to more than the length is not a reduction, and
        // recording it as one would make the report untrustworthy.
        assert!(report.is_clean());
    }

    #[test]
    fn changes_are_addressed_by_source_so_one_item_can_be_traced() {
        let mut builder = Builder::new();
        builder.omit("read:a", "budget");
        builder.push_truncated(Item::new("read:b", "abcdef"), 2, "head");
        builder.omit("read:a", "again");
        let (_, report) = builder.finish();

        let for_a: Vec<_> = report.changes_to("read:a").collect();
        assert_eq!(for_a.len(), 2);
        assert_eq!(report.changes_to("read:b").count(), 1);
        assert_eq!(report.changes_to("read:missing").count(), 0);
    }

    #[test]
    fn only_lossy_kinds_report_lost_information() {
        assert!(ChangeKind::Omitted.loses_information());
        assert!(ChangeKind::Truncated.loses_information());
        assert!(ChangeKind::Compacted.loses_information());
        // A demotion keeps the item; whether it lost nuance is the scorer's
        // claim, not this enum's.
        assert!(!ChangeKind::Demoted.loses_information());
    }

    #[test]
    fn report_rendering_is_stable_for_transcripts() {
        let mut builder = Builder::new();
        builder.omit("read:a", "budget");
        let (_, report) = builder.finish();
        assert_eq!(report.describe(), "omitted read:a: budget");
    }
}
