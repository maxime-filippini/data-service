# Data service glossary

The target domain model for the workflow simplification. Legacy execution terminology
is retained separately in [the pre-workflow glossary](docs/reference/pre-workflow-glossary.md).

## Language

**Asset**:
An instrument identified by its symbol, independently of the datasets produced for it.
_Avoid_: Tracked symbol (when referring to the instrument)

**Dataset**:
A named kind of data associated with an asset or portfolio, such as end-of-day prices
or portfolio volatility. Dataset name and subject identify its current published data.

**Subject**:
The asset or portfolio for which a workflow runs or a dataset is published.

**Portfolio**:
A named collection of dated holdings snapshots. One snapshot represents constant
holdings until a later snapshot takes effect.

**Holdings snapshot**:
The assets and their weights in a portfolio from an effective date until its next
snapshot takes effect.

**Workflow definition**:
An ordered list of configured steps with explicit data dependencies, a subject kind,
and a daily schedule.
_Avoid_: Calculation (when referring to the whole workflow)

**Step type**:
A predefined operation available for use in workflows, with defined parameters,
inputs, and outputs, such as downloading prices or calculating portfolio volatility.

**Workflow step**:
One configured occurrence of a step type in a workflow definition, with an identity
and bindings for its inputs.

**Workflow assignment**:
An individually enabled or disabled association of a workflow definition with one
asset or portfolio of the appropriate kind.

**Default workflow**:
A workflow assigned automatically when a subject is created. Changing defaults
applies to future subjects; applying defaults to existing subjects is explicit.

**Workflow run**:
One execution of a workflow definition for one assigned subject and processing date.
Only one run per assignment may be active at a time.

**Processing date**:
The date for which a run performs work and checks upstream processing success.
It does not assert that source data contains observations for that calendar date.

**Schedule occurrence**:
One daily due time of a workflow definition. It can produce one run per enabled
assignment.

**Data dependency**:
An explicit requirement for upstream data and dated processing success, checked by
a workflow step that waits within a bound without launching upstream work.

**Artifact**:
Persisted data produced or consumed by a step, addressed through an artifact
reference. Temporary run artifacts are distinct from published datasets.

**Artifact reference**:
A small descriptor identifying persisted data and its format/schema, passed between
steps instead of the data contents.

**Publication**:
The act and recorded outcome of making an artifact available as the current dataset
for a subject, independently of the temporary artifact's lifetime.
