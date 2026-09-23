"""A Harbor agent adapter for DeepSeek Harness (``dsh``).

This adapter plugs into Harbor through ``AgentConfig.import_path``, so Harbor's
own source tree is never modified::

    uv run harbor trials run --agent harness_harbor.dsh_agent:Dsh ...
    uv run harbor trials run --agent harness_harbor.dsh_agent:DshRsi ...

Two arms are provided so that a comparison is possible:

``Dsh``
    Bare DeepSeek Harness, booted from dsh's own ``headless`` profile.

``DshRsi``
    The same harness with the RSI-Harness discovery-trace bundle stacked on
    top. Everything else — model, reasoning effort, budget, task text, container
    image — is identical to ``Dsh``, so any measured difference is attributable
    to the RSI layer rather than to configuration drift.

Design notes
------------
*   **Pinned harness.** Both the dsh version and the Node major are pinned, so
    every trial in a benchmark run boots a byte-identical harness.
*   **Installed, not resolved.** ``npm install -g`` runs once per trial instead
    of letting ``npx`` revalidate the registry on every invocation. That saves
    15-25s of agent-time per task, which matters: for a cost-focused benchmark,
    install latency leaking into the agent budget is measurement error.
*   **Model selection is a patch layer, not a profile edit.** dsh exposes no
    ``--model`` flag; the default model lives in the ``agent-default-model``
    plugin's config. Rather than mutating the shared profile (which would leak
    state between arms), the adapter writes a small overlay and passes it with
    ``--patch`` per invocation. Verified against ``--dump-config``.
*   **Metrics come from the host, not from truncated stdout.** ``dsh --json``
    emits one NDJSON object per event including a per-step ``usage`` block. The
    container writes that stream to a file; the adapter downloads the file and
    parses it on the host, so a long run cannot be silently clipped by the
    execution layer's output cap. A compact one-line summary is also written
    beside it as an artifact for auditors who do not want to re-parse NDJSON.
*   **The instruction is fed on stdin.** Some benchmark instructions are tens of
    kilobytes and contain shell metacharacters; piping the file into dsh avoids
    both argv limits and quoting rules entirely.
"""

from __future__ import annotations

import json
import shlex
import tempfile
from pathlib import Path
from typing import Any, override

from harbor.agents.installed.base import (
    BaseInstalledAgent,
    CliFlag,
    with_prompt_template,
)
from harbor.agents.model_connection import ModelConnectionSpec
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

#: Pinned so that every trial in a benchmark run gets an identical harness.
DEFAULT_DSH_VERSION = "0.1.7-alpha.2"

#: Pinned Node version.
#:
#: The 22.x line is dsh's oldest supported LTS, but the *floor matters*: dsh's
#: CLI entrypoint guards itself with ``if (import.meta.main) await runCli()``,
#: and ``import.meta.main`` only exists from Node 22.18.0 / 24.2.0. On an older
#: 22.x that expression is ``undefined``, so ``runCli()`` never runs: dsh exits
#: 0 having printed nothing at all. Since dsh swallows even ``--version``
#: failures, the symptom is a silent no-op rather than an error -- which, in a
#: benchmark, would have been recorded as a legitimately failed task.
#: See https://github.com/tschaub/es-main/issues/161.
DEFAULT_NODE_VERSION = "22.23.2"

#: Provider route dsh's own base bundle registers for the official API.
DEFAULT_PROVIDER = "deepseek-official"

#: The model the public API exposes as DeepSeek-V4.1-Flash.
DEFAULT_MODEL = "deepseek-flash"

#: Permission mode exported to dsh as ``DSH_PERMISSION_MODE``.
#:
#: dsh defaults to ``workspace-write``, which routes shell commands through a
#: local sandbox backend. Inside a benchmark image that backend is frequently
#: unavailable -- on Linux it needs bubblewrap and usable user namespaces -- and
#: dsh then *fails closed*: every shell command is refused. For a coding
#: benchmark that is fatal rather than conservative, because running the test
#: suite or building the project is the task.
#:
#: The task container is already the isolation boundary, and it is the boundary
#: every other Harbor adapter assumes. Granting the agent the container's own
#: privileges is therefore not an escalation relative to the benchmark's own
#: design. Override with ``--agent-kwarg permission_mode=workspace-write`` when
#: studying the sandbox itself.
DEFAULT_PERMISSION_MODE = "danger-full-access"

