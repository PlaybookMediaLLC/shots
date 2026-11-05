# Terms of Service (draft)

> **DRAFT — requires counsel review.** Not legal advice. Do not publish. This draft replaces
> `app/[locale]/terms/page.tsx` (live date: September 27, 2026). Code baseline: commit `bad06b3e`.

## Summary

- These Terms are a business contract between Playbook Interactive Media, LLC, a Delaware company, and the
  customer that owns a workspace. Shots is offered in the United States.
- Every workspace needs a paid plan. Plans renew automatically until you cancel. Cancellation takes
  effect at the end of the paid period.
- You own your content and the AI output that you create. You review AI output before you publish
  it.
- You are responsible for what you publish to social networks. We are not responsible when a
  network fails, changes its API, or suspends your account.
- There is no uptime commitment unless an Enterprise order form gives one.
- You can get a full refund of a payment if you ask within 30 days of it. Stripe Tax calculates
  sales tax.
- Our liability is limited. Disputes go to `[[VENUE]]` under `[[GOVERNING LAW]]`.

## Owner decisions in this draft (2026-10-17)

| Topic         | Decision                                                |
| ------------- | ------------------------------------------------------- |
| Legal entity  | Playbook Interactive Media, LLC, a Delaware limited liability company |
| Target market | United States only                                      |
| Refunds       | Full refund if the customer asks within 30 days         |
| Sales tax     | Calculated and collected with Stripe Tax                |
| Self-hosting  | Not offered                                             |

## Redline: changes from the live page

| Live section                   | Live text (short)                                                                         | Change                                                                                                                                                   | Reason                                                                                                     |
| ------------------------------ | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Title                          | "Terms & Conditions"                                                                      | Rename to "Terms of Service". Add version and effective date.                                                                                            | The footer and sign-up page already say "Terms of Service". Versions support P5 and P6.                    |
| 1. Acceptance                  | "By accessing and using Shots ... you agree"                                              | Name the parties. Require active acceptance at sign-up. Add authority to bind a company.                                                                 | The live text names no company. Sign-up shows the Terms but does not record acceptance (P5).               |
| 2. Description of Service      | "Editing happens in your browser, and images you import are not uploaded"                 | Replace with a full service description.                                                                                                                 | Cloud projects upload images. The product also has AI, publishing, email, an API, and enterprise features. |
| 3. Use of Service              | Four short prohibitions                                                                   | Move to the Acceptable Use Policy. Keep a short summary.                                                                                                 | A B2B platform with AI and publishing needs specific rules.                                                |
| 4. Intellectual Property       | "The Shots software itself is open source and licensed under the Apache 2.0 license"      | Split into content ownership (section 8), our IP, and an open-source notice (section 15).                                                                | The hosted service is not the same as the source code license. Counsel confirms the license notice.        |
| 5. Advertising and Third-Party | "The screenshot editor is included in every plan, and content pages are supported by ads" | Keep the third-party rule. Move ads to the Privacy Policy.                                                                                               | Ads are a privacy topic. Third-party platform terms need their own section (section 10).                   |
| 6. Your Content                | Responsibility for images, text, and URLs                                                 | Expand: license to us, AI, publishing, audience lists, and the DPA.                                                                                      | We need a license to host, process, and publish content for you.                                           |
| 7. Disclaimer of Warranties    | "as is" and "as available"                                                                | Keep. Add AI and third-party disclaimers.                                                                                                                | AI output and platform delivery need specific disclaimers.                                                 |
| 8. Limitation of Liability     | "Shots or its creator"                                                                    | Name the entity. Add a cap and carve-outs.                                                                                                               | The live clause has no cap and names no company.                                                           |
| 9. Changes to Terms            | "Continued use ... constitutes acceptance"                                                | Add advance notice for material changes and a right to cancel.                                                                                           | Silent changes to a paid contract are hard to enforce (P6).                                                |
| 10. Contact                    | Contact page link                                                                         | Add `[[LEGAL EMAIL]]` and `[[ADDRESS]]` for notices.                                                                                                     | Contracts need a notice address.                                                                           |
| (new)                          | —                                                                                         | Add billing, renewal, cancellation, refunds, taxes, limits, AI, publishing, API, support, suspension, DMCA, indemnity, governing law, and general terms. | These topics exist in the product and are missing from the live Terms.                                     |

