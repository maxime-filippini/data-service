# Expire temporary artifacts using R2 lifecycle rules

Temporary workflow artifacts are stored under a dedicated run prefix and expire
through an R2 lifecycle rule after 30 days, based on object age. Simplicity takes priority over
precise retention measured from run completion, so no D1 cleanup timestamps,
per-artifact index, or scheduled cleanup task is introduced.

Published datasets occupy separate storage paths and remain independent of
temporary artifacts. The lifecycle rule excludes published datasets and existing
retained raw history. Retention must allow ample time for workflow waits and
retries: lifecycle expiration does not inspect active-run status. The retention
duration is configurable through the bucket lifecycle rule.
