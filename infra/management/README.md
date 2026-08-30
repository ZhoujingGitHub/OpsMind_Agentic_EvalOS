# Fixed management channel

The fixed management channel is infrastructure-only. It does not participate in
the EvalOS Agent loop, candidate execution, Twin preparation, grading, or Trial
control.

The `opsmind-maint` SSH identity is accepted only from `10.77.240.2/32` over the
WireGuard management overlay. Its authorized key uses OpenSSH `restrict` and a
forced command, so it cannot request a shell, PTY, SFTP subsystem, agent/X11
forwarding, or TCP forwarding.

The root wrapper accepts exactly three operations:

- `status`
- `upload RELEASE SHA256 BYTES BASE64_BYTES`
- `deploy RELEASE SHA256`

Uploads are Base64 text to avoid platform-dependent binary stdin conversion.
The server verifies encoded length, decoded length, and SHA-256 before an atomic
rename. Deployment delegates to the existing release installer, which preserves
the database backup and rollback gates. No secret is embedded in these files;
the public key is supplied to the installer at deployment time.