#: The dsh profile both arms boot.
#:
#: ``headless`` is one of dsh's *shipped* profiles. It needs no initialization:
#: ``dsh --profile headless ...`` works from a bare ``DSH_HOME``. It also cannot
#: be created as a custom target -- ``--from-default-profile headless`` fails
#: with "profile is shipped and cannot be a custom profile target", which is
#: exactly what an earlier revision of this adapter did, and why it died with an
#: opaque NonZeroAgentExitCodeError. An overlay supplied via ``--patch`` is the
#: supported way to change any of its configuration.
PROFILE = "headless"


class Dsh(BaseInstalledAgent):
    """Bare DeepSeek Harness, one task per container."""

    # dsh reads ``DEEPSEEK_API_KEY`` directly, so the provider's canonical
    # variable name is passed through untouched.
    MODEL_CONNECTION = ModelConnectionSpec(
        default_provider="deepseek", passthrough=True
    )

    CLI_FLAGS = [
        CliFlag("dsh_version", cli="--dsh-version", env_fallback="DSH_VERSION"),
        CliFlag("node_version", cli="--dsh-node-version", env_fallback="DSH_NODE_VERSION"),
        CliFlag("reasoning_effort", cli="--dsh-effort", env_fallback="DSH_EFFORT"),
        CliFlag("rsi_plugin", cli="--dsh-rsi-plugin", env_fallback="DSH_RSI_PLUGIN"),
        CliFlag(
            "permission_mode",
            cli="--dsh-permission-mode",
            env_fallback="DSH_PERMISSION_MODE",
        ),
        CliFlag(
            "agent_timeout_sec",
            cli="--dsh-timeout-sec",
            type="int",
            env_fallback="DSH_TIMEOUT_SEC",
        ),
    ]

    #: dsh plugin bundles stacked over the headless profile, in order. Subclasses
    #: extend this, which is the *only* difference between the two arms.
    RSI_BUNDLES: tuple[str, ...] = ()

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._home_dir: str | None = None
        self._harness_dir: str | None = None

    @staticmethod
    @override
    def name() -> str:
        return "dsh"

    @override
    def version(self) -> str | None:
        return self._version or self._dsh_version

    # ------------------------------------------------------------------
    # configuration
    # ------------------------------------------------------------------

    @property
    def _dsh_version(self) -> str:
        return str(self._flag_kwargs.get("dsh_version") or DEFAULT_DSH_VERSION)

    @property
    def _node_version(self) -> str:
        return str(self._flag_kwargs.get("node_version") or DEFAULT_NODE_VERSION)

    @property
    def _reasoning_effort(self) -> str | None:
        value = self._flag_kwargs.get("reasoning_effort")
        return str(value) if value else None

    @property
    def _rsi_plugin(self) -> str | None:
        """Optional npm name or container path for the RSI bundle package."""
        value = self._flag_kwargs.get("rsi_plugin")
        return str(value) if value else None

    @property
    def _permission_mode(self) -> str:
        return str(self._flag_kwargs.get("permission_mode") or DEFAULT_PERMISSION_MODE)

    def bundles(self) -> tuple[str, ...]:
        """The plugin bundles to install, after the CLI override is applied.

        ``--agent-kwarg rsi_plugin=<spec>`` replaces the class default outright.
        That matters because the RSI packages are not on the public registry:
        the default names only resolve once they are published, so a run from a
        checkout must be able to point at a locally packed tarball without
        editing the class.
        """
        override = self._rsi_plugin
        if override:
            return (override,)
        return self.RSI_BUNDLES

    @property
    def _agent_timeout_sec(self) -> int | None:
        value = self._flag_kwargs.get("agent_timeout_sec")
        return int(value) if value else None

    async def _resolve_home(self, environment: BaseEnvironment) -> str:
        """The agent user's home as a *literal* path, resolved once per trial.

        ``docker cp`` -- which backs ``upload_file`` -- performs no shell
        expansion, so an upload target of ``$HOME/...`` fails with "could not
        find the file in container". Only *uploads* need this; every shell
        command may keep using ``$HOME``.
        """
        if self._home_dir:
            return self._home_dir
        result = await self.exec_as_agent(environment, command='printf "%s" "$HOME"')
        home = (result.stdout or "").strip()
        if not home.startswith("/"):
            raise RuntimeError(f"could not resolve the agent home directory (got {home!r})")
        self._home_dir = home
        return home

    async def _harness_dir_path(self, environment: BaseEnvironment) -> str:
        """Absolute container path for this adapter's staged files."""
        if self._harness_dir:
            return self._harness_dir
        home = await self._resolve_home(environment)
        self._harness_dir = f"{home}/.dsh/harness-harbor"
        await self.exec_as_agent(
            environment, command=f"mkdir -p {shlex.quote(self._harness_dir)}"
        )
        return self._harness_dir

    def model_name_for_dsh(self) -> str:
        """The dsh model id, taken from ``--model`` when Harbor supplied one.

        Accepts either ``deepseek-flash`` or a provider-qualified
        ``deepseek/deepseek-flash``; the provider half is validated against the
        route dsh's base bundle actually registers, because dsh rejects an
        unknown provider with a confusing runtime error much later in the run.
        """
        raw = self.model_name
        if not raw:
            return DEFAULT_MODEL
        if "/" in raw:
            provider, _, model = raw.partition("/")
            if provider not in {"deepseek", "deepseek-official"}:
                raise ValueError(
                    f"dsh only talks to the DeepSeek API; got provider {provider!r} "
                    f"in --model {raw!r}. Use {DEFAULT_MODEL!r} or "
                    f"'deepseek/{DEFAULT_MODEL}'."
                )
            return model
        return raw

    def model_patch_yaml(self) -> str:
        """The overlay that pins provider, model and reasoning effort.

        Written as a target-``id`` patch over ``agent-default-model``. The exact
        key names and the fact that ``--patch`` overrides the bundle layer were
        both confirmed by diffing ``dsh --dump-config`` with and without the
        overlay.
        """
        lines = [
            "# Generated by harness_harbor.dsh_agent — the model-selection layer.",
            "- id: agent-default-model",
            "  config:",
            f"    provider: {DEFAULT_PROVIDER}",
            f"    model: {self.model_name_for_dsh()}",
        ]
        if self._reasoning_effort:
            lines.append(f"    reasoningEffort: {self._reasoning_effort}")
        return "\n".join(lines) + "\n"

    # ------------------------------------------------------------------
    # install
    # ------------------------------------------------------------------

    async def install(self, environment: BaseEnvironment) -> None:
        await self.ensure_system_dependencies(
            environment, ("curl", "xz", "ca_certificates", "tar", "bash")
        )
        await self._install_node(environment)
        await self._install_dsh(environment)
        if self.bundles():
            # `dsh plugin add` shells out to pnpm; without it the command fails
            # with exit 127 and no usable output, because dsh writes plugin
            # diagnostics to its own log file rather than to stderr.
            await self._install_pnpm(environment)
        await self._write_layers(environment)

    async def _install_node(self, environment: BaseEnvironment) -> None:
        """Install a pinned Node into ``~/.local``.

        Downloaded rather than taken from the distro because benchmark images
        range from Debian bookworm to Alpine, and dsh needs Node >= 22.
        """
        script = f"""
set -euo pipefail
NODE_VERSION={shlex.quote(self._node_version)}
NODE_ROOT="$HOME/.local/node"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) NODE_ARCH=x64 ;;
  aarch64|arm64) NODE_ARCH=arm64 ;;
  *) echo "unsupported arch: $ARCH" >&2; exit 2 ;;
esac
if [ -x "$NODE_ROOT/bin/node" ] && "$NODE_ROOT/bin/node" --version | grep -qF "v$NODE_VERSION"; then
  echo "node v$NODE_VERSION already present"
  exit 0
fi
TARBALL="node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz"
URL="https://nodejs.org/dist/v$NODE_VERSION/$TARBALL"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "downloading $URL"
curl -fsSL "$URL" -o "$TMP/$TARBALL"
rm -rf "$NODE_ROOT"
mkdir -p "$NODE_ROOT" "$HOME/.local/bin"
tar -xJf "$TMP/$TARBALL" -C "$NODE_ROOT" --strip-components=1
ln -sf "$NODE_ROOT/bin/node" "$HOME/.local/bin/node"
ln -sf "$NODE_ROOT/bin/npm" "$HOME/.local/bin/npm"
ln -sf "$NODE_ROOT/bin/npx" "$HOME/.local/bin/npx"
export PATH="$HOME/.local/bin:$PATH"
node --version
npm --version
""".strip()
        result = await self.exec_as_agent(environment, command=script, timeout_sec=900)
        self.logger.debug("node install: %s", _tail(result.stdout))

    async def _install_dsh(self, environment: BaseEnvironment) -> None:
        """``npm install -g`` the pinned harness, then record how to launch it.

        The launch path is resolved here rather than left to ``$PATH`` because
        the global ``dsh`` symlink carries a ``#!/usr/bin/env node`` shebang:
        unless the *Node bin directory itself* is on PATH, ``env`` cannot find
        ``node``, dsh never starts, and -- because `dsh` also swallows
        ``--version`` failures -- the failure is a silent exit 0 with no output.
        Invoking ``node <entrypoint>`` by absolute path removes the whole class
        of problem.
        """
        version = self._dsh_version
        script = f"""
set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/.local/node/bin:$PATH"
export npm_config_prefix="$HOME/.local"
if [ ! -f "$HOME/.local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js" ]; then
  npm install --global --no-fund --no-audit {shlex.quote(f"@deepseek-ai/dsh@{version}")}
fi
test -f "$HOME/.local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"

# Self-check: dsh must produce output. Its entrypoint is guarded by
# `if (import.meta.main)`, which is `undefined` before Node 22.18.0 -- dsh then
# exits 0 in total silence. Probing here turns that silent no-op into a setup
# failure, so it can never be mistaken for a task the agent failed to solve.
VERSION_OUT="$("$HOME/.local/node/bin/node" "$HOME/.local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js" --version 2>&1 || true)"
if [ -z "$VERSION_OUT" ]; then
  echo "dsh produced no version output under node $("$HOME/.local/node/bin/node" --version)" >&2
  echo "this usually means Node is older than 22.18.0, where import.meta.main is undefined" >&2
  exit 3
fi
echo "dsh ready: $VERSION_OUT"
""".strip()
        result = await self.exec_as_agent(environment, command=script, timeout_sec=1200)
        self.logger.debug("dsh install: %s", _tail(result.stdout))

    async def _install_pnpm(self, environment: BaseEnvironment) -> None:
        """Install pnpm, which ``dsh plugin add`` delegates to."""
        script = """
set -euo pipefail
export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"
export npm_config_prefix="$HOME/.local"
if [ -x "$HOME/.local/bin/pnpm" ]; then
  "$HOME/.local/bin/pnpm" --version
  exit 0
fi
npm install --global --no-fund --no-audit pnpm@10
"$HOME/.local/bin/pnpm" --version
""".strip()
        result = await self.exec_as_agent(environment, command=script, timeout_sec=900)
        self.logger.debug("pnpm install: %s", _tail(result.stdout))

    async def _write_layers(self, environment: BaseEnvironment) -> None:
        """Stage the model-selection overlay (and any RSI plugin) in the container."""
        harness_dir = await self._harness_dir_path(environment)
        await self.exec_as_agent(environment, command=f"mkdir -p {shlex.quote(harness_dir)}")
        self._harness_dir = harness_dir
        await self._upload_text(
            environment, self.model_patch_yaml(), f"{harness_dir}/model.yml"
        )

        if self.bundles():
            await self._install_rsi_bundles(environment)

    async def _install_rsi_bundles(self, environment: BaseEnvironment) -> None:
        """Install each RSI plugin bundle into the profile's plugin set."""
        targets: list[str] = []
        for spec in self.bundles():
            if spec.startswith("file:") or spec.startswith(".") or spec.startswith("/"):
                resolved = await self._stage_local_bundle(environment, spec)
                targets.append(f"file:{resolved}")
            else:
                targets.append(spec)

        quoted = " ".join(shlex.quote(target) for target in targets)
        script = f"""
set -euo pipefail
export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"
NODE="$HOME/.local/node/bin/node"
DSH="$HOME/.local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"
command -v pnpm >/dev/null 2>&1 || {{ echo "pnpm is required by 'dsh plugin add'" >&2; exit 5; }}
"$NODE" "$DSH" plugin --profile {PROFILE} add {quoted}

# Self-check: `dsh plugin add` also exits 0 in silence when dsh itself fails to
# boot, so success must be confirmed from the profile's own dependency list
# rather than from the exit code.
for pkg in {_bundle_package_names(self.bundles())}; do
  grep -q "$pkg" "$HOME/.dsh/profiles/{PROFILE}/package.json" 2>/dev/null || {{
    echo "plugin $pkg was not recorded in the {PROFILE} profile" >&2
    exit 4
  }}
done
echo "installed RSI bundles: {quoted}"
""".strip()
        result = await self.exec_as_agent(environment, command=script, timeout_sec=1200)
        self.logger.debug("rsi bundles: %s", _tail(result.stdout))

    async def _stage_local_bundle(self, environment: BaseEnvironment, spec: str) -> str:
        """Upload a local ``.tgz`` so a container can ``npm install`` it.

        The RSI plugin packages are not on the public registry, so a run must be
        able to hand the harness a native artifact. Uploading the tarball keeps
        the container offline-capable apart from npm itself.
        """
        source = Path(spec.removeprefix("file:")).expanduser().resolve()
        if not source.is_file():
            raise FileNotFoundError(
                f"RSI bundle tarball not found: {source}. Build it with "
                "`pnpm --filter <pkg> pack` from the repository root."
            )
        harness_dir = await self._harness_dir_path(environment)
        remote_path = f"{harness_dir}/{source.name}"
        await environment.upload_file(source, remote_path)
        return remote_path

    async def _upload_text(
        self, environment: BaseEnvironment, content: str, remote_path: str
    ) -> None:
        with tempfile.TemporaryDirectory(prefix="harbor-dsh-") as temp_dir:
            local = Path(temp_dir) / "payload"
            local.write_text(content, encoding="utf-8")
            await environment.upload_file(local, remote_path)

    # ------------------------------------------------------------------
    # run
    # ------------------------------------------------------------------

    def patch_layers(self) -> tuple[str, ...]:
        """Overlay paths passed to ``--patch``, in order."""
        if self._harness_dir is None:
            raise RuntimeError("patch_layers() called before install() staged the layers")
        return (f"{self._harness_dir}/model.yml",)

    def build_command(self) -> str:
        """The full container command.

        Shape::

            export PATH="$HOME/.local/bin:$PATH"; dsh --profile headless \\
                --patch <model.yml> --json - < /logs/agent/instruction.txt

        The instruction arrives on stdin, which sidesteps both argv limits and
        shell quoting for task text that may be tens of kilobytes.
        """
        # Two statements, joined with ``;``: the export and the dsh call. The
        # flags within the dsh call stay space-separated, because they are
        # arguments to the same command. An earlier revision space-joined the
        # lot, so bash read `--profile headless ...` as further arguments to
        # `export` and failed with "`--profile`: not a valid identifier".
        dsh_argv = [
            '"$HOME/.local/node/bin/node"',
            '"$HOME/.local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"',
            f"--profile {PROFILE}",
        ]
        for layer in self.patch_layers():
            dsh_argv.append(f"--patch {layer}")
        dsh_argv.extend(["--json", "-"])
        return " ".join(dsh_argv)

    @with_prompt_template
    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        agent_dir = str(self.environment_logs_dir)
        await self._prepare_log_dir(environment, agent_dir)
        await self._upload_text(environment, instruction, f"{agent_dir}/instruction.txt")

        # Plain redirection, not `tee` via process substitution. Process
        # substitution needs bash, adds an async subprocess whose lifetime the
        # harness does not control, and -- as an earlier revision demonstrated
        # -- can fail in a way that leaves both streams empty and the exit code
        # at 0. Writing the files directly and reading them back afterwards is
        # both simpler and observable.
        command = (
            f"{self.build_command()} "
            f"< {shlex.quote(agent_dir)}/instruction.txt "
            f"> {shlex.quote(agent_dir)}/dsh.jsonl "
            f"2> {shlex.quote(agent_dir)}/dsh.txt"
        )

        env = {
            **dict(self.model_connection.env),
            # Read by both the sandbox policy and the approval policy.
            "DSH_PERMISSION_MODE": self._permission_mode,
        }

        result = None
        failure: str | None = None
        try:
            result = await self.exec_as_agent(
                environment,
                command=command,
                env=env,
                # No `cwd`: Harbor already resolves each task's working directory
                # (the environment override, else the image's own WORKDIR) and
                # applies it to every exec. Hard-coding `/app` here overrode that
                # and pointed the harness at a directory some task images do not
                # use -- silently, since the agent would simply work elsewhere.
                timeout_sec=self._agent_timeout_sec,
            )
            self.logger.debug("dsh stdout: %s", _tail(result.stdout, 200))
        except Exception as exc:  # noqa: BLE001
            # ``_exec`` raises on a non-zero exit. For a benchmark that is a
            # *failed task*, not a broken harness: the trial must still record
            # the tokens it burned and let the verifier score the workspace.
            # Swallowing the exception here is what keeps a solver failure from
            # being indistinguishable from an infrastructure failure.
            failure = f"{type(exc).__name__}: {exc}"
            self.logger.warning("dsh run did not exit cleanly: %s", failure)

        events = await self._collect_events(environment, agent_dir)
        self._populate_context(context, events)
        if not events:
            stderr_tail = await self._read_container_file(environment, f"{agent_dir}/dsh.txt")
            self._assert_harness_booted(events, agent_dir, failure, stderr_tail)
        if result is not None and result.return_code != 0:
            self.logger.warning(
                "dsh exited with code %s; transcript at %s/dsh.txt",
                result.return_code,
                agent_dir,
            )

    @staticmethod
    def _assert_harness_booted(
        events: list[dict[str, Any]],
        agent_dir: str,
        failure: str | None,
        stderr_tail: str | None = None,
    ) -> None:
        """Refuse to let a harness that never ran be scored as a failed task.

        A trial whose transcript is empty scored 0.0 looks exactly like a task
        the agent could not solve. It is not: it means the harness never
        executed. Failing loudly here keeps the benchmark from grading its own
        plumbing, and the distinction matters most in a comparison, where a
        silently-dead arm would read as the *other* arm winning.
        """
        if events:
            return
        detail = failure or "no events and no error were reported"
        if stderr_tail:
            detail = f"{detail}; stderr said: {stderr_tail}"
        raise RuntimeError(
            f"dsh produced no transcript events, so this trial measured nothing "
            f"({detail}). The agent transcript is at {agent_dir}/dsh.txt."
        )

    async def _read_container_file(
        self, environment: BaseEnvironment, path: str
    ) -> str | None:
        """Read a small text file out of the container, best-effort."""
        try:
            result = await self.exec_as_root(
                environment, command=f"cat {shlex.quote(path)} 2>/dev/null | tail -c 2000"
            )
        except Exception:  # noqa: BLE001 - diagnostics must never mask the failure
            return None
        text = (result.stdout or "").strip()
        return text or None

    async def _prepare_log_dir(
        self, environment: BaseEnvironment, agent_dir: str
    ) -> None:
        await self.exec_as_root(
            environment,
            command=f"mkdir -p {shlex.quote(agent_dir)} && chmod -R 0777 {shlex.quote(agent_dir)}",
        )

    async def _collect_events(
        self, environment: BaseEnvironment, agent_dir: str
    ) -> list[dict[str, Any]]:
        """Download the NDJSON transcript and parse it on the host.

        Reading the file beats parsing captured stdout: the execution layer caps
        how much output it retains, and a long agent run would be clipped. The
        file is the authoritative record; the summary line is written for
        auditors who would rather not re-parse NDJSON.
        """
        remote = f"{agent_dir}/dsh.jsonl"
        local = Path(self.logs_dir) / "dsh.jsonl"
        local.parent.mkdir(parents=True, exist_ok=True)
        try:
            await environment.download_file(remote, local)
        except Exception as exc:  # noqa: BLE001 - transcript is best-effort
            self.logger.warning("could not download %s: %s", remote, exc)
            return []

        events = _read_jsonl(local.read_text(encoding="utf-8", errors="replace"))
        summary = _summarise(events)
        (Path(self.logs_dir) / "dsh-summary.json").write_text(
            json.dumps(summary, indent=2) + "\n", encoding="utf-8"
        )
        await self._write_container_summary(environment, agent_dir, summary)
        return events

    async def _write_container_summary(
        self,
        environment: BaseEnvironment,
        agent_dir: str,
        summary: dict[str, Any],
    ) -> None:
        payload = json.dumps(summary)
        try:
            await self.exec_as_root(
                environment,
                command=(
                    f"printf '%s\\n' {shlex.quote(payload)} "
                    f"> {shlex.quote(agent_dir)}/summary.json"
                ),
            )
        except Exception as exc:  # noqa: BLE001 - artifact is best-effort
            self.logger.debug("could not write summary artifact: %s", exc)

    # ------------------------------------------------------------------
    # metrics
    # ------------------------------------------------------------------

    @staticmethod
    def _populate_context(context: AgentContext, events: list[dict[str, Any]]) -> None:
        """Fold the NDJSON event stream into Harbor's metrics.

        ``dsh`` reports usage once per *step* (one model round-trip), and its two
        input-side fields are **disjoint**, so both are summed across steps:

        * ``inputTokens`` — prompt tokens not served from the provider cache;
        * ``cacheReadTokens`` — prompt tokens served from cache;
        * ``cacheWriteTokens`` — 0 against DeepSeek, whose context caching is
          automatic and bills no separate write.

        Verified empirically on a three-step task, where ``cacheReadTokens`` grew
        6784 -> 13440 -> 13568 while ``inputTokens`` stayed small
        (6721 -> 185 -> 159): the cached field carries the re-sent prefix and the
        uncached field carries only each step's new suffix. The billable prompt is
        therefore ``sum(inputTokens) + sum(cacheReadTokens)``, which matches
        Harbor's convention for ``n_input_tokens`` ("including cache") with the
        cached share broken out into ``n_cache_tokens``.

        This distinction is not cosmetic. DeepSeek bills a cache hit at
        $0.003/Mtok against $0.15/Mtok for a miss — a 50x spread — so conflating
        the two would misreport the benchmark's primary dependent variable.
        """
        summary = _summarise(events)
        context.n_input_tokens = summary["billable_input_tokens"]
        context.n_output_tokens = summary["output_tokens"]
        context.n_cache_tokens = summary["cache_read_tokens"]
        metadata: dict[str, Any] = {
            "dsh_steps": summary["steps"],
            "dsh_uncached_input_tokens": summary["uncached_input_tokens"],
            "dsh_cache_read_tokens": summary["cache_read_tokens"],
            "dsh_cache_write_tokens": summary["cache_write_tokens"],
            "dsh_cache_hit_rate": summary["cache_hit_rate"],
        }
        if summary["final_text"] is not None:
            metadata["dsh_final_text"] = summary["final_text"]
        context.metadata = {**(context.metadata or {}), **metadata}


