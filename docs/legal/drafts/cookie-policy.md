# Cookie Policy and privacy choices (draft)

> **DRAFT — requires counsel review.** Not legal advice. Do not publish. Shots has no cookie policy
> and no privacy choices control in code today. Code baseline: commit `bad06b3e`.

## Summary

- Shots targets US customers only (owner decision, 2026-10-17). US law uses an opt-out model, not
  an opt-in banner.
- Shots uses a few necessary cookies for sign-in, and browser storage for the editor.
- Google AdSense on public content pages counts as "sharing" or "targeted advertising" under US
  state laws. Visitors need a way to opt out, and the site must honor Global Privacy Control.
- Product change P1 adds these controls. Do not publish this policy before P1 ships.
- The `NEXT_LOCALE` cookie in the live Privacy Policy is not in this list. The code does not set it.

## Privacy choices requirements (product change P1)

1. Add a **Your Privacy Choices** link to every footer. The link opens a panel where a visitor can
   opt out of "sale", "sharing", and targeted advertising.
2. When a visitor opts out, or the browser sends a Global Privacy Control signal, show only
   non-personalized ads, or no ads. Do not load personalized ad cookies.
3. Keep the choice for the browser, and for the account when the visitor is signed in.
4. PostHog: if the PostHog contract makes PostHog a service provider, analytics is not a "sale".
   `[[COUNSEL: confirm, and decide whether the opt-out also turns off PostHog]]`
5. Visitors from the EEA, the UK, and Switzerland: Google requires a Google-certified consent
   platform for ads shown to them. Turn on Google's consent message for those regions in the
   AdSense console, or do not show ads there. `[[OWNER: choose]]`
6. Record each opt-out with its time and source (link or signal).

---

## Proposed text

**Cookie Policy**

Version `[[VERSION]]`. Effective `[[EFFECTIVE DATE]]`.

### 1. What this policy covers

This policy explains the cookies and browser storage that Playbook Interactive Media, LLC uses on Shots at
`shots.playbookmedia.io`. The [Privacy Policy](privacy-policy.md) explains how we use the data.

### 2. Your choices

- Use the **Your Privacy Choices** link in the footer to opt out of the sharing of your data for
  targeted advertising. We also treat a Global Privacy Control signal as an opt-out.
- You can block or delete cookies in your browser. If you block necessary cookies, you cannot sign
  in.

### 3. Necessary cookies

These cookies make sign-in and security work.

| Name                                             | Purpose                                     | Lifetime                        | Party |
| ------------------------------------------------ | ------------------------------------------- | ------------------------------- | ----- |
| `[[CONFIRM: better-auth session cookie]]`        | Keeps you signed in                         | `[[CONFIRM: session lifetime]]` | First |
| `[[CONFIRM: better-auth two-factor cookie]]`     | Holds a two-factor challenge during sign-in | `[[CONFIRM: minutes]]`          | First |
| `[[CONFIRM: better-auth trusted-device cookie]]` | Skips two-factor on a device that you trust | 30 days                         | First |

### 4. Functional cookies

| Name                 | Purpose                                                            | Lifetime | Party |
| -------------------- | ------------------------------------------------------------------ | -------- | ----- |
| `shots-store-active` | Reopens your App Store screenshot project. Holds the value 1 only. | 1 year   | First |

### 5. Analytics cookies

| Name                       | Provider | Purpose                                     | Lifetime             | Party                  |
| -------------------------- | -------- | ------------------------------------------- | -------------------- | ---------------------- |
| `ph_<project key>_posthog` | PostHog  | A pseudonymous ID for page views and events | 1 year `[[CONFIRM]]` | First (set by PostHog) |

PostHog also keeps the same ID in local storage.

### 6. Advertising cookies (you can opt out)

Google AdSense runs on public content pages only. It does not run in the editor or the workspace.

| Name                                        | Provider | Purpose                                        | Lifetime                      | Party                 |
| ------------------------------------------- | -------- | ---------------------------------------------- | ----------------------------- | --------------------- |
| `__gads`, `__gpi`, `__eoi`                  | Google   | Ad delivery, frequency limits, and measurement | Up to 13 months `[[CONFIRM]]` | First (set by Google) |
| `IDE`, `DSID`, and others on Google domains | Google   | Ad personalization and measurement             | Up to 13 months `[[CONFIRM]]` | Third                 |

See [how Google uses cookies in advertising](https://policies.google.com/technologies/ads).

### 7. Browser storage

The editor stores your work in your browser. This data stays on your device. Clear your site data to
remove it.

| Storage         | What it holds                                                                                           | How long                |
| --------------- | ------------------------------------------------------------------------------------------------------- | ----------------------- |
| IndexedDB       | Editor drafts                                                                                           | 7 days                  |
| IndexedDB       | App Store screenshot projects                                                                           | Until you delete them   |
| Local storage   | Imported images under 500 KB, export settings, presets, recent link previews, and small interface flags | Until you clear them    |
| Local storage   | The name that a store review guest enters                                                               | Until you clear it      |
| Session storage | The previous page, for the back button                                                                  | Until you close the tab |

### 8. Changes

We update this policy when we add or remove a cookie. We show the date at the top.
