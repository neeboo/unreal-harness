"""Tests for the dsh Harbor adapter.

These cover the adapter's *pure* logic — metric folding, model-route validation
and overlay generation. The container lifecycle (Node install, npm install,
profile boot) is exercised by a real smoke run instead, because faking it would
test the fake rather than the harness.
"""

import json
import unittest

from harness_harbor.dsh_agent import (
    DEFAULT_MODEL,
    DEFAULT_NODE_VERSION,
    DEFAULT_PROVIDER,
    PROFILE,
    Dsh,
    DshRsi,
    _read_jsonl,
    _summarise,
)


def _step(input_tokens, output_tokens, cache_read=0, cache_write=0, step=1):
    return {
        "type": "status",
        "phase": "step_end",
        "step": step,
        "usage": {
            "inputTokens": input_tokens,
            "outputTokens": output_tokens,
            "cacheReadTokens": cache_read,
            "cacheWriteTokens": cache_write,
            "totalTokens": input_tokens + output_tokens + cache_read + cache_write,
        },
    }


class _AgentStub:
    """A tiny stand-in for a constructed agent.

    ``patch_layers``/``build_command`` only read a handful of attributes, and
    Harbor's constructor pulls in model-info resolution that a unit test has no
    business exercising. Stubbing keeps these tests about the adapter's own
    logic, and avoids leaving temporary directories behind.
    """

    logs_dir = "/tmp/dsh-agent-stub"
    RSI_BUNDLES: tuple = ()

    def __init__(self, model_name=None, reasoning_effort=None):
        self.model_name = model_name
        self._flag_kwargs = (
            {"reasoning_effort": reasoning_effort} if reasoning_effort else {}
        )
        self._harness_dir = None

    from harness_harbor.dsh_agent import Dsh as _Dsh

    model_name_for_dsh = _Dsh.model_name_for_dsh
    model_patch_yaml = _Dsh.model_patch_yaml
    patch_layers = _Dsh.patch_layers
    build_command = _Dsh.build_command
    _reasoning_effort = _Dsh._reasoning_effort
    _rsi_plugin = _Dsh._rsi_plugin
    bundles = _Dsh.bundles


def _agent(**kwargs):
    return _AgentStub(**kwargs)


class SummariseTests(unittest.TestCase):
    """The measured three-step transcript from a real dsh run."""

    TRANSCRIPT = [
        {"type": "session", "sessionId": "session-x", "cwd": "/app"},
        {"type": "status", "phase": "turn_start", "turn": 1},
        {"type": "status", "phase": "step_start", "turn": 1, "step": 1},
        _step(6721, 78, cache_read=6784, step=1),
        {"type": "status", "phase": "step_start", "turn": 1, "step": 2},
        _step(185, 48, cache_read=13440, step=2),
        {"type": "status", "phase": "step_start", "turn": 1, "step": 3},
        _step(159, 21, cache_read=13568, step=3),
        {"type": "status", "phase": "turn_end", "turn": 1, "reason": {"kind": "completed"}},
        {"type": "final", "text": "DONE"},
    ]

    def test_input_side_fields_are_summed_not_taken_from_the_last_step(self):
        summary = _summarise(self.TRANSCRIPT)
        self.assertEqual(summary["uncached_input_tokens"], 6721 + 185 + 159)
        self.assertEqual(summary["cache_read_tokens"], 6784 + 13440 + 13568)
        self.assertEqual(summary["output_tokens"], 78 + 48 + 21)
        self.assertEqual(summary["steps"], 3)

    def test_billable_input_is_the_sum_of_both_disjoint_fields(self):
        summary = _summarise(self.TRANSCRIPT)
        self.assertEqual(
            summary["billable_input_tokens"],
            summary["uncached_input_tokens"] + summary["cache_read_tokens"],
        )

    def test_cache_hit_rate_is_over_the_billable_prompt(self):
        summary = _summarise(self.TRANSCRIPT)
        billable = summary["billable_input_tokens"]
        self.assertAlmostEqual(summary["cache_hit_rate"], 33792 / billable)

    def test_final_text_is_captured(self):
        self.assertEqual(_summarise(self.TRANSCRIPT)["final_text"], "DONE")

    def test_tool_calls_are_counted(self):
        events = [
            {"type": "tool_call", "tool": "write", "callId": "a"},
            {"type": "tool_call", "tool": "read", "callId": "b"},
            _step(1, 1),
        ]
        summary = _summarise(events)
        self.assertEqual(summary["tool_calls"], ["write", "read"])
        self.assertEqual(summary["tool_call_count"], 2)

    def test_error_event_is_surfaced(self):
        events = [{"type": "error", "message": "boom"}]
        self.assertEqual(_summarise(events)["error"], "boom")

    def test_empty_transcript_does_not_divide_by_zero(self):
        summary = _summarise([])
        self.assertEqual(summary["billable_input_tokens"], 0)
        self.assertEqual(summary["cache_hit_rate"], 0.0)


