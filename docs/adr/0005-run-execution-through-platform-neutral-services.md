# Run execution through platform-neutral services

Workflow runs are executed and started by Effect programs that depend only on
services; the platform lives in the layers that provide them. Durable
execution is the `Checkpointer` service: `checkpoint(name, effect, policy)` runs
an effect once and returns its stored result on replay, and `sleepUntil` sleeps
durably. Launching instances will be a `RunLauncher` service, and starting,
rerunning, reconciling and dispatching runs a `RunCoordinator` built from it
and the run store. Time comes from Effect's `Clock`.

Cloudflare is one set of layers (`CloudflareCheckpointerLive(step)` over
`step.do`); local runs and tests are another (`LocalCheckpointerLive`, where an
eviction is a fiber interruption), so only adapters import Cloudflare modules.
The executor and the step types stay the same on any host that can provide
these services. Each entry point (Workflow class, route, cron handler) picks a
layer and runs a program; it does not pass platform objects, clocks or effect
runners through the logic. The executor itself is a program, not a service: it
has one implementation, and its requirements are visible in its type.
