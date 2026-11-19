# Use current state rather than reproducible run snapshots

The sole maintainer prioritizes simplicity over historical reproducibility.
Workflow execution will use current state without pinning dataset versions or
retaining holdings snapshots for reproduction. Consequently a
delayed execution or retry may observe changed inputs; repeatable historical
results are not a guarantee of this service.

The workflow specification is read once at execution start and retained for that
active execution so durable checkpoints refer to a stable sequence. Definition
edits affect subsequent runs. This execution safeguard does not provide historical
reproducibility or pin datasets and holdings.