class ReadJsonlTests(unittest.TestCase):
    def test_ignores_noise_and_malformed_lines(self):
        text = "\n".join(
            [
                "npm warn something",
                json.dumps({"type": "final", "text": "ok"}),
                "{ this is not json",
                "",
                "dsh: some diagnostic",
                json.dumps({"type": "status", "phase": "step_end", "usage": {}}),
            ]
        )
        events = _read_jsonl(text)
        self.assertEqual(len(events), 2)
        self.assertEqual(events[0]["text"], "ok")

    def test_ignores_json_that_is_not_an_object(self):
        self.assertEqual(_read_jsonl('["a"]\n42\n"str"'), [])


class ContextFoldingTests(unittest.TestCase):
    def test_context_matches_harbor_conventions(self):
        from harbor.models.agent.context import AgentContext

        context = AgentContext()
        Dsh._populate_context(context, SummariseTests.TRANSCRIPT)
        # Harbor reads n_input_tokens as the full prompt, cache included.
        self.assertEqual(context.n_input_tokens, 6721 + 185 + 159 + 6784 + 13440 + 13568)
        self.assertEqual(context.n_cache_tokens, 6784 + 13440 + 13568)
        self.assertEqual(context.n_output_tokens, 78 + 48 + 21)
        self.assertEqual(context.metadata["dsh_steps"], 3)
        self.assertEqual(context.metadata["dsh_final_text"], "DONE")


class ModelRouteTests(unittest.TestCase):
    def test_bare_model_id_passes_through(self):
        agent = _agent(model_name="deepseek-flash")
        self.assertEqual(agent.model_name_for_dsh(), "deepseek-flash")

    def test_provider_qualified_model_id_is_accepted(self):
        agent = _agent(model_name="deepseek/deepseek-flash")
        self.assertEqual(agent.model_name_for_dsh(), "deepseek-flash")

    def test_dsh_provider_alias_is_accepted(self):
        agent = _agent(model_name="deepseek-official/deepseek-flash")
        self.assertEqual(agent.model_name_for_dsh(), "deepseek-flash")

    def test_missing_model_falls_back_to_the_pinned_default(self):
        agent = _agent(model_name=None)
        self.assertEqual(agent.model_name_for_dsh(), DEFAULT_MODEL)

    def test_foreign_provider_is_rejected_early(self):
        agent = _agent(model_name="openai/gpt-5")
        with self.assertRaises(ValueError) as caught:
            agent.model_name_for_dsh()
        self.assertIn("only talks to the DeepSeek API", str(caught.exception))


