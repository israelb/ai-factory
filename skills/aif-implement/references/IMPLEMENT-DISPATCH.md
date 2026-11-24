# Optional Phase Dispatch (`implement`)

Lets `.ai-factory.json` route plan-backed execution to another agent or model through
`phases.implement`. Without that entry, this step is a silent no-op.

Run it only on the plan-backed execution route, after plan discovery, integrity checks,
and any recovery are resolved, and before Step 1. Skip it for `--list`, `status`,
`--without-plan`, when `HANDOFF_MODE` is `1`, and when the invoking request says it is
the dispatched `implement` phase.

```
ai-factory dispatch implement --json --prompt "<handoff>"
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