class DshRsi(Dsh):
    """DeepSeek Harness with the RSI-Harness discovery-trace layer stacked on.

    The single difference from :class:`Dsh` is :attr:`RSI_BUNDLES`, which is what
    makes an A/B comparison meaningful: same model, same effort, same budget,
    same task text, same container image — one extra plugin.
    """

    #: Default bundle spec. The RSI plugins are not on the public registry, so
    #: this name only resolves once they are published; runs from a checkout
    #: should pass `--agent-kwarg rsi_plugin=<path/to/rsi-trace.tgz>` instead.
    RSI_BUNDLES: tuple[str, ...] = ("@deepseek-ai/dsh-rsi-trace",)

    @staticmethod
    @override
    def name() -> str:
        return "dsh-rsi"


# ----------------------------------------------------------------------
# helpers
# ----------------------------------------------------------------------


def _summarise(events: list[dict[str, Any]]) -> dict[str, Any]:
    """Reduce the event stream to the fields the benchmark reports."""
    uncached = 0
    cache_read = 0
    cache_write = 0
    output = 0
    steps = 0
    final_text: str | None = None
    tool_calls: list[str] = []
    error: str | None = None

    for event in events:
        kind = event.get("type")
        if kind == "status" and event.get("phase") == "step_end":
            usage = event.get("usage") or {}
            steps += 1
            uncached += int(usage.get("inputTokens") or 0)
            output += int(usage.get("outputTokens") or 0)
            cache_read += int(usage.get("cacheReadTokens") or 0)
            cache_write += int(usage.get("cacheWriteTokens") or 0)
        elif kind == "final":
            text = event.get("text")
            if isinstance(text, str):
                final_text = text
        elif kind == "tool_call":
            tool = event.get("tool")
            if isinstance(tool, str):
                tool_calls.append(tool)
        elif kind == "error":
            message = event.get("message") or event.get("text")
            if isinstance(message, str):
                error = message

    billable = uncached + cache_read + cache_write
    return {
        "steps": steps,
        "uncached_input_tokens": uncached,
        "cache_read_tokens": cache_read,
        "cache_write_tokens": cache_write,
        "billable_input_tokens": billable,
        "output_tokens": output,
        "cache_hit_rate": (cache_read / billable) if billable else 0.0,
        "tool_calls": tool_calls,
        "tool_call_count": len(tool_calls),
        "final_text": final_text,
        "error": error,
    }


