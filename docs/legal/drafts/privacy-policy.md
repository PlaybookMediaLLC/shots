# Privacy Policy (draft)

> **DRAFT — requires counsel review.** Not legal advice. Do not publish. This draft replaces
> `app/[locale]/privacy-policy/page.tsx` (live date: September 27, 2026). Code baseline: commit
> `bad06b3e`.

## Summary

- Playbook Interactive Media, LLC, a Delaware company, runs Shots. Shots is offered to customers in the United
  States.
- Shots is a cloud marketing platform. It stores accounts, workspaces, files, and posts on our
  servers. The live policy still describes a browser-only editor.
- We decide how to use account, billing, website, and analytics data. For the content that a
  workspace puts into Shots, we are the customer's service provider.
- AI features send prompts, workspace context, website text, and canvas images to AI providers
  through OpenRouter. We do not train AI models on your content.
- When you connect X, Instagram, or LinkedIn, we store access tokens and post for you only after a
  teammate approves the post.
- California and other US state residents can access, correct, delete, and export their data, and
  can opt out of "sharing" for targeted ads. Some self-serve tools are not ready yet. Those clauses
  carry a "⚑" note.

## Owner decisions in this draft (2026-10-17)

| Topic                   | Decision                                      |
| ----------------------- | --------------------------------------------- |
| Legal entity            | Playbook Interactive Media, LLC, a Delaware company         |
| Target market           | United States only                            |
| Role for workspace data | Service provider (processor) for the customer |
| AI training             | We do not use customer data to train models   |

## Redline: changes from the live page

| Live section                   | Live text (short)                                                                       | Change                                                                              | Reason                                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Header                         | "Last updated: September 27, 2026"                                                      | Use `[[EFFECTIVE DATE]]` and a version number.                                      | Versioned documents let us record what each user accepted (P5, P6).                                     |
| Overview                       | "combines a browser-based image editor with a workspace platform"                       | Describe the full platform. Name Playbook Interactive Media, LLC.                                 | The product now includes cloud projects, AI, publishing, billing, SSO, SCIM, and an API.                |
| Overview                       | "Editing, compositing, and preview rendering happen on your device"                     | Keep for the editor canvas only. Add the cloud exceptions.                          | Cloud projects upload images, and AI features send canvas snapshots to AI providers.                    |
| What Stays On Your Device      | "Images you import from your device ... are never uploaded to us for editing"           | Delete. Replace with an exact list of browser-only tools.                           | When a cloud project is open, the editor uploads local images as workspace assets.                      |
| What Stays On Your Device      | "None of this reaches our servers."                                                     | Delete.                                                                             | Same reason. The sentence is true only for the listed browser tools.                                    |
| What Leaves Your Device        | Lists export, URL capture, tweet import, remote images                                  | Expand to every category in section 3.                                              | The list omits AI, social accounts, billing, uploads, audience lists, integrations, and site reading.   |
| Advertising                    | AdSense on content pages                                                                | Keep. Add the opt-out, the Global Privacy Control rule, and "Your Privacy Choices". | US state laws treat personalized ads as "sharing" or "targeted advertising" (P1).                       |
| Analytics                      | "when the deployment configures a PostHog key"                                          | State that PostHog runs in production, where, and what it records.                  | Production builds set a PostHog key and the US PostHog host. Autocapture records page views and clicks. |
| Hosting and Security           | "the deployment's hosting, storage, and network providers"                              | Name the providers. Link the subprocessor list.                                     | State laws require the categories of recipients.                                                        |
| Hosting and Security           | Rate-limit hash "for up to 60 seconds"                                                  | Keep.                                                                               | The code matches (one-minute window).                                                                   |
| Cookies                        | "We also set `NEXT_LOCALE`"                                                             | Delete `NEXT_LOCALE`. Move cookies to the Cookie Policy.                            | The locale cookie is off in the code.                                                                   |
| Consent in the EEA, UK, and CH | "a consent message from a Google-certified consent management platform"                 | Delete the section.                                                                 | Shots targets US customers only. The Cookie Policy keeps Google's rule for ads shown in the EEA and UK. |
| Legal Bases                    | Consent, legitimate interest, contract for three features                               | Replace with a purpose table and a California notice at collection.                 | US state laws need purposes, categories, sources, and recipients, not GDPR legal bases.                 |
| Data Retention                 | "kept while your workspace is active, then deleted after the displayed recovery period" | Replace with a retention table. Mark gaps with ⚑.                                   | Each data type needs its own period. Some rows depend on P2, P3, and P12.                               |
| Your Rights                    | General list and one email                                                              | Add CCPA/CPRA and other US state rights, verification, agents, and appeals.         | State laws need specific rights, response times, and an appeal process.                                 |
| Your Choices                   | "Importing images from your device never leaves the browser."                           | Delete.                                                                             | Same reason as above.                                                                                   |
| Children                       | "under 13 (or under 16 in the EEA and UK)"                                              | Use `[[MINIMUM AGE]]`. State that Shots is for business use. Keep the COPPA rule.   | Paid workspaces are a business service.                                                                 |
| Open Source                    | "Shots is open source under the Apache 2.0 license"                                     | Move to the Terms. Counsel confirms the license statement.                          | A license notice belongs in the Terms. See Terms section 15.                                            |
| Changes                        | "Changes are reflected on this page with an updated date."                              | Add notice by email or in the product for material changes.                         | Users must learn about material changes before they take effect (P6).                                   |
| Contact                        | `team@playbookmedia.io`                                                                 | Name Playbook Interactive Media, LLC. Use `[[PRIVACY EMAIL]]` and `[[ADDRESS]]`.                  | A privacy policy must say who runs the service and how to reach it.                                     |
| (new)                          | —                                                                                       | Add AI processing, social platforms, data location, and the service provider role.  | These activities exist in the code and need disclosure.                                                 |

