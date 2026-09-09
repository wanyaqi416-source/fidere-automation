# Trust Beneficiary Golden Journey

## Scope

`TRUST-BEN-002` reuses one completed Personal Journey user and the user's existing trust. It never creates a user or a second trust.

Target lifecycle:

```text
TRUST_READY
-> BENEFICIARY_CREATE_ATTEMPTED
-> BENEFICIARY_CREATED
-> BENEFICIARY_BANK_ACCOUNT_CREATE_ATTEMPTED
-> BENEFICIARY_BANK_ACCOUNT_CREATED
-> ADMIN_TRUST_FOUND
-> ADMIN_BENEFICIARY_FOUND
-> ADMIN_BENEFICIARY_APPROVAL_ATTEMPTED
-> ADMIN_BENEFICIARY_APPROVED
-> CLIENT_BENEFICIARY_APPROVED
-> BENEFICIARY_DATA_VERIFIED
```

If the bank account has an independent Admin action, the flow stops after Beneficiary approval and requires a separate explicit authorization before `ADMIN_BANK_ACCOUNT_APPROVAL_ATTEMPTED`.

## Candidate Safety

- Client records are matched by the deterministic Sandbox beneficiary name within the same Trust Number.
- Admin Trust is matched by exact source-user email plus Trust Number.
- Admin Beneficiary must match name, relationship, ID suffix, percentage, masked contact identity, and bank-account suffix.
- Candidate count must equal one before any Admin action. The first or latest row is never selected.

## Historical Unconfirmed Run

Run `TBEN-20260908-AH-01` uses the existing Personal Journey trust and clicked Client Beneficiary Submit exactly once. A clean Client reload still showed no beneficiary and Admin showed beneficiary count zero.

Current Resume state:

```text
BENEFICIARY_CREATION_UNCONFIRMED
```

No bank account or Admin approval was attempted. A second Beneficiary submission is forbidden. The safe command is:

```text
npm run test:trust:beneficiary:resume-reconciliation
```

This command is read-only and keeps both mutation switches disabled.

## Verified Run

Run `TBEN-20260908-AH-02` reused the same Personal user and Trust `TR2026091286`.

- Client created `TEST BENEFICIARY AB` once after one Security Key verification.
- Client created one USD bank account for the same Beneficiary; the account remained uniquely associated.
- Admin Trust candidate count and Beneficiary candidate count were both exactly one.
- Admin detail matched name, relationship, ID type and suffix, percentage, contact identity, and address.
- Admin exposed one Beneficiary `Approve` mutation and no independent Bank Account approval action.
- Admin approved the Beneficiary once; Client subsequently showed `审核通过`.
- The final Resume stage is `BENEFICIARY_DATA_VERIFIED`.

The historical `AA` result above remains unchanged and must not be retried.

## Evidence Rules

Future Client submission captures only safe request metadata: request path, HTTP status, observation time, and the count of matching mutation responses. It never stores headers, tokens, cookies, request bodies, or response bodies. Request evidence and UI record evidence are saved independently so a loading screen cannot erase the network result.