class OverlayTests(unittest.TestCase):
    def test_overlay_targets_agent_default_model(self):
        agent = _agent(model_name="deepseek-flash")
        text = agent.model_patch_yaml()
        self.assertIn("id: agent-default-model", text)
        self.assertIn(f"provider: {DEFAULT_PROVIDER}", text)
        self.assertIn("model: deepseek-flash", text)

    def test_overlay_omits_effort_when_not_requested(self):
        agent = _agent(model_name="deepseek-flash")
        self.assertNotIn("reasoningEffort", agent.model_patch_yaml())

    def test_overlay_includes_effort_when_requested(self):
        agent = _agent(model_name="deepseek-flash", reasoning_effort="high")
        self.assertIn("reasoningEffort: high", agent.model_patch_yaml())

    def test_overlay_is_parseable_yaml(self):
        try:
            import yaml
        except ImportError:  # pragma: no cover - pyyaml arrives with harbor
            self.skipTest("pyyaml unavailable")
        agent = _agent(model_name="deepseek-flash", reasoning_effort="max")
        parsed = yaml.safe_load(agent.model_patch_yaml())
        self.assertEqual(parsed[0]["id"], "agent-default-model")
        self.assertEqual(parsed[0]["config"]["reasoningEffort"], "max")


class BundleResolutionTests(unittest.TestCase):
    """``--agent-kwarg rsi_plugin=`` must actually take effect."""

    class _WithBundles(_AgentStub):
        RSI_BUNDLES = ("@deepseek-ai/dsh-rsi-trace",)

    def test_class_default_is_used_without_an_override(self):
        agent = self._WithBundles(model_name="deepseek-flash")
        self.assertEqual(agent.bundles(), ("@deepseek-ai/dsh-rsi-trace",))

    def test_cli_override_replaces_the_class_default(self):
        agent = self._WithBundles(model_name="deepseek-flash")
        agent._flag_kwargs["rsi_plugin"] = "/tmp/rsi-trace.tgz"
        self.assertEqual(agent.bundles(), ("/tmp/rsi-trace.tgz",))

    def test_no_bundles_when_neither_is_set(self):
        self.assertEqual(_agent(model_name="deepseek-flash").bundles(), ())

    def test_tarball_filename_is_probed_after_install(self):
        from harness_harbor.dsh_agent import _bundle_package_names

        self.assertEqual(
            _bundle_package_names(("file:/tmp/deepseek-ai-dsh-rsi-trace-0.1.0.tgz",)),
            "deepseek-ai-dsh-rsi-trace-0.1.0",
        )
        self.assertEqual(
            _bundle_package_names(("@deepseek-ai/dsh-rsi-trace",)),
            "@deepseek-ai/dsh-rsi-trace",
        )


class ArmSeparationTests(unittest.TestCase):
    """The comparison is only meaningful if the arms differ in exactly one way."""

    def test_bare_arm_stacks_no_extra_bundles(self):
        self.assertEqual(Dsh.RSI_BUNDLES, ())

    def test_rsi_arm_stacks_the_trace_bundle(self):
        self.assertEqual(DshRsi.RSI_BUNDLES, ("@deepseek-ai/dsh-rsi-trace",))

    def test_arms_share_the_same_profile_and_overlay(self):
        bare = _agent(model_name="deepseek-flash")
        rsi = _AgentStub(model_name="deepseek-flash")
        # Same overlay bytes, because the arms must differ only by plugin set.
        self.assertEqual(bare.model_patch_yaml(), rsi.model_patch_yaml())

    def test_arm_names_are_distinct(self):
        self.assertEqual(Dsh.name(), "dsh")
        self.assertEqual(DshRsi.name(), "dsh-rsi")

    def test_both_arms_boot_the_same_shipped_profile(self):
        """``headless`` needs no initialization, and both arms must share it."""
        self.assertEqual(PROFILE, "headless")


class NodeVersionTests(unittest.TestCase):
    """The pinned Node must support ``import.meta.main``.

    dsh's entrypoint is guarded by ``if (import.meta.main) await runCli()``; on
    Node < 22.18.0 that is ``undefined`` and dsh exits 0 in silence, which a
    benchmark would otherwise record as a failed task rather than a broken arm.
    """

    def test_pinned_node_is_at_least_the_import_meta_main_floor(self):
        major, minor, patch = (int(part) for part in DEFAULT_NODE_VERSION.split("."))
        self.assertGreaterEqual(major, 22)
        if major == 22:
            self.assertGreaterEqual(minor, 18)
        self.assertLess(patch, 1000)

    def test_install_self_check_exists(self):
        import inspect

        source = inspect.getsource(Dsh._install_dsh)
        self.assertIn("import.meta.main", source)
        self.assertIn("exit 3", source)