---

## Proposed text

**Privacy Policy**

Version `[[VERSION]]`. Effective `[[EFFECTIVE DATE]]`.

### 1. Who we are

Playbook Interactive Media, LLC, a Delaware limited liability company ("we", "us"), operates Shots at
`shots.playbookmedia.io`. Our address is `[[ADDRESS]]`. Privacy contact: `[[PRIVACY EMAIL]]`.

Shots is offered to businesses in the United States.

### 2. Our two roles

1. **Business.** We decide how to use the data in sections 3.1, 3.4, 3.6, 3.7, and 3.9. This policy
   covers that data.
2. **Service provider.** A workspace puts content into Shots: files, designs, releases, posts, brand
   data, audience email lists, and AI conversations. The customer that owns the workspace controls
   that content. We process it only to provide Shots to that customer, under our
   [Data Processing Addendum](data-processing-addendum.md). Send requests about that content to the
   workspace owner. If you send them to us, we forward them to the owner.

### 3. What we collect

#### 3.1 Account and sign-in data

- Your name, email address, and profile image.
- A one-way hash of your password, if you use a password.
- Your email verification status.
- Your two-factor secret and backup codes, if you turn on two-factor sign-in.
- Session records: a session token, your IP address, your browser user agent, and the expiry time.
- If you sign in with Google, GitHub, or Microsoft: your account ID at that provider, and the tokens
  that the provider returns.
- For enterprise workspaces: the SSO configuration and SCIM provisioning records that your company
  sets up.

#### 3.2 Workspace content (we are a service provider)

- The workspace name, address slug, logo, settings, members, roles, and invitations. An invitation
  holds the invitee's email address.
- Files and screenshots that you upload, and the images that the editor saves in cloud projects.
- Projects, saved versions, designs, brand kits, product profiles, releases, campaigns, drafts,
  posts, approvals, comments, and share links.
- AI conversations: your prompts and the AI's answers.

#### 3.3 Connected accounts

- **Social accounts (X, Instagram, LinkedIn).** We store the account ID, display name, username,
  profile picture, and the access and refresh tokens that the network gives us. We store the
  network's receipt for each post that we publish. See section 7.
