# Candidate resource accounting without cumulative quotas

The current LG deployment uses `opsmind-job-runtime-limits:2.0` and
`opsmind-open-resource/2.0`, with mode `open_with_usage_accounting`.
An explicit JSON null limit means the product records usage without stopping
the investigation at a cumulative quota. Missing fields are invalid; unknown
measurements are not evidence of either zero consumption or unlimited capacity.

EvalOS freezes these declarations with `evalos-candidate-open-resource/2.0`.
Each null candidate dimension must declare `observed_only`; its corresponding
settlement dimensions must also be null. A finite settlement reserve cannot
cover an unlimited product dimension. Source revision, OCI digest, independent
deployment proof and signed presence remain mandatory.

The candidate adapter preserves null through preflight, submission and polling.
Formal readiness requires the explicit supported public contracts and an exact
frozen resource match. Removing native quota enforcement is not permission to
accept an unknown or inconsistent contract. Usage ratios for unbounded dimensions
are null, while recorded usage continues to accumulate. Resource use does not
change the official grade.

Version 1 retains its finite positive limits and historical interpretation.
AH's resource profile and product code are unchanged. A version 2 manifest may
contain both finite AH and unbounded LG profiles; it does not equalize their limits.

Investigation quotas are separate from provider context/output capacity,
network connection failure timeouts, per-result transport/storage bounds,
tenant isolation and action approval. LG's native cancellation declaration
remains false: operational interruption is not presented as a new cancellation
API. EvalOS retains explicit cancellation handling and quarantine until product
termination and independent laboratory cleanup are established.
