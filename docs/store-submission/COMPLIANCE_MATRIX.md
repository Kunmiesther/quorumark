# Store compliance evidence matrix

No live venue is enabled in a storefront until every item in its row has an
owner, evidence link, review date, and approval. Engineering controls fail
closed when evidence is incomplete.

| Requirement | Current control | Submission evidence still required |
| --- | --- | --- |
| Noncustodial operation | Withdrawal permissions are rejected; funds remain at the selected venue | Reviewer walkthrough and screenshots |
| Live trading | ApeX mainnet execution remains disabled | Territory-by-territory legal approval before enabling |
| Centralized venues | Customer choice is limited to Coinbase and Kraken | Venue terms, supported territories, and counsel approval |
| AI data sharing | Separate, revocable Profile consent; deterministic guidance remains available without consent | App Privacy answers and provider/subprocessor list |
| Account deletion | In-app deletion removes user-owned Storage objects, Auth identity, sessions, and cascading application rows | Staging deletion recording and post-delete sign-in failure |
| Reviewer access | Paper mode places no real order | Dedicated reviewer credentials and support contact |
| Notifications | Native token registration, APNs entitlement, and Android 13 permission exist | APNs/Firebase credentials and physical-device delivery evidence |
| Resilience | Remote app has a bundled offline recovery screen | Airplane-mode and slow-network recordings |

## Release rule

A release owner must attach the completed device matrix, successful release
doctor output, store privacy questionnaire, and legal venue approval to the
release ticket. Missing evidence blocks submission; it is never replaced by a
code comment or an assumed approval.