- **GitHub App.** We store the installation, the repositories that you choose, and their releases.
- **Slack, Notion, and Figma.** We store the connection and an encrypted copy of its credentials.
- **App Store Connect and Google Play.** We store an encrypted copy of the credentials that you give
  us to upload store screenshots.

#### 3.4 Billing data

Stripe processes your payment card and calculates sales tax. We do not receive or store the full
card number. We store your plan, subscription status, Stripe customer and subscription IDs, and
credit purchases.

#### 3.5 Audience email lists (we are a service provider)

A workspace can add email addresses to send release announcements. We store each address, its
unsubscribe status, its suppression status, and each delivery attempt. Each announcement email has
an unsubscribe link.

#### 3.6 Device, log, and security data

- IP addresses and browser user agents, in session records and in hosting logs.
- Request IDs that connect a request to its logs.
- Audit records of actions in a workspace. An audit record stores a keyed hash of your IP address,
  not the raw address.
- Rate-limit records. These hold a one-way hash of your client address for up to one minute.

#### 3.7 Analytics and advertising data

- **PostHog** records page views, clicks, and product events with a pseudonymous ID. It does not
  receive your name or email address from us.
- **Google AdSense** shows ads on public content pages, such as guides and tool pages. It does not
  show ads in the editor or the workspace. See section 12.

#### 3.8 Websites that you ask us to read

- **URL capture and link previews.** We send the address to Microlink, which loads the page and
  returns an image or page data. We keep a cached capture for up to two days.
- **Product profile.** When you give us your product's address, we read its home page, its sitemap,
  and up to four other public pages. An AI model turns that text into a product profile. Those
  pages can contain personal data, for example names on a team page.
- **Tweet import.** We send the post ID to X's public syndication service.

#### 3.9 Messages to us

When you email us, we keep the message and your contact details to answer you.

### 4. What stays in your browser

These tools run in your browser tab and do not upload your file: compress, convert, resize, crop,
rotate, background removal, video compression, and the redaction scan.

The editor also keeps data in your browser storage:

- an in-progress draft, deleted after 7 days;
- imported images under 500 KB;
- preferences, presets, and recent exports.

Some tools download code or models from third parties the first time that you use them. Those
providers receive your IP address but not your file: Hugging Face (background removal), unpkg
(video encoding), and jsDelivr (redaction scan). ⚑ Requires product change P14, or keep this
disclosure.

These actions send data to us or to a provider:

- opening or saving a cloud project, which uploads its images;
- any AI feature, which can send a snapshot of the canvas (section 6);
- export compression, which sends the finished image to our server and does not store it;
- URL capture, link preview, and tweet import (section 3.8).

### 5. How we use data

| Purpose                                           | Data          |
| ------------------------------------------------- | ------------- |
| Create and secure your account                    | 3.1, 3.6      |
| Provide the workspace and its features            | 3.1–3.3       |
| Take payment, calculate tax, and manage the plan  | 3.4           |
| Keep tax and accounting records                   | 3.4           |
| Send account, security, and billing email         | 3.1           |
| Prevent abuse, keep audit records, and fix faults | 3.6           |
| Measure and improve product use                   | 3.7 (PostHog) |
| Show ads on public pages                          | 3.7 (AdSense) |
| Answer your messages                              | 3.9           |
| Provide Shots to the workspace that owns the data | 3.2, 3.5      |

We do not use your data for automated decisions that have legal or similar effects on you. We do
not create profiles that infer your traits or preferences.

### 6. AI processing

1. **Providers.** AI features send requests to OpenRouter. OpenRouter routes each request to a model
   provider. Today the default models come from Anthropic (Claude) and Google (Gemini, for images).
2. **What we send.** Your prompt, the workspace context that the feature needs (for example brand
   data, product profile, and release notes), text from websites that you ask us to read, and
   snapshots of the canvas or of draft visuals.
3. **What we keep.** We keep AI conversations and step summaries in your workspace until the
   workspace is deleted. ⚑ Requires product change P12 if counsel wants a shorter limit.
4. **Training.** We do not use your content to train AI models. `[[COUNSEL: confirm the OpenRouter, Anthropic, and Google terms on training and retention, and state them here.]]` ⚑ Requires
   product change P11.