---

## Proposed text

**Terms of Service**

Version `[[VERSION]]`. Effective `[[EFFECTIVE DATE]]`.

### 1. The agreement

1. These Terms are a contract between Playbook Interactive Media, LLC, a Delaware limited liability company,
   `[[ADDRESS]]` ("we", "us"), and the customer that creates or owns a workspace ("you").
2. You accept these Terms when you select the acceptance control at sign-up, sign an order form
   that refers to them, or use Shots. ⚑ Requires product change P5 for the acceptance control.
3. If you accept for a company, you confirm that you have the authority to bind it. "You" then means
   the company.
4. These documents are part of the agreement: the [Acceptable Use Policy](acceptable-use-policy.md),
   the [AI Use Policy](ai-use-policy.md), the [API Terms](api-terms.md), the
   [Data Processing Addendum](data-processing-addendum.md), and any order form. If an order form
   conflicts with these Terms, the order form wins.

### 2. Eligibility

1. Shots is for business and professional use.
2. We offer Shots to businesses in the United States. `[[COUNSEL: decide whether to refuse sign-ups from outside the United States]]`
3. You must be at least `[[MINIMUM AGE]]` and able to make a binding contract.
4. You must not use Shots if the law prohibits it, including sanctions and export control law.
   `[[COUNSEL: confirm the sanctions clause]]`

### 3. Accounts and workspaces

1. Each person uses their own account. Keep your password and two-factor codes secret.
2. A workspace belongs to the customer. The workspace owner controls billing, members, roles, SSO,
   SCIM, and deletion.
3. Roles control what each member can do. Approving and publishing are separate permissions.
4. If your company uses SSO or SCIM, your identity provider controls who can sign in. You are
   responsible for the people that you provision.
5. You are responsible for all activity in your workspace, including activity by API keys and
   agents that you create.
6. Tell us at once at `[[SECURITY EMAIL]]` if you suspect unauthorized access.

### 4. The service

1. Shots helps you turn product releases into marketing content. It includes a screenshot editor,
   image tools, AI drafting, approval, scheduling, publishing, release email, an API, and enterprise
   controls.
2. We can change features over time. We do not remove a core paid feature during a paid period
   without notice. `[[COUNSEL: confirm]]`
3. We can offer beta features. Beta features have no warranty and can end at any time.

### 5. Plans, billing, renewal, and cancellation

