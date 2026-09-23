# The Harbor adapter (canonical copy)

`harness_harbor/dsh_agent.py` is the file that runs under Harbor. It is copied
into the Harbor project rather than imported from here, because Harbor resolves an
agent as `harness_harbor.dsh_agent:Dsh` and a benchmark should not depend on the
repository it is measuring:

```sh
cp harbor/adapter/harness_harbor/dsh_agent.py \\
   <unreal-agent>/benchmarks/harbor/src/harness_harbor/
cp harbor/adapter/tests/test_dsh_agent.py \\
   <unreal-agent>/benchmarks/harbor/tests/
cd <unreal-agent>/benchmarks/harbor && uv sync --locked --all-extras
.venv/bin/python -m unittest tests.test_dsh_agent
```

This copy is kept so the adapter is versioned beside the results it produced,
instead of living only in a scratch checkout. `harbor/tools/README.md` covers
running the two arms and producing the report.