5. **Control.** A workspace owner or admin can turn off AI features in the workspace settings.
6. **Human review.** AI never approves or publishes a post. A teammate with the approve permission
   must approve each post before Shots can publish it.

### 7. Social platforms

1. **What we do.** When you connect a social account, you let Shots publish approved posts to it.
2. **What we access.**
   - X: the permissions that X grants our app to read your profile and post for you.
   - Instagram (with Facebook Login): your Instagram business account, the Facebook Pages that it
     uses, publishing, comments, and insights.
   - Instagram (direct login): your Instagram business account, publishing, comments, and insights.
   - LinkedIn: your basic profile and permission to post for you.
3. **How to stop it.** Remove Shots in the network's app settings. ⚑ Requires product change P8 for
   a disconnect button that deletes the stored tokens.
4. **Meta.** To ask us to delete data that we received through Facebook Login, email
   `[[PRIVACY EMAIL]]`. ⚑ Requires product change P8 for the data deletion URL that Meta requires.
5. **Google.** If you sign in with Google, our use of information from Google APIs follows the
   [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
   including the Limited Use requirements.
6. **Other networks.** Shots does not offer YouTube, TikTok, Pinterest, Reddit, or other networks
   today. We will update this section before we add one.

### 8. Who receives data

1. **Service providers.** They process data for us under contract. See the
   [subprocessor list](subprocessors.md).
2. **Recipients that you choose.** When you connect or publish to a service, we send it the content
   that you choose: social networks, Slack, Notion, Figma, App Store Connect, Google Play, and your
   audit log destination.
3. **Your workspace.** Members of your workspace see workspace content, based on their role.
4. **Advertising partners.** Google and its partners receive identifiers and browsing data on public
   content pages. See section 12.
5. **Legal reasons.** We share data when the law requires it, or to protect people, our users, or
   our service.
6. **A business transfer.** A buyer or successor can receive data if we sell or merge the business.

### 9. Where we process data

We process data in the United States. Our application runs in DigitalOcean's New York region. Our
workflow service runs in AWS US East (Temporal Cloud). PostHog receives analytics in its US region.
Other providers process data in these regions: `[[REGION: PlanetScale]]`, `[[REGION: Upstash]]`,
`[[REGION: Cloudflare R2]]`, `[[REGION: Resend]]`, `[[REGION: OpenRouter and model providers]]`,
`[[REGION: Stripe]]`.

If you use Shots from outside the United States, you understand that we process your data in the
United States.

### 10. How long we keep data

| Data                                  | How long                                                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Account data                          | Until you delete your account. ⚑ Requires product change P3.                                                          |
| Sessions                              | Until the session expires or you sign out. `[[CONFIRM: session lifetime]]`                                            |
| Workspace content                     | While the workspace exists. After an owner deletes it, we wait 14 days, then delete it. ⚑ Requires product change P2. |
| Workspace content after the plan ends | `[[RETENTION PERIOD FOR INACTIVE WORKSPACES]]`. ⚑ Requires product change P12.                                        |
| Audit records                         | 90 days, or the period that an Enterprise workspace sets. A legal hold keeps them longer.                             |
| Database backups                      | Point-in-time recovery for `[[CONFIRM: 2 days]]`, and pre-deploy backups for 14 days.                                 |
| Workflow history                      | 7 days.                                                                                                               |
| Cached URL captures                   | Up to 2 days.                                                                                                         |
| Rate-limit records                    | Up to 1 minute.                                                                                                       |
| Browser drafts                        | 7 days, in your browser.                                                                                              |
| Billing and tax records               | `[[PERIOD THAT TAX LAW REQUIRES]]`.                                                                                   |
| Analytics and ad data                 | The period that each provider sets. `[[CONFIRM: PostHog retention setting]]`                                          |
| Hosting logs                          | `[[CONFIRM: log retention]]`.                                                                                         |
| Email to us                           | `[[PERIOD]]`.                                                                                                         |

### 11. Your rights

1. **California.** You have the right to know what we collect and why, to get a copy, to correct it,
   and to delete it. You have the right to opt out of the sale or sharing of personal information.
   We do not discriminate against you when you use these rights.
2. **Other US states.** If your state has a consumer privacy law, you can ask us to confirm that we
   process your data, and to access, correct, delete, or export it. You can opt out of targeted
   advertising, sale, and profiling.
3. **How to ask.** Email `[[PRIVACY EMAIL]]`. ⚑ Requires product changes P3 and P4 for self-serve
   deletion and export.
4. **Verification.** We check your identity before we act. We usually ask you to confirm from the
   email address on your account.
5. **Authorized agents.** An agent can ask for you with your signed permission. We can still ask
   you to confirm your identity.
6. **Time.** We answer within 45 days. If we need more time, we tell you why, and we answer within
   the extra time that the law allows.
7. **Appeal.** If we refuse a request, you can appeal to `[[PRIVACY EMAIL]]` with the subject
   "Appeal". We answer the appeal within the time that your state law sets. If we refuse the
   appeal, you can contact your state attorney general.

### 12. Advertising, "sale", and "sharing"

1. Google AdSense shows ads on public content pages. Google and its partners can use cookies to
   show ads based on your visits to this site and other sites.
2. California law calls this "sharing" for cross-context behavioral advertising. Other state laws
   call it "targeted advertising". We do not sell personal information for money.
3. To opt out, use the **Your Privacy Choices** link in the footer. We also treat a Global Privacy
   Control signal from your browser as an opt-out. ⚑ Requires product change P1.
4. We do not knowingly sell or share the personal information of consumers under 16.
5. You can also use [Google Ads Settings](https://www.google.com/settings/ads) or
   [My Ad Center](https://myadcenter.google.com).

### 13. California notice at collection

This table covers the last 12 months. Section 10 gives the retention period for each type of data.

| Category                       | Examples                                               | Sources                               | Disclosed to (business purpose)             | Sold or shared           |
| ------------------------------ | ------------------------------------------------------ | ------------------------------------- | ------------------------------------------- | ------------------------ |
| Identifiers                    | Name, email, account IDs, IP address, pseudonymous IDs | You, your company, sign-in providers  | Hosting, email, analytics, and AI providers | Shared with Google (ads) |
| Customer records               | Name, email, billing contact                           | You                                   | Stripe, hosting                             | No                       |
| Commercial information         | Plan, purchases, credit packs                          | You, Stripe                           | Stripe, hosting                             | No                       |
| Internet or network activity   | Pages visited, clicks, product events, logs            | Your device                           | PostHog, hosting                            | Shared with Google (ads) |
| Audio, visual, or similar      | Images and screenshots that you upload or create       | You                                   | Storage, rendering, and AI providers        | No                       |
| Professional information       | Your workspace, role, and company                      | You, your company's identity provider | Hosting                                     | No                       |
| Sensitive personal information | Account login (email and password)                     | You                                   | Hosting                                     | No                       |

We use sensitive personal information only to provide the service and keep it secure. We do not use
it for purposes that create a right to limit its use.

### 14. Children

Shots is a business service. You must be at least `[[MINIMUM AGE]]` to create an account. Shots is
not directed at children under 13, and we do not knowingly collect their data. If we learn that we
did, we delete it.

### 15. Security

We use technical and organizational measures to protect data. Examples:

- two-factor sign-in, SSO, and SCIM for enterprise workspaces;
- hashed API keys and hashed SCIM tokens;
- encrypted credentials for audit destinations, Slack, Notion, Figma, and app stores;
- private file storage with signed links that expire after two minutes;
- an audit log that the application can add to but cannot change.

See the [Security page](security-page.md). No system is fully secure.

### 16. Changes to this policy

We tell you about material changes by email or in the product at least `[[NOTICE PERIOD]]` days
before they take effect. We keep earlier versions at `[[ARCHIVE URL]]`. ⚑ Requires product change
P6.

### 17. Contact

Playbook Interactive Media, LLC, `[[ADDRESS]]`. Email `[[PRIVACY EMAIL]]`.
