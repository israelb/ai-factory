# Optional Phase Dispatch (`implement`)

Lets `.ai-factory.json` route plan-backed execution to another agent or model through
`phases.implement`. Without that entry, this step is a silent no-op.

Run it only on the plan-backed execution route, after plan discovery, integrity checks,
and any recovery are resolved, and before Step 1. Skip it for `--list`, `status`,
`--without-plan`, when `HANDOFF_MODE` is `1`, and when the invoking request says it is
the dispatched `implement` phase.

**Probe and effort question.** First run the non-spawning probe
`ai-factory dispatch implement --json --print`. `noop` means no dispatch: continue
in-process without a second call. If it returns `effort_ask: true` (the phase sets
`"effort": "ask"`) and this is an interactive session, ask one single-select question
with the runtime-aware question contract before anything else:
`Which effort for the implement phase?` with the options `low`, `medium`, `high`, `xhigh`, `max`.
Then add `--effort <chosen level>` to the dispatch command below. Non-interactive runs
(`HANDOFF_MODE=1`, or no question tool) skip the question and omit `--effort`; the agent
then uses its model default.

```
ai-factory dispatch implement --json [--effort <level>] --prompt "<handoff>"
```

`<handoff>` is one argv element: `This is the dispatched implement phase. Run
/aif-implement in-process in this agent and do not call ai-factory dispatch. Arguments:`
followed by the original `$ARGUMENTS` verbatim, plus the resolved plan artifact path.

Route only on the dispatcher JSON `status` on stdout, never on child output:

- `noop` → continue in-process.
- `manual` → show the returned `instructions` verbatim and STOP. Execute no task.
- `completed` → do not execute tasks again. Re-read the plan and show Step 2 progress.
- `error`, a non-zero exit, invalid JSON, or an unavailable CLI → warn once and continue
  in-process.
