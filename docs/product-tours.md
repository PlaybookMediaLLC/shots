# Product tours

Product tours show people how the app works, one step at a time. Each step
points at one element on the page and explains it. The tours are linked, so
one tour can offer the next one. Together they make one guided journey
through the product.

The framework follows the guided tour in the Canvas web app
(oppulence-canvas). It needs no tour library.

## What people see

- **The first visit.** The workspace tour starts by itself the first time a
  person opens a page with the sidebar. It does not start on a phone, in an
  editor, or over an open dialog.
- **The step card.** A card opens beside the element that the step explains,
  and the element gets an outline. The card shows the step number and a
  progress bar. It has Back, Next or Finish, and Skip.
- **The keyboard.** When focus is in the card, the Right and Left arrow keys
  move between steps. Escape skips the tour, but not while the person types
  in a field.
- **The journey.** On the last step, a tour can offer the next tour. Start
  opens it, and opens its page when it is on another one.
- **The Product tours menu.** The signpost button in the sidebar footer lists
  every tour that the workspace has. It shows which tours the person saw, and
  it starts or replays any of them.
- **Buttons in a feature.** A feature can show its own tour button. The
  Publish pane has one.

## How it works

| Part | File |
| --- | --- |
| The tours, their schemas and the rules | `clients/apps/web/lib/platform/product-tour.ts` |
| The step card, the menu and the tour button | `clients/apps/web/components/platform-shell/ProductTour.tsx` |
| The outline of the current element | `clients/apps/web/components/platform-shell/platform-shell.css` |
| The tests | `clients/apps/web/test/product-tour.test.ts` |

- Zod schemas define every type: `productTourSchema`,
  `productTourStepSchema`, `productTourSessionSchema` and
  `platformAccessSchema`.
- A step finds its element by the `data-tour-id` attribute. It finds the
  element again when the page replaces or hides it, for example when the
  sidebar collapses. When the element is not on the page after 3 seconds, the
  card explains the step without it.
- A tour that a person finishes or skips is saved as the help tip
  `tour-<id>-v<version>` in their preferences. It does not start by itself
  again on any device. **Reset help tips** in Account settings brings it back.
  When the save fails, the person sees an error message.
- The current step is kept for the browser tab, so a tour continues when it
  opens the page of its next step. Before it opens a page, it runs the same
  save guards as a sidebar link (`prepareLinkNavigation`).
- A step `route` covers its page and the pages under it: `/write` also covers
  an open draft at `/write/<id>`. When the person opens a page outside the
  route, the tour ends. It is not marked as seen. A tour whose steps have no
  `route`, such as the workspace tour, continues on every page, because its
  elements are in the sidebar.
- End-to-end tests turn off the first-visit tour for every spec. A spec about
  the tour sets `test.use({ productTour: true })`.
- `available` uses the same plan and rollout flags as the sidebar
  (`PlatformAccess` and `areaLocked` in `lib/platform/navigation.ts`). The
  menu does not offer a tour for a feature that the workspace does not have.

## Add a tour for a new feature

1. Mark each element that a step explains:

   ```tsx
   <div data-tour-id="campaign-brief">…</div>
   ```

   Use lowercase words joined by hyphens. Sidebar rows are already marked
   `nav-<area>`, for example `nav-library`.

2. Add the tour to `PRODUCT_TOURS` in `lib/platform/product-tour.ts`:

   ```ts
   {
     id: 'campaigns',
     title: 'Plan a campaign',
     summary: 'Briefs, releases and approvals.',
     version: 1,
     available: (access) => access.campaignsEnabled && !areaLocked('campaigns', access),
     steps: [
       {
         id: 'brief',
         anchor: 'campaign-brief',
         route: '/campaigns',
         title: 'Start from a brief',
         description: 'Describe the release once. Shots drafts each asset from it.',
       },
     ],
   },
   ```

   - Set `route` when the step is on a page other than the current one.
   - Set `next` on an earlier tour to link this tour into the journey.
   - Set `autoStart` only for a tour that every new person must see.

3. Optional: add a button in the feature:

   ```tsx
   <ProductTourButton label="Take the Campaigns tour" tourId="campaigns" />
   ```

4. Run `npm test` in `clients/`. The tests fail when a tour does not match
   its schema, when a step's element is not marked, or when `next` names an
   unknown tour.

## Change a tour

- Change the text freely.
- Raise `version` when the steps change so much that people must see the
  tour again. People who saw the old version then see the new one once.
- Keep each description to one or two short sentences. Describe what the
  person can do, not how the code works.
