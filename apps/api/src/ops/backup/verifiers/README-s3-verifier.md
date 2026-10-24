# S3 version-aware delete verifier (`verifyDeleteS3.mjs`) - R22, local, unpublished

Status: engineering code validated only against a fake `aws` fixture. **No claim about real AWS S3 behaviour** until the separately
approved Stage A calibration. Not configured or activated anywhere. `BACKUP_PRUNE` stays OFF.

## Contract (same as `verifyDeleteMc.mjs`)
`node verifyDeleteS3.mjs --aws /abs/aws --expected-aws-version aws-cli/X.Y.Z --aws-sha256 <64hex> --bucket B --region R --expected-owner <12 digits> [--endpoint-url E] [--page-size 1..1000] [--max-pages 1..1000] s3://B/<key>`
stdout one JSON verdict line, stderr `verify_class=<class>`, exit 0 only for `absent` (10 delete_marker_retained, 11 versions_retained,
12 governance_locked, 13 compliance_locked, 20 access_denied_or_incomplete, 30 inconclusive, 2 usage).

## Read-only allowlist
Only `aws s3api list-object-versions | get-object-retention | get-object-legal-hold | get-object-lock-configuration`, each with a per-subcommand
flag allowlist (no bypass, profile, endpoint-override or CLI-input flags). Enforced in `buildAwsArgv` before any spawn; no shell.

## Pinned AWS CLI integrity method (nothing is downloaded by this code)
1. Obtain the AWS CLI v2 Linux installer **out of band**, verify its signature with AWS's published PGP key per AWS documentation, and
   install it into a root-owned, read-only directory (dirs 0555, files 0444/0555) such as `/opt/aee-backup/aws-cli/<version>/`.
2. Record `sha256sum <resolved path of aws>` and the exact `aws --version` first token in the approval record.
3. Pass both as `--aws-sha256` and `--expected-aws-version`. Before any s3api call the verifier resolves symlinks, refuses a
   non-executable or group/other-writable file, hashes the binary and compares, then compares `aws --version` exactly. Any mismatch
   yields `inconclusive` with `aws_cli_integrity: ...` and no AWS call.
Limits: the hash covers the entry executable, not the CLI's `dist/` libraries (rely on the read-only root-owned directory); hash then exec
is not atomic; the engine does not yet pin the verifier script itself (see HASH-PIN-DESIGN, O-5, deferred).

## Environment isolation
Child env: `PATH=/usr/bin:/bin`, the three short-lived credential variables if set, `AWS_DEFAULT_REGION`, empty config/credentials files,
IMDS disabled. `AWS_PROFILE`, role/web-identity variables, `HOME`, `AWS_ENDPOINT_URL` are never forwarded.
Regions limited to `ap-southeast-4`, `ap-southeast-2`; endpoint must be the exact regional endpoint or loopback.