1. **No free plan.** A workspace needs an active paid plan to use the editor, the tools, or the API.
2. **Plans.** The current plans, prices, seats, channels, and monthly allowances are on the
   [pricing page](https://shots.playbookmedia.io/pricing). Enterprise plans use an order form and
   an invoice.
3. **Payment.** Stripe processes self-serve payments. You authorize us and Stripe to charge your
   payment method for each billing period.
4. **Automatic renewal.** Monthly and annual plans renew automatically for the same period at the
   then-current price, until you cancel.
5. **Cancellation.** A workspace admin can cancel at any time in the billing portal. Cancellation
   takes effect at the end of the current paid period. Plan features stay on until then.
6. **Plan changes.** When you change plans in the billing portal, Stripe prorates the charge.
7. **Failed payments.** Stripe retries a failed payment. The workspace keeps its plan for 14 days.
   After that, plan features close until you pay.
8. **Price changes.** We tell you about a price change at least `[[NOTICE PERIOD]]` days before
   your next renewal. The new price applies from that renewal.
9. **Refunds.** If you ask within 30 days of a payment, we refund that payment in full. See the
   [Refund Policy](refund-policy.md).
10. **Taxes.** Prices do not include sales tax. We calculate and collect sales tax with Stripe Tax,
    based on your billing address. ⚑ Requires product change P15.
11. **When a plan ends.** Plan features close. Your workspace content stays for
    `[[RETENTION PERIOD FOR INACTIVE WORKSPACES]]`. ⚑ Requires product change P12.

### 6. Allowances and credits

1. Each plan includes monthly allowances for AI credits, posts, emails, storage, seats, and social
   channels.
2. Monthly allowances reset on the first day of each month (UTC). Unused monthly allowances do not
   carry over.
3. When you reach a limit, Shots refuses the next action of that type and shows an error.
4. You can buy extra AI credit packs. Pack credits are used after the monthly allowance and do not
   expire while the workspace has a plan. `[[COUNSEL: confirm what happens to pack credits when the workspace is deleted]]`
5. Credits have no cash value. You cannot transfer them to another workspace.

### 7. Acceptable use

You must follow the [Acceptable Use Policy](acceptable-use-policy.md). In short: do not break the
law, do not infringe rights, do not mislead people, do not send spam, and do not attack or overload
the service.

### 8. Your content

1. **Ownership.** You keep all rights in the content that you put into Shots ("Customer Content").
2. **License to us.** You give us a worldwide, non-exclusive license to host, copy, process,
   transmit, and display Customer Content only to provide and secure the service for you. This
   includes sending it to the AI providers and the platforms that you choose.
3. **Your responsibility.** You confirm that you have the rights and consents for your content. This
   includes images, trademarks, screenshots of other products, and the email addresses in your
   audience lists.
4. **Audience email.** You must have a lawful basis to email each address that you add. You must
   honor unsubscribes. Shots adds an unsubscribe link to each announcement.
5. **Personal data.** Our [Data Processing Addendum](data-processing-addendum.md) governs personal
   data in Customer Content.
6. **Feedback.** You can send us ideas. We can use them without any duty to you.

### 9. AI features and output

1. **Ownership.** As between you and us, you own the output that AI features create for you, to the
   extent the law allows. We assign to you any rights that we have in that output.
2. **No guarantee.** AI output can be wrong, incomplete, or similar to output for other users. You
   must review it before you use or publish it.
3. **Human approval.** Shots does not let AI approve or publish a post. A teammate must approve each
   post.
4. **Disclosure.** You are responsible for any AI disclosure label that a law or a platform
   requires. ⚑ Product change P13 adds labels in the product.
5. **Providers.** AI features use third-party model providers through OpenRouter. See the
   [subprocessor list](subprocessors.md).
6. **Control.** A workspace owner or admin can turn off AI features in the workspace settings.
7. See the [AI Use Policy](ai-use-policy.md).

### 10. Publishing to third-party platforms

1. When you connect a social account, you authorize us to publish the posts that your workspace
   approves, at the times that you set.
2. You are responsible for your posts and for following each platform's terms, rules, and
   advertising and disclosure policies.
3. Social networks and other platforms are not our subcontractors. We are not responsible when a
   platform is unavailable, changes or removes an API, limits your posting, rejects a post, or
   suspends your account.
4. If a platform does not confirm a post, Shots marks the delivery as unknown and does not retry it
   automatically. This prevents duplicate posts. You must check the platform.
5. We can pause a connection to protect your account, our service, or the platform.

### 11. API, agents, and MCP

1. You can use the API with keys that your workspace creates. Keys have limited scopes. No key can
   approve or publish.
2. You are responsible for every action that your keys, scripts, and AI agents take.
3. The [API Terms](api-terms.md) apply to all API use.
4. We do not publish an official MCP server today. If we publish one, the API Terms apply to it.

### 12. Support and service levels

1. We give support by email at `[[SUPPORT EMAIL]]` during `[[SUPPORT HOURS]]`.
2. Self-serve plans have no uptime commitment and no service credits.
3. An Enterprise order form can add a service level. See the
   [Support and Service Levels policy](support-and-service-levels.md).

### 13. Suspension and termination

1. **Suspension.** We can suspend access without notice if you breach the Acceptable Use Policy,
   if your use puts the service or others at risk, or if the law requires it. We can suspend plan
   features for non-payment after the grace period in section 5.7.
2. **Termination by you.** You can cancel your plan at any time (section 5.5). An owner can delete
   the workspace.
3. **Termination by us.** We can end these Terms for a material breach that you do not fix within
   `[[CURE PERIOD]]` days after notice. We can end them for convenience with `[[NOTICE PERIOD]]`
   days of notice and a pro rata refund of prepaid fees. `[[COUNSEL: confirm]]`
4. **After termination.** You can export your content for `[[EXPORT WINDOW]]` days. ⚑ Requires
   product change P4. Then we delete it as the [Privacy Policy](privacy-policy.md) and the DPA
   describe. ⚑ Requires product change P2.
5. Sections 8.6, 9.1, 15, 17, 18, 19, 20, and 22 survive termination.

### 14. Our intellectual property

We and our licensors own the service, its design, and the Shots name and logo. These Terms do not
give you any right to our trademarks. We reserve all rights that these Terms do not grant.

### 15. Open-source software

1. Shots includes open-source software. Each component keeps its own license.
2. Parts of the editor come from the Screenshot Studio project by Kartik Labhshetwar under the
   Apache License 2.0.
3. `[[COUNSEL: confirm the license of each other upstream project in the repository, and list the required notices here.]]`
4. The open-source licenses govern the source code. These Terms govern your use of the hosted
   service.

### 16. Copyright complaints

We respond to notices of copyright infringement. See the [Copyright Policy](copyright-policy.md).

### 17. Confidentiality

Each party keeps the other party's non-public information confidential. Each party uses it only to
perform these Terms. This duty does not cover information that is public, already known, or
independently developed.

### 18. Warranties and disclaimers

1. We will provide the service with reasonable care and skill. `[[COUNSEL: confirm]]`
2. Except for that promise, we provide the service "as is" and "as available". We disclaim all
   other warranties, including merchantability, fitness for a purpose, and non-infringement, to the
   extent the law allows.
3. We do not promise that the service is uninterrupted or error-free, that AI output is accurate,
   or that a platform accepts a post.

### 19. Limitation of liability

1. Neither party is liable for indirect, incidental, special, consequential, or punitive damages,
   or for lost profits, revenue, or data, to the extent the law allows.
2. Each party's total liability under these Terms is limited to `[[LIABILITY CAP]]`.
3. These limits do not apply to `[[CARVE-OUTS: for example, your payment duties, either party's indemnity duties, and fraud]]`.

### 20. Indemnity

1. **By you.** You defend us against third-party claims that come from your content, your posts,
   your audience email, or your breach of the Acceptable Use Policy. You pay the resulting damages
   and costs.
2. **By us.** `[[COUNSEL: decide whether we defend customers against claims that the service infringes intellectual property rights, and the limits.]]`
3. The party that asks for defense must give prompt notice, control of the defense, and reasonable
   help.

### 21. Governing law and disputes

1. `[[GOVERNING LAW]]` governs these Terms.
2. `[[DISPUTE PROCESS]]`. The courts or arbitration seat at `[[VENUE]]` have exclusive
   jurisdiction.
3. Either party can ask a court for urgent relief to protect its intellectual property or
   confidential information.

### 22. Changes to these Terms

1. We can change these Terms. For a material change, we tell you by email or in the product at least
   `[[NOTICE PERIOD]]` days before it takes effect. ⚑ Requires product change P6.
2. If you do not agree, you can cancel before the change takes effect.
3. We record the version that each customer accepts. ⚑ Requires product change P5.

### 23. General

1. **Assignment.** You cannot transfer these Terms without our consent. We can transfer them in a
   merger, acquisition, or sale of assets.
2. **Force majeure.** Neither party is liable for delays that events outside its reasonable control
   cause.
3. **Notices.** We send notices to the workspace owner's email address. You send notices to
   `[[LEGAL EMAIL]]` and `[[ADDRESS]]`.
4. **Entire agreement.** These Terms and the documents in section 1.4 are the whole agreement.
5. **Severability.** If a court finds a clause invalid, the rest stays in force.
6. **No waiver.** A delay in using a right is not a waiver.

### 24. Contact

Playbook Interactive Media, LLC, `[[ADDRESS]]`. Email `[[LEGAL EMAIL]]`.