def _bundle_package_names(specs: tuple[str, ...]) -> str:
    """Shell-quoted package names expected in the profile after ``plugin add``.

    A local ``.tgz`` spec carries no package name, so its tarball filename is
    used as a deliberately loose substring probe; a registry spec is probed by
    its own name.
    """
    names: list[str] = []
    for spec in specs:
        base = spec.removeprefix("file:").rsplit("/", 1)[-1]
        if base.endswith(".tgz"):
            names.append(base[: -len(".tgz")])
        else:
            names.append(spec)
    return " ".join(shlex.quote(name) for name in names)


def _tail(text: str | None, limit: int = 400) -> str:
    if not text:
        return ""
    stripped = text.strip()
    return stripped if len(stripped) <= limit else "..." + stripped[-limit:]


def _read_jsonl(text: str) -> list[dict[str, Any]]:
    """Parse NDJSON, ignoring any non-JSON noise a container may interleave."""
    events: list[dict[str, Any]] = []
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            events.append(parsed)
    return events


__all__ = [
    "Dsh",
    "DshRsi",
    "DEFAULT_DSH_VERSION",
    "DEFAULT_NODE_VERSION",
    "DEFAULT_PERMISSION_MODE",
    "DEFAULT_MODEL",
    "PROFILE",
]
