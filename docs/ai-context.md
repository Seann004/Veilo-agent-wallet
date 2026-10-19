# Context for AI tools

Use these plain-text files when asking an AI assistant to explain Veilo, plan an integration or reason about its technical boundaries.

| File | Contents |
|---|---|
| [llms.txt](/llms.txt) | Product summary, important boundaries and links to technical pages |
| [llms-full.txt](/llms-full.txt) | Complete product documentation and diagram definitions in one file |
| `llms.text` | An alias of the concise context file |

Copy the text into your assistant, or give it the published file URL if it can read websites. These files contain public product context, not wallet secrets, credentials or private activity.

## Important context

- Veilo combines a personal agent workspace, private on-chain payments and a specialist marketplace.
- Supabase holds marketplace identity and product data; local control/wallet services retain spending authority and note secrets.
- Models propose work. Independent services enforce grants, budgets, signing and revocation.
- Current marketplace fees are zero. Subscriptions and proposed commission pricing are not implemented.
- Privacy targets the explicit spent-deposit link. Amounts, fresh wallets, merchants and timing remain public.
- [Current status](./guide/status.md) separates implemented capabilities from dated verification. [Evidence](./evidence.md) contains public receipts and submission files.

The context files are regenerated from the technical pages whenever the documentation is built.
