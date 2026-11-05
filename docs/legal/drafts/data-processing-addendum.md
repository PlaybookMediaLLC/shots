# Data Processing Addendum (draft)

> **DRAFT — requires counsel review.** Not legal advice. Do not publish. Shots has no DPA today.
> Code baseline: commit `bad06b3e`.

## Summary

- This addendum covers personal data that a customer puts into a Shots workspace.
- The customer is the business (controller). Playbook Interactive Media, LLC is its service provider (processor).
- We process the data only to provide Shots, on the customer's instructions.
- We use the subprocessors on our list. We give notice before we add one, and the customer can
  object.
- We tell the customer about a personal data breach within `[[BREACH NOTICE TIME]]`.
- At the end of the service, the customer can export the data. Then we delete it.

## Why Shots needs a DPA

1. Workspaces hold personal data of members, invitees, audience email recipients, and people in
   uploaded screenshots.
2. The CCPA as amended by the CPRA requires a written contract with specific terms before a
   business discloses personal data to a service provider. The Virginia, Colorado, Connecticut,
   Texas, Oregon, and other state laws require similar processor contracts.
3. Enterprise buyers with SSO and SCIM ask for a DPA during procurement.
4. Shots targets US customers only (owner decision, 2026-10-17). This draft has no EU or UK
   transfer terms. Add them if a customer outside the US needs them.

---

## Proposed text

**Data Processing Addendum**

Version `[[VERSION]]`. Effective `[[EFFECTIVE DATE]]`.

This addendum is part of the [Terms of Service](terms-of-service.md) between Playbook Interactive Media, LLC, a
Delaware limited liability company ("Processor"), and the customer ("Customer").

### 1. Definitions

"Data Protection Law" means the California Consumer Privacy Act as amended by the California
Privacy Rights Act (CCPA), and the other US state consumer privacy laws that apply to the
processing. Words such as "personal data", "personal information", "processing", "controller",
"business", "processor", "service provider", "sell", "share", and "personal data breach" have the
meanings in Data Protection Law. "Customer Personal Data" means personal data in Customer Content
that Processor processes for Customer.

### 2. Roles and scope

1. Customer is the controller (a "business" under the CCPA) of Customer Personal Data. Processor is
   its processor (a "service provider" under the CCPA).
2. Annex I describes the processing.
3. Processor is a controller for account, billing, security, and website data. The
   [Privacy Policy](privacy-policy.md) covers that data, not this addendum.

### 3. Instructions

1. Processor processes Customer Personal Data only on Customer's documented instructions. The Terms,
   this addendum, and Customer's use of the product settings are those instructions.
2. Processor tells Customer if it thinks an instruction breaks Data Protection Law.
3. Processor does not sell Customer Personal Data. Processor does not use it for its own purposes,
   including to train AI models.

### 4. People with access

Processor allows access to Customer Personal Data only to staff and contractors who need it. Each
of them has a duty of confidentiality. Processor staff access a workspace for support only through a
time-limited support access grant that Customer approves. `[[CONFIRM: support access process]]`

### 5. Security

Processor uses the measures in Annex II. Processor can update them, but must not reduce the overall
protection.

### 6. Subprocessors

1. Customer gives general authorization for Processor to use subprocessors.
2. The current list is at `[[SUBPROCESSOR LIST URL]]` ([draft](subprocessors.md)).
3. Processor tells Customer about a new or replacement subprocessor at least `[[NOTICE PERIOD]]`
   days before it starts. Customer can subscribe to these notices.
4. Customer can object on reasonable data protection grounds within that period. The parties then
   discuss a solution in good faith. If they cannot agree, Customer can end the affected service
   and receive a pro rata refund of prepaid fees.
5. Processor makes each subprocessor accept data protection duties that are no less protective than
   this addendum. Processor stays liable for its subprocessors.
6. When Customer connects a social network, Slack, Notion, Figma, an app store, or an audit log
   destination, that service is Customer's choice. It is not Processor's subprocessor.

### 7. Help with data subject requests

1. Processor sends Customer any request that it receives about Customer Personal Data. Processor does
   not answer it without Customer's permission.
2. Processor helps Customer answer requests through product features and, where needed, by other
   reasonable means. ⚑ Requires product changes P3 and P4 for self-serve deletion and export.

### 8. Personal data breach

1. Processor tells Customer without undue delay, and within `[[BREACH NOTICE TIME]]`, after it
   becomes aware of a personal data breach that affects Customer Personal Data.
2. The notice describes the breach, the data and people affected, the likely effects, and the
   measures that Processor takes. Processor sends more facts as it learns them.