class EmptyTranscriptTests(unittest.TestCase):
    """A run that never booted must not be scored as a failed task."""

    def test_empty_events_raise(self):
        with self.assertRaises(RuntimeError) as caught:
            Dsh._assert_harness_booted([], "/logs/agent", None)
        self.assertIn("measured nothing", str(caught.exception))

    def test_empty_events_surface_the_underlying_failure(self):
        with self.assertRaises(RuntimeError) as caught:
            Dsh._assert_harness_booted([], "/logs/agent", "boom")
        self.assertIn("boom", str(caught.exception))

    def test_any_event_is_enough_to_score(self):
        Dsh._assert_harness_booted([{"type": "session"}], "/logs/agent", None)


class PatchLayerTests(unittest.TestCase):
    def test_patch_layers_requires_staging_first(self):
        agent = _agent(model_name="deepseek-flash")
        with self.assertRaises(RuntimeError) as caught:
            agent.patch_layers()
        self.assertIn("before install()", str(caught.exception))

    def test_patch_layers_point_at_the_model_overlay(self):
        agent = _agent(model_name="deepseek-flash")
        agent._harness_dir = "/home/agent/.dsh/harness-harbor"
        self.assertEqual(
            agent.patch_layers(), ("/home/agent/.dsh/harness-harbor/model.yml",)
        )


class BuildCommandTests(unittest.TestCase):
    def test_command_reads_the_instruction_from_stdin(self):
        agent = _agent(model_name="deepseek-flash")
        agent._harness_dir = "/home/agent/.dsh/harness-harbor"
        command = agent.build_command()
        self.assertIn("--profile headless", command)
        self.assertIn("--patch /home/agent/.dsh/harness-harbor/model.yml", command)
        self.assertIn("--json -", command)
        # No instruction text and no $HOME: the launcher must not depend on
        # shell expansion of an upload target.
        self.assertNotIn("$HOME/.dsh/harness-harbor/model.yml", command)

    def test_launch_does_not_depend_on_path(self):
        """Regression: launch node and the dsh entrypoint by absolute path.

        The global `dsh` shim's `#!/usr/bin/env node` shebang makes it fail
        silently -- exit 0, no output -- whenever the Node *bin directory* is not
        itself on PATH. Naming both paths explicitly removes that failure mode.
        """
        agent = _agent(model_name="deepseek-flash")
        agent._harness_dir = "/home/agent/.dsh/harness-harbor"
        command = agent.build_command()
        self.assertIn('"$HOME/.local/node/bin/node"', command)
        self.assertIn("@deepseek-ai/dsh/lib/bin.js", command)
        self.assertIn("--profile headless", command)
        self.assertIn("--json -", command)
        # No bare `dsh` token: that would rely on the PATH lookup above.
        self.assertNotIn("; dsh ", command)
        self.assertFalse(command.strip().startswith("dsh "))

    def test_command_does_not_initialize_a_profile(self):
        """Regression: ``headless`` is shipped and must not be a custom target.

        ``dsh --profile headless --from-default-profile headless`` fails with
        "profile is shipped and cannot be a custom profile target", which
        surfaced as an opaque NonZeroAgentExitCodeError. The profile needs no
        initialization at all, so the command must neither create nor dump one.
        """
        agent = _agent(model_name="deepseek-flash")
        agent._harness_dir = "/home/agent/.dsh/harness-harbor"
        command = agent.build_command()
        self.assertNotIn("--from-default-profile", command)
        self.assertNotIn("dump-config", command)
        self.assertNotIn("DSH_HOME", command)


if __name__ == "__main__":
    unittest.main()
