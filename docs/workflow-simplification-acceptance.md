# Agreed acceptance boundaries

- API creates assets and portfolios and creates, retrieves, and replaces whole
  workflow specifications. Incremental visual authoring is deferred.
- The app provides a read-only view of definitions, step wiring, and runs.
- Automatic downloads use the new download/normalization workflow.
- A portfolio workflow checks dated upstream success and invokes Python.
- Dataset retrieval uses dataset name plus subject (asset symbol or portfolio ID).
- Configuration deletion removes assignments but retains historical run records
  and R2 artifacts. Active runs block affected deletion; portfolio holdings block
  deletion of referenced assets. Artifact cleanup is separate.
- A fixture-based local command uses the same step implementations to demonstrate
  the data path without live market-data access, with inspectable outputs.
- Superseded orchestration and the separate Python service are removed.

The purpose is maintainability by one developer: the sequence, code entry points,
inputs, outputs, and failures must be understandable through the code, local
execution, and the read-only app view.
