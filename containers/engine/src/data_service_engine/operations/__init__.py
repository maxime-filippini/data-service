"""Workflow operations: one uniform contract and dispatcher for the Python
work a workflow step asks for, such as normalizing downloaded prices.

The Worker's registered step types call `POST /operations/{name}` with the
run/step identity, resolved inputs (small values and artifact references)
and params. An operation returns small JSON, typically an artifact reference
to the data it wrote under the run's namespace. Python never sequences
workflows, waits for data or retries: the Worker's executor does.
"""