3. A notice is not an admission of fault.

### 9. Assessments

Processor gives reasonable help with the data protection assessments that Data Protection Law
requires and that relate to the service.

### 10. Return and deletion

1. During the service, Customer can download its files and content through the product.
2. After the service ends, Customer can export Customer Personal Data for `[[EXPORT WINDOW]]` days.
   ⚑ Requires product change P4.
3. When an owner deletes a workspace, Processor waits 14 days. Then Processor deletes the workspace
   content. ⚑ Requires product change P2.
4. Copies in backups expire on the backup schedule in Annex II. Processor keeps a deletion record and
   audit records until their retention period ends.
5. Processor can keep data that the law requires it to keep. This addendum continues to protect
   that data.

### 11. Audits

1. Processor gives Customer the information that Customer reasonably needs to show compliance with
   Data Protection Law.
2. Processor answers one security questionnaire a year without charge. `[[COUNSEL: on-site audit terms, notice, cost, and frequency]]`
3. Processor holds no third-party security certification today. `[[CERTIFICATIONS: update when an auditor issues one]]`

### 12. Data location

1. Processor processes Customer Personal Data in the United States and in the regions on the
   subprocessor list.
2. If Customer wants to put personal data from outside the United States into Shots, the parties
   first agree the transfer terms in writing.

### 13. US state law terms

For the CCPA and similar laws, Processor is a "service provider" or "processor". Processor does not
sell or share Customer Personal Data. Processor does not keep, use, or disclose it outside the
direct business relationship with Customer. Processor does not combine it with other data, except
as the law allows.

### 14. Liability and precedence

1. The liability terms of the Terms of Service apply to this addendum. `[[COUNSEL: confirm any separate cap for data protection claims]]`
2. If this addendum conflicts with the Terms, this addendum wins for Customer Personal Data.

---

### Annex I: Details of the processing

| Item               | Details                                                                                                                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subject matter     | Hosting and processing of Customer Content to provide Shots.                                                                                                                                                   |
| Duration           | The term of the Terms, plus the deletion period in section 10.                                                                                                                                                 |
| Nature and purpose | Storage, editing, rendering, AI drafting, approval, scheduling, publishing to platforms that Customer chooses, release email, audit logging, and support.                                                      |
| People affected    | Workspace members and invitees; audience email recipients; people who appear in uploaded files or screenshots; people named on websites that Customer asks Shots to read; owners of connected social accounts. |
| Personal data      | Names, email addresses, profile images, roles, account IDs and usernames at connected services, content of posts and files, AI prompts and outputs, unsubscribe status, audit metadata.                        |
| Sensitive data     | Not intended. Customer must not upload sensitive personal information (for example health data or government ID numbers) unless the law allows it.                                                             |
| Frequency          | Continuous.                                                                                                                                                                                                    |
| Retention          | See section 10 and the [Privacy Policy](privacy-policy.md) retention table.                                                                                                                                    |

### Annex II: Technical and organizational measures

These measures exist in the product today.

1. **Access control.** Fixed roles per workspace. Every server operation checks membership and a
   named permission. A request for a record in another workspace returns "not found".
2. **Authentication.** Passwords of at least 12 characters, two-factor sign-in, SSO (SAML and OIDC),
   and SCIM on Enterprise plans. A fresh two-factor session is required to change SSO, SCIM, and
   social connections. Sign-in attempts are rate limited.
3. **Secrets.** API keys and SCIM tokens are stored as hashes. Credentials for audit destinations,
   Slack, Notion, Figma, and app stores are encrypted with AES-256-GCM. ⚑ Product change P9 adds
   encryption for social and sign-in OAuth tokens.
4. **Storage.** Files are in a private bucket under a path for each workspace. Upload and download
   links expire after two minutes. Uploads are write-once.
5. **Separation.** The web application has no database connection and no storage credentials. A
   test enforces this.
6. **Audit.** An append-only audit log that a database trigger enforces. IP addresses in audit
   records are keyed hashes. Default retention is 90 days.
7. **Backups.** Point-in-time recovery for `[[CONFIRM: 2 days]]`, and a backup before each database
   migration, kept for 14 days.
8. **Encryption in transit.** `[[CONFIRM: TLS on all public endpoints and provider connections]]`
9. **Encryption at rest.** `[[CONFIRM: database and object storage encryption at each provider]]`
10. **Incident response.** `[[CONFIRM: written incident response process]]`
11. **Staff.** `[[CONFIRM: confidentiality agreements, access reviews, and security training]]`

### Annex III: Subprocessors

See the [subprocessor list](subprocessors.md).
