# Reference-guided TikTok publishing

The designed-slide workflow accepts **Topic**, **Visual style** and **Number of slides**. A reference image attached to an agent task is described by the owner's configured vision model. Only the bounded style description reaches the workflow; the original image is not sent to the seller.

The planner maps the description into supported colors, font category, alignment, corner shapes and headline case. The renderer applies those settings consistently while preserving slide text and repository cards. This guides the design from the reference; it does not reproduce the image exactly. Use `default` for the original charcoal design.

If a requested style has no design settings in the plan, the rendering step refuses rather than silently ignoring it. Arbitrary CSS, HTML, fonts, scripts and network URLs cannot be used as design settings.

## Review and enable the new version

From the repository root, inspect the targeted plan:

```sh
pnpm marketplace:carousel-style
```

With the updated marketplace and seller host running, submit only the two changed tool versions:

```sh
pnpm marketplace:carousel-style --submit
pnpm marketplace:operator queue
```

Review each returned listing version, using its actual ID:

```sh
pnpm marketplace:operator review <LISTING_VERSION_ID> approve "Reviewed reference-style inputs and bounded renderer"
```

Then prepare the new public-publishing workflow version:

```sh
pnpm marketplace:carousel-style --workflow
pnpm marketplace:operator workflow-queue
```

If the returned workflow is pending, review its actual version ID with `pnpm marketplace:operator workflow-review <WORKFLOW_VERSION_ID> approve "Reviewed reference style and public publishing terms"`. A version that already passed publication checks can be live immediately; catalogue publication is not approval of a paid run.

These commands update catalogue versions; they do not start a paid run or post to TikTok. The renderer manifest changed, so old designer listings need the new reviewed version. Existing workflow assignments stay pinned: add the new version to the agent and remove the old assignment to avoid selecting it accidentally. Do not rerun the full seed for this update.

## Run from the website

1. Marketplace → **TikTok carousel (designed, posts publicly)** → **Add to an agent**. Choose **Ask me before each run**.
2. Open the agent, attach the reference image, and request the carousel. Confirm the configured model can read the image.
3. Open **Review and approve**. Check topic, reference-style description, slide count, total, public-publishing effect and destination account.
4. **Approve and run → Confirm approval** authorizes this run. The seller host must have public publishing enabled separately.
5. Inspect each step's output and receipt. Open the actual TikTok post before describing it as published; accepted, scheduled and uncertain states are not confirmed publication.

The public workflow has no intermediate image-editing or draft-review stop. Edit the brief before approval, or choose the draft workflow for human review before publishing. Model/provider charges are separate from devnet settlement. Fresh live reference-style publishing evidence is still required; automated tests and local rendering do not establish TikTok delivery.
