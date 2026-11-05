# Legal document drafts

> **DRAFT — requires counsel review.** These files are proposals, not legal advice. Do not publish
> them. Nothing here changes the live pages. The owner must approve each document before release.

## Summary

- These drafts replace the live Terms and Privacy Policy, and they correct the Security page.
- They also add the documents that a B2B platform with workspaces, SSO, SCIM, and AI needs.
- The facts in each draft come from the code at commit `bad06b3e` (2026-10-17).
- A `[[PLACEHOLDER]]` marks each fact that the code cannot prove. Counsel or the owner must fill it.
- A "⚑ Requires product change Pn" note marks a promise that the product does not keep yet. Do not
  publish that clause until the change ships, or remove the clause.

## Documents

| File                                                           | Replaces or adds                            | Live route today  |
| -------------------------------------------------------------- | ------------------------------------------- | ----------------- |
| [terms-of-service.md](terms-of-service.md)                     | Replaces the live Terms                     | `/terms`          |
| [privacy-policy.md](privacy-policy.md)                         | Replaces the live Privacy Policy            | `/privacy-policy` |
| [security-page.md](security-page.md)                           | Corrects the live Security page copy        | `/security`       |
| [data-processing-addendum.md](data-processing-addendum.md)     | Adds a DPA                                  | none              |
| [subprocessors.md](subprocessors.md)                           | Adds a subprocessor list                    | none              |
| [cookie-policy.md](cookie-policy.md)                           | Adds a cookie policy and banner rules       | none              |
| [acceptable-use-policy.md](acceptable-use-policy.md)           | Adds an acceptable use policy               | none              |
| [ai-use-policy.md](ai-use-policy.md)                           | Adds an AI use policy                       | none              |
| [copyright-policy.md](copyright-policy.md)                     | Adds a copyright and DMCA policy            | none              |
| [support-and-service-levels.md](support-and-service-levels.md) | Adds a support policy                       | none              |
| [responsible-disclosure.md](responsible-disclosure.md)         | Adds a disclosure policy and `security.txt` | none              |
| [refund-policy.md](refund-policy.md)                           | Adds a refund and cancellation policy       | none              |
| [api-terms.md](api-terms.md)                                   | Adds API, agent, and MCP terms              | none              |

## Owner decisions (2026-10-17)

These answers are now in the drafts. They are no longer placeholders.

| Topic                   | Decision                                                |
| ----------------------- | ------------------------------------------------------- |
| Legal entity            | Playbook Interactive Media, LLC, a Delaware limited liability company |
| Target market           | United States only. No EU or UK terms in these drafts.  |
| Role for workspace data | Service provider (processor) for the customer           |
| AI training             | We do not use customer data to train models             |
| Refunds                 | Full refund if the customer asks within 30 days         |
| Sales tax               | Stripe Tax                                              |
| Self-hosting            | Not offered                                             |
| Insurance               | None today                                              |

## Placeholders

Use these names in every draft. Fill each one once, then replace it everywhere.

| Placeholder                                    | Meaning                                                       |
| ---------------------------------------------- | ------------------------------------------------------------- |
| `[[ADDRESS]]`                                  | The registered postal address of that company                 |
| `[[GOVERNING LAW]]`                            | The law that governs the Terms                                |
| `[[VENUE]]`                                    | The courts or the arbitration seat for disputes               |
| `[[DISPUTE PROCESS]]`                          | Courts, arbitration, or a mix, and any class-action waiver    |
| `[[PRIVACY EMAIL]]`                            | The address for privacy requests                              |
| `[[SECURITY EMAIL]]`                           | The address for vulnerability reports                         |
| `[[SUPPORT EMAIL]]`                            | The address for support                                       |
| `[[LEGAL EMAIL]]`                              | The address for legal notices and copyright notices           |
| `[[EFFECTIVE DATE]]`                           | The date the document takes effect                            |
| `[[NOTICE PERIOD]]`                            | The days of notice before a material change takes effect      |
| `[[LIABILITY CAP]]`                            | The maximum liability amount                                  |
| `[[REGION: vendor]]`                           | The data region of a vendor that the code does not show       |
| `[[DMCA AGENT]]`                               | The registered DMCA agent name and address                    |
| `[[MINIMUM AGE]]`                              | The minimum age for an account                                |
| `[[BREACH NOTICE TIME]]`                       | The time limit to tell customers about a personal data breach |
| `[[SUPPORT HOURS]]`                            | The support hours and time zone                               |
| `[[ABUSE EMAIL]]`                              | The address for abuse reports                                 |
| `[[VERSION]]`                                  | The document version number                                   |
| `[[EXPORT WINDOW]]`                            | The days a customer can export data after the service ends    |
| `[[CURE PERIOD]]`                              | The days a party has to fix a breach after notice             |
| `[[RETENTION PERIOD FOR INACTIVE WORKSPACES]]` | How long content stays after a plan ends                      |

Two markers carry a note after the colon:

- `[[CONFIRM: ...]]` marks a fact that someone must check in the live configuration or a contract.
- `[[COUNSEL: ...]]` marks a legal decision for counsel.

A few placeholders appear in one document only. Each one names its meaning.

## Product changes that the drafts depend on

The private audit report lists each change with evidence and size. The IDs are:

| ID  | Change                                                                   |
| --- | ------------------------------------------------------------------------ |
| P1  | A "Your Privacy Choices" opt-out that honors Global Privacy Control      |
| P2  | A workspace purge that deletes every piece of workspace content          |
| P3  | Self-serve account deletion                                              |
| P4  | Account and workspace data export                                        |
| P5  | A sign-up step that records the accepted document versions               |
| P6  | Versioned legal documents and an "updated" notice                        |
| P7  | `/.well-known/security.txt` and a security mailbox                       |
| P8  | A social channel disconnect that deletes tokens (the Meta deletion URL is built) |
| P9  | Encryption at rest for social and sign-in OAuth tokens                   |
| P10 | A review of the public social API routes                                  |
| P11 | AI provider data controls set in code                                    |
| P12 | Retention jobs for AI history, sessions, and inactive workspaces         |
| P13 | Labels for AI-generated content                                          |
| P14 | Self-hosted fonts and browser libraries, or disclosure and consent       |
| P15 | Stripe Tax in both Checkout sessions                                     |
| P16 | Remove the self-hosting answers from the pricing and Security pages      |

## How to review

1. Read the summary at the top of each draft.
2. Read the redline table. It shows each change from the live page and the reason.
3. Fill the placeholders.
4. Decide each "⚑ Requires product change" clause: keep it and wait, or remove it.
5. Approve the text. Then an engineer moves it into the live page in a separate change.
